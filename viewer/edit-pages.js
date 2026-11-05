// 「编辑 PDF」左侧的页面缩略图：点选、拖动排序、上下移、旋转、复制、删除、追加 PDF/图片。
import { t } from '../core/i18n.js';
import { renderRegion, releaseCanvas, isCancelled } from './render.js';

const $ = (id) => document.getElementById(id);
const THUMB_WIDTH = 220; // 缩略图渲染宽度（px，显示时缩小）
const DRAG_TYPE = 'application/x-lpe-page';

function iconButton(label, text, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumb-btn';
  btn.textContent = text;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/**
 * @param {object} deps
 * @param {() => object} deps.getState  { doc, edits, page, settings, objectsFor(ref) }
 * @param {(index: number) => void} deps.onSelect   选中第 index 页（0 起）
 * @param {(op: string, index: number, to?: number) => void} deps.onPageOp  move / rotate / duplicate / delete
 * @param {(files: File[]) => void} deps.onAppend
 */
export function createPagesPanel({ getState, onSelect, onPageOp, onAppend }) {
  const list = $('thumbList');
  const cache = new Map(); // 缓存键 → canvas
  let seq = 0;
  let abort = new AbortController();
  let dragFrom = -1;

  function keyOf(ref, objects) {
    return JSON.stringify([ref.id, ref.src, ref.pageNo, ref.rotate, objects]);
  }

  /** 停掉正在进行的缩略图渲染（离开编辑视图、换文件、重排列表时）。 */
  function cancel() {
    seq++;
    abort.abort();
    abort = new AbortController();
  }

  async function thumbCanvas(ref, token) {
    const { doc, settings, objectsFor } = getState();
    const objects = objectsFor(ref);
    const key = keyOf(ref, objects);
    if (cache.has(key)) return cache.get(key);
    const canvas = await renderRegion(doc, ref, settings, THUMB_WIDTH, null, abort.signal, { objects, mono: false });
    if (token !== seq) {
      releaseCanvas(canvas);
      return null;
    }
    cache.set(key, canvas);
    return canvas;
  }

  /** 只滚动缩略图列表本身，把当前页露出来（scrollIntoView 会连外层预览区一起滚，把顶部工具条滚走）。 */
  function reveal(item) {
    if (!item) return;
    const lr = list.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    if (ir.top < lr.top) list.scrollTop -= lr.top - ir.top + 4;
    else if (ir.bottom > lr.bottom) list.scrollTop += ir.bottom - lr.bottom + 4;
    if (ir.left < lr.left) list.scrollLeft -= lr.left - ir.left + 4;
    else if (ir.right > lr.right) list.scrollLeft += ir.right - lr.right + 4;
  }

  function pruneCache(liveKeys) {
    for (const [key, canvas] of cache) {
      if (!liveKeys.has(key)) {
        releaseCanvas(canvas);
        cache.delete(key);
      }
    }
  }

  function actionsFor(index, total) {
    const actions = document.createElement('div');
    actions.className = 'thumb-actions';
    actions.append(
      iconButton(t('edit.page.up'), '↑', () => onPageOp('move', index, index - 1)),
      iconButton(t('edit.page.down'), '↓', () => onPageOp('move', index, index + 1)),
      iconButton(t('edit.page.rotate'), '⟳', () => onPageOp('rotate', index)),
      iconButton(t('edit.page.duplicate'), '⧉', () => onPageOp('duplicate', index)),
      iconButton(t('edit.page.delete'), '✕', () => onPageOp('delete', index)),
    );
    actions.firstChild.disabled = index === 0;
    actions.children[1].disabled = index === total - 1;
    return actions;
  }

  /** 缩略图拖动排序（只认本列表里拖出来的页，拖文件进来交给页面级处理）。 */
  function bindDrag(item, index) {
    item.addEventListener('dragstart', (e) => {
      dragFrom = index;
      e.dataTransfer.setData(DRAG_TYPE, String(index));
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.stopPropagation();
      item.classList.add('drop-target');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.stopPropagation(); // 不让页面级的「拖入文件」处理接管
      item.classList.remove('drop-target');
      const from = dragFrom;
      dragFrom = -1;
      if (from !== index) onPageOp('move', from, index);
    });
    item.addEventListener('dragend', () => {
      dragFrom = -1;
    });
  }

  function buildItem(ref, index, total, current) {
    const item = document.createElement('div');
    item.className = `thumb${index === current ? ' current' : ''}`;
    item.draggable = true;
    item.dataset.index = String(index);
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', t('edit.page.label', { n: index + 1 }));
    const frame = document.createElement('div');
    frame.className = 'thumb-frame';
    const label = document.createElement('span');
    label.className = 'thumb-no';
    label.textContent = String(index + 1);
    item.append(frame, label, actionsFor(index, total));
    item.addEventListener('click', () => onSelect(index));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(index);
      }
    });
    bindDrag(item, index);
    return { item, frame };
  }

  /** 换掉列表前释放旧的缩略图副本。 */
  function clearList() {
    list.querySelectorAll('canvas').forEach(releaseCanvas);
    list.replaceChildren();
  }

  /** 重建缩略图列表（页面顺序、编辑内容、当前页变了都调）。 */
  async function render() {
    cancel();
    const token = seq;
    const { doc, page, objectsFor } = getState();
    if (!doc) {
      clearList();
      return;
    }
    const built = doc.pages.map((ref, i) => buildItem(ref, i, doc.pages.length, page - 1));
    clearList();
    list.append(...built.map((b) => b.item));
    reveal(list.children[page - 1]);
    pruneCache(new Set(doc.pages.map((ref) => keyOf(ref, objectsFor(ref)))));
    for (let i = 0; i < doc.pages.length && token === seq; i++) {
      try {
        const canvas = await thumbCanvas(doc.pages[i], token);
        if (token !== seq || !canvas) return;
        // 同一个画布可能被多个缩略图用（复制出来的页），各自画一份缩小图
        const shown = document.createElement('canvas');
        shown.width = canvas.width;
        shown.height = canvas.height;
        shown.getContext('2d').drawImage(canvas, 0, 0);
        built[i].frame.replaceChildren(shown);
      } catch (err) {
        if (!isCancelled(err)) console.error('[label-print] thumbnail failed', err);
      }
    }
  }

  $('appendInput').addEventListener('change', (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length) onAppend(files);
  });

  return {
    render,
    cancel,
    clear() {
      cancel();
      pruneCache(new Set());
      clearList();
    },
  };
}
