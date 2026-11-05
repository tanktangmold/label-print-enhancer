// 「编辑 PDF」视图：左边页面缩略图（排序/旋转/复制/删除/追加），中间在页面上加文字、盖白、马赛克、图片，下方属性栏，可撤销。
// 编辑对象坐标单位 pt，相对「编辑视图里的页面」左上角（含 PDF 自带和单页旋转；排版设置里的旋转在出图时再转，见 overlays.js）。
// 「每页同位置」的盖白/马赛克存在设置的 overlays 里（跟着打印方案保存）。
import { t, getLang } from '../core/i18n.js';
import {
  addObject, updateObject, removeObject, copyEdits, hitTest, normalizeObject, normalizeOverlays, turnPageEdits, MAX_GLOBAL_OVERLAYS,
} from '../core/edits.js';
import { movePage, removePage, duplicatePage, rotatePage, keepEditsFor } from '../core/pages.js';
import { createHistory } from '../core/history.js';
import { clampRect, ptToMm } from '../core/visual.js';
import { createBoxEditor } from './box-editor.js';
import { createPagesPanel } from './edit-pages.js';
import { renderProps } from './edit-props.js';
import { renderRegion, sourceSize, releaseCanvas, isCancelled } from './render.js';
import { drawOverlays } from './overlays.js';
import { addImage } from './images.js';

const $ = (id) => document.getElementById(id);
const DRAW_TOOLS = ['text', 'whiteout', 'mosaic'];
const MIN_DRAW_PT = 6;
const DEFAULT_SIZE = Object.freeze({ text: { w: 160, h: 28 }, whiteout: { w: 80, h: 24 }, mosaic: { w: 80, h: 24 } });
const THUMBS_DELAY = 250; // 连续编辑（打字）时缩略图晚一点再重画
const GEOMETRY = ['x', 'y', 'w', 'h'];
const fmt = (pt) => (Math.round(ptToMm(pt) * 10) / 10).toFixed(1);
let idSeq = 0;
const newId = (prefix = 'o') => `${prefix}${Date.now().toString(36)}${++idSeq}`;

/** 编辑视图按「不含排版旋转」显示页面（排版旋转只影响排到纸上的方向）。 */
const editSettings = (settings) => (settings.rotate ? { ...settings, rotate: 0 } : settings);

/** 编辑快捷键：撤销 / 重做 / 删除 / 取消选中（焦点在输入框里时不管）。 */
function bindKeys({ isActive, undo, redo, remove, escape }) {
  document.addEventListener('keydown', (e) => {
    if (!isActive() || e.target.closest('input, select, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && (k === 'z' || k === 'y')) {
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo();
      else undo();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && remove()) {
      e.preventDefault();
    } else if (e.key === 'Escape') {
      escape();
    }
  });
}

/**
 * @param {object} deps
 * @param {() => object} deps.getState  { doc, edits, page, settings, ref, objectsFor(ref) }
 * @param {(snap: {pages, edits, overlays}) => void} deps.apply  应用页面/编辑/每页同位置对象的改动
 * @param {(page: number) => void} deps.goPage
 * @param {(files: File[]) => void} deps.onAppend
 * @param {() => void} deps.onWatermark
 * @param {(kind: string, text: string) => void} deps.notify
 */
export function createEditView({ getState, apply, goPage, onAppend, onWatermark, notify }) {
  const view = $('editView');
  const pageEl = $('editPage');
  const canvas = $('editCanvas');
  const props = $('editProps');
  const history = createHistory(50);
  let active = false;
  let tool = 'select';
  let selectedId = null;
  let justCreated = null; // 刚画出来的文字框：属性栏打开时把输入框选中，直接打字替换
  let editor = null;
  let editorKey = '';
  let base = null; // 当前页底图（无编辑对象）
  let baseKey = '';
  let size = { w: 1, h: 1 }; // 当前页尺寸 pt
  let live = null; // 拖动中的临时位置 { id, rect }
  let pending = null; // 连续输入（打字、拖滑块）开始前的快照，结束时记成一步撤销
  let propsKey = ''; // 属性栏当前显示的内容；没变就不重建（打字时重建会丢焦点）
  let thumbsTimer = 0;
  let seq = 0;
  let abort = new AbortController();

  const pages = createPagesPanel({
    getState: () => ({ ...getState(), settings: editSettings(getState().settings) }),
    onSelect: (index) => goPage(index + 1),
    onPageOp: (op, index, to) => pageOp(op, index, to).catch((err) => !isCancelled(err) && notify('error', err?.message ?? String(err))),
    onAppend,
  });

  // ---------- 状态 / 撤销 ----------

  const snapshot = () => {
    const { doc, edits, settings } = getState();
    return Object.freeze({ pages: doc.pages, edits, overlays: settings.overlays });
  };

  /** 把还没结束的连续输入记成一步（选别的、点页面、撤销之前都要先结算，否则这一步会混进下一次撤销）。 */
  function settle() {
    if (!pending) return;
    history.push(pending);
    pending = null;
  }

  function commit(next) {
    settle();
    history.push(snapshot());
    apply(next);
    syncTools();
  }

  const currentId = () => getState().ref?.id;

  /** 页面顺序变了以后，继续显示原来那一页。 */
  function follow(id) {
    const i = getState().doc.pages.findIndex((p) => p.id === id);
    if (i >= 0) goPage(i + 1);
  }

  function restore(snap) {
    const id = currentId();
    apply(snap);
    follow(id);
    syncTools();
  }

  function undo() {
    settle();
    const prev = history.undo(snapshot());
    if (prev) restore(prev);
  }

  function redo() {
    settle();
    const next = history.redo(snapshot());
    if (next) restore(next);
  }

  const currentObjects = () => {
    const { ref, objectsFor } = getState();
    return ref ? objectsFor(ref) : [];
  };
  const isGlobal = (id) => getState().settings.overlays.some((o) => o.id === id);
  const selected = () => currentObjects().find((o) => o.id === selectedId) ?? null;

  /** 改一个对象（这一页的，或每页同位置的）。 */
  function updated(id, patch) {
    const { edits, ref, settings } = getState();
    if (isGlobal(id)) {
      const overlays = normalizeOverlays(settings.overlays.map((o) => (o.id === id ? normalizeObject({ ...o, ...patch, id, type: o.type }) ?? o : o)));
      return { overlays };
    }
    return { edits: updateObject(edits, ref.id, id, patch) };
  }

  // ---------- 画面 ----------

  function draw() {
    if (!base) return;
    canvas.width = base.width;
    canvas.height = base.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(base, 0, 0);
    const objects = currentObjects().map((o) => (live && o.id === live.id ? { ...o, ...live.rect } : o));
    drawOverlays(ctx, objects, { scale: base.width / size.w });
  }

  async function ensureBase(token) {
    const { doc, ref, settings } = getState();
    const shown = editSettings(settings);
    size = await sourceSize(doc, ref, shown);
    const width = Math.min(1600, Math.round(Math.max(600, pageEl.parentElement.clientWidth) * (window.devicePixelRatio || 1)));
    const key = JSON.stringify([ref.id, ref.src, ref.pageNo, ref.rotate, width]);
    if (key === baseKey && base) return;
    const next = await renderRegion(doc, ref, shown, width, null, abort.signal, { objects: [], mono: false });
    if (token !== seq) return releaseCanvas(next);
    if (base) releaseCanvas(base);
    base = next;
    baseKey = key;
  }

  async function renderPage() {
    const token = ++seq;
    const { doc, ref } = getState();
    if (!doc || !ref) return;
    try {
      await ensureBase(token);
      if (token !== seq) return;
      pageEl.style.setProperty('--ratio', String(size.w / size.h));
      if (selectedId && !selected()) selectedId = null;
      draw();
      syncEditor();
      syncProps();
    } catch (err) {
      if (!isCancelled(err)) notify('error', t('error.render', { page: getState().page, err: err?.message ?? String(err) }));
    }
  }

  function scheduleThumbs(delay = THUMBS_DELAY) {
    clearTimeout(thumbsTimer);
    thumbsTimer = setTimeout(() => active && pages.render(), delay);
  }

  // ---------- 拖动框 ----------

  const units = () => size;
  const clampToPage = (b) => ({ box: clampRect(b, size.w, size.h) });
  const readout = (b) => t('select.readout', { x: fmt(b.x), y: fmt(b.y), w: fmt(b.w), h: fmt(b.h) });

  function boxEditor(opts) {
    return createBoxEditor({ host: pageEl, units, constrain: clampToPage, readout, ...opts });
  }

  /** 画框工具 → 空白处拖出新对象；选择工具 → 选中对象的移动/缩放框。同一个对象只更新框，不重建（保留焦点，方向键能连续微移）。 */
  function syncEditor() {
    const drawing = DRAW_TOOLS.includes(tool);
    const obj = active && base && !drawing ? selected() : null;
    const key = !active || !base ? '' : drawing ? `draw:${tool}` : obj ? `sel:${obj.id}` : '';
    if (key && key === editorKey && editor) {
      if (obj && !live) editor.set({ x: obj.x, y: obj.y, w: obj.w, h: obj.h });
      return;
    }
    editor?.destroy();
    editor = null;
    editorKey = key;
    if (!key) return;
    if (!obj) {
      editor = boxEditor({ box: null, aspectLock: false, allowDraw: true, label: t(`edit.tool.${tool}`), onChange: (b, { final }) => final && createFromRect(b) });
      return;
    }
    const id = obj.id;
    editor = boxEditor({
      box: { x: obj.x, y: obj.y, w: obj.w, h: obj.h },
      aspectLock: obj.type === 'image',
      allowDraw: false,
      label: t(`edit.tool.${obj.type}`),
      onChange: (b, { final }) => {
        live = { id, rect: b };
        draw();
        if (final) {
          live = null;
          commit(updated(id, b));
        }
      },
    });
  }

  function addToPage(obj) {
    const { edits, ref } = getState();
    tool = 'select';
    selectedId = obj.id;
    commit({ edits: addObject(edits, ref.id, obj) });
  }

  function createFromRect(b) {
    const small = b.w < MIN_DRAW_PT || b.h < MIN_DRAW_PT;
    const rect = clampRect(small ? { x: b.x, y: b.y, ...DEFAULT_SIZE[tool] } : b, size.w, size.h);
    const id = newId();
    if (tool === 'text') justCreated = id;
    addToPage({ id, type: tool, ...rect, text: t('edit.newText'), size: 10, color: '#000000', cover: true, block: 6 });
  }

  async function insertImage(file) {
    try {
      const img = await addImage(file);
      const w = Math.min(size.w * 0.4, img.w * 0.75);
      const h = (w * img.h) / img.w;
      addToPage({ id: newId(), type: 'image', imageId: img.id, x: (size.w - w) / 2, y: (size.h - h) / 2, w, h });
    } catch (err) {
      const key = err?.kind === 'image-type' ? 'edit.imageType' : err?.kind === 'image-size' ? 'edit.imageSize' : null;
      notify('error', key ? t(key) : t('edit.imageError', { err: err?.message ?? String(err) }));
    }
  }

  // ---------- 选中 / 属性 ----------

  function select(id) {
    if (id !== selectedId) settle();
    selectedId = id;
    syncEditor();
    syncProps();
  }

  function deleteSelected() {
    const obj = selected();
    if (!obj) return false;
    const { edits, ref, settings } = getState();
    selectedId = null;
    commit(isGlobal(obj.id) ? { overlays: settings.overlays.filter((o) => o.id !== obj.id) } : { edits: removeObject(edits, ref.id, obj.id) });
    return true;
  }

  function toggleGlobal(on) {
    const obj = selected();
    if (!obj) return;
    const { edits, ref, settings } = getState();
    if (on && !isGlobal(obj.id)) {
      if (settings.overlays.length >= MAX_GLOBAL_OVERLAYS) {
        notify('info', t('edit.tooManyGlobal', { n: MAX_GLOBAL_OVERLAYS }));
        propsKey = ''; // 把勾选框恢复成没勾
        syncProps();
        return;
      }
      commit({ edits: removeObject(edits, ref.id, obj.id), overlays: normalizeOverlays([...settings.overlays, obj]) });
    } else if (!on && isGlobal(obj.id)) {
      commit({ overlays: settings.overlays.filter((o) => o.id !== obj.id), edits: addObject(edits, ref.id, obj) });
    }
  }

  function onEdit(patch, { commit: done }) {
    const obj = selected();
    if (!obj) return;
    if (!pending) pending = snapshot();
    apply(updated(obj.id, patch));
    propsKey = propsKeyOf(); // 属性栏里已经是新值了
    if (done) settle();
    syncTools();
  }

  /** 属性栏只看类型相关的属性（位置大小变了不重建，免得拖完框把文字输入框抢走焦点）。 */
  function propsKeyOf() {
    const obj = selected();
    const shown = obj && Object.fromEntries(Object.entries(obj).filter(([k]) => !GEOMETRY.includes(k)));
    return JSON.stringify([getLang(), tool, shown, obj ? isGlobal(obj.id) : false]);
  }

  function syncProps() {
    if (!active) return;
    const key = propsKeyOf();
    if (key === propsKey) return;
    propsKey = key;
    const obj = selected();
    const focusText = !!obj && obj.id === justCreated;
    if (focusText) justCreated = null;
    renderProps(props, {
      tool,
      selected: obj,
      isGlobal: obj ? isGlobal(obj.id) : false,
      focusText,
      onEdit,
      onToggleGlobal: toggleGlobal,
      onDelete: deleteSelected,
    });
  }

  function syncTools() {
    view.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
      btn.setAttribute('aria-pressed', String(btn.dataset.tool === tool));
    });
    pageEl.classList.toggle('drawing', DRAW_TOOLS.includes(tool));
    $('btnUndo').disabled = !history.canUndo && !pending;
    $('btnRedo').disabled = !history.canRedo;
  }

  function setTool(next) {
    settle();
    if (next === 'image') return $('imageInput').click();
    if (next === 'watermark') return onWatermark();
    tool = next;
    if (tool !== 'select') selectedId = null;
    syncTools();
    syncEditor();
    syncProps();
  }

  // ---------- 页面操作 ----------

  async function rotateSnap(list, index, edits, settings) {
    const ref = list[index];
    const before = await sourceSize(getState().doc, ref, editSettings(settings)); // 转之前的尺寸
    return { pages: rotatePage(list, index, 90), edits: turnPageEdits(edits, ref.id, 90, before) };
  }

  async function pageOp(op, index, to) {
    settle();
    const { doc, edits, settings } = getState();
    const list = doc.pages;
    const id = currentId();
    if (op === 'delete') {
      if (list.length <= 1) return notify('info', t('edit.lastPage'));
      const pagesNext = removePage(list, index);
      commit({ pages: pagesNext, edits: keepEditsFor(edits, pagesNext) });
      if (list[index].id === id) goPage(Math.min(index + 1, pagesNext.length));
      else follow(id);
    } else if (op === 'move') {
      if (to < 0 || to >= list.length) return;
      commit({ pages: movePage(list, index, to) });
      follow(id);
    } else if (op === 'rotate') {
      const snap = await rotateSnap(list, index, edits, settings);
      if (getState().doc.pages !== list || getState().edits !== edits) return; // 期间又改过，这次作废
      commit(snap);
    } else if (op === 'duplicate') {
      const copyId = newId('p');
      commit({ pages: duplicatePage(list, index, copyId), edits: copyEdits(edits, list[index].id, copyId, newId) });
      goPage(index + 2);
    }
  }

  // ---------- 事件 ----------

  function toPt(ev) {
    const r = pageEl.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * size.w, y: ((ev.clientY - r.top) / r.height) * size.h };
  }

  // 选择工具下点页面：点中对象就选中并可以直接拖；点空白取消选中（先于拖动框的处理注册）
  pageEl.addEventListener('pointerdown', (ev) => {
    if (!active || tool !== 'select' || ev.button !== 0 || ev.target.closest('.edit-box')) return;
    const hit = hitTest(currentObjects(), toPt(ev));
    select(hit ? hit.id : null);
    if (hit) editor?.begin(ev);
  });

  view.querySelectorAll('[data-tool]').forEach((btn) => btn.addEventListener('click', () => setTool(btn.dataset.tool)));
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('imageInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) insertImage(file);
  });
  bindKeys({
    isActive: () => active,
    undo,
    redo,
    remove: deleteSelected,
    escape: () => {
      setTool('select');
      select(null);
    },
  });

  function stop() {
    seq++;
    abort.abort();
    abort = new AbortController();
    clearTimeout(thumbsTimer);
    pages.cancel();
    editor?.destroy();
    editor = null;
    editorKey = '';
    live = null;
    propsKey = '';
  }

  return {
    activate() {
      active = true;
      view.hidden = false;
      syncTools();
      renderPage();
      scheduleThumbs(0);
    },
    deactivate() {
      settle();
      active = false;
      view.hidden = true;
      stop();
    },
    /** 页面列表、编辑内容、设置变了：重画当前页，缩略图稍后重画。 */
    refresh() {
      if (!active) return;
      renderPage();
      scheduleThumbs();
      syncTools();
    },
    /** 追加文件前：记一次撤销点。 */
    pushHistory() {
      settle();
      history.push(snapshot());
      syncTools();
    },
    /** 选了别的打印方案 / 恢复默认：每页同位置对象被整体换掉，旧的撤销记录不再适用。 */
    clearHistory() {
      pending = null;
      history.clear();
      syncTools();
    },
    /** 换文件：清空撤销历史和缓存。 */
    reset() {
      stop();
      pending = null;
      history.clear();
      selectedId = null;
      justCreated = null;
      tool = 'select';
      if (base) releaseCanvas(base);
      base = null;
      baseKey = '';
      pages.clear();
      syncTools();
    },
    get selectedId() {
      return selectedId;
    },
  };
}
