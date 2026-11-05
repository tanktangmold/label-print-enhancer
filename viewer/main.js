// 排版页主逻辑：加载 PDF/图片（可合并多个）→ 编辑 → 按设置预览 → 打印 / 下载。扩展和网页版（GitHub Pages）共用。
// 文档 doc = { sources: [源文件…], pages: [页面引用…] }；每页的编辑对象在 edits[页面 id] 里（见 core/pages.js、core/edits.js）。
import { DEFAULT_SETTINGS, normalizeSettings, fileBaseName } from '../core/layout.js';
import { loadSettings, saveSettings, addBypassOnce } from '../core/storage.js';
import { t, setLang, resolveLang, applyI18n, fillTemplate } from '../core/i18n.js';
import { IS_EXTENSION, assetUrl, ensureOutputServer } from '../core/platform.js';
import { makePages, appendPages } from '../core/pages.js';
import { objectsFor } from '../core/edits.js';
import { renderLabelPage, buildLabelPdf, isCancelled, releaseCanvas } from './render.js';
import { openPdfSource, openImageSource, isImageFile, MAX_IMAGE_BYTES } from './sources.js';
import { fetchPdfBytes, readFileBytes, requestOrigins } from './source.js';
import { fillPaperOptions, fillLangOptions, writeForm, readForm, syncVisibility, onFormChange, paperLabel } from './form.js';
import { showMessage, hideMessage, errorText } from './message.js';
import { printPdf, backgroundIsCurrent } from './printer.js';
import { createVisualEditor } from './visual.js';
import { createEditView } from './edit.js';
import { createProfilesUI } from './profiles-ui.js';
import { clearImages } from './images.js';

const $ = (id) => document.getElementById(id);
const RENDER_KEYS = ['paperW', 'paperH', 'fitMode', 'scale', 'marginTop', 'marginLeft', 'align', 'autoPadding', 'rotate', 'dpi', 'mono', 'threshold', 'crop', 'overlays', 'watermark'];
const ACTION_IDS = ['btnPrint', 'btnDownload', 'btnOriginal'];
const PREVIEW_CACHE_PAGES = 3;
const SAMPLE_PDF = 'samples/sample-label.pdf';
const EMPTY_EDITS = Object.freeze({});
const PREVIEW_DELAY = 150; // 改设置后多久重画预览
const PREVIEW_DELAY_EDITING = 800; // 编辑 PDF 时预览看不见，打字停下来再画

let state = Object.freeze({ settings: DEFAULT_SETTINGS, doc: null, edits: EMPTY_EDITS, original: null, name: '', srcUrl: '', page: 1 });
let busy = false;
let loadSeq = 0; // 后发起的加载才算数
let renderSeq = 0; // 只显示最新一次预览
let previewAbort = new AbortController();
const previewCache = new Map(); // 页码 → Promise<{canvas, placement}>，最近用过的放最后
let shownPlacement = null; // 当前预览页的版面（换语言时重画标签文字用）
let progressText = null; // 忙碌时按钮上的进度（换语言后恢复）
let saveTimer = 0;
let renderTimer = 0;
let pageSeq = 0;
const newPageId = () => `p${Date.now().toString(36)}${++pageSeq}`;

function setState(patch) {
  state = Object.freeze({ ...state, ...patch });
}

const renderKey = (s) => JSON.stringify(RENDER_KEYS.map((k) => s[k]));
const shownCanvas = () => $('paperWrap').querySelector('canvas.baked');
const pageCount = () => state.doc?.pages.length ?? 0;
const currentRef = () => state.doc?.pages[state.page - 1] ?? null;
const objectsForRef = (ref) => objectsFor(state.edits, ref.id, state.settings.overlays);
let visual = null; // 可视化编辑（框选 / 拖动调整 / 编辑 PDF），init 里创建
let editView = null; // 编辑 PDF 视图
let profilesUI = null; // 打印方案面板

// ---------- 语言 ----------

function renderDocName() {
  $('docName').textContent = state.doc ? t('doc.loaded', { name: state.name, n: pageCount() }) : t('doc.none');
  document.title = state.doc ? t('doc.title', { name: state.name }) : t('app.name');
}

function applyLanguage() {
  setLang(resolveLang(state.settings.lang));
  applyI18n();
  fillPaperOptions();
  renderDocName();
  updateChrome(shownPlacement);
  profilesUI?.render();
  visual?.refresh();
  if (busy && progressText) progressText.button.textContent = t('busy.progress', progressText.params);
}

// ---------- 预览 ----------

function releaseJob(job) {
  job.then(({ canvas }) => canvas !== shownCanvas() && releaseCanvas(canvas)).catch(() => {});
}

/** 设置、文件或编辑变了：取消进行中的预览渲染、作废旧结果、清缓存。 */
function resetPreview() {
  renderSeq++;
  previewAbort.abort();
  previewAbort = new AbortController();
  previewCache.forEach(releaseJob);
  previewCache.clear();
}

function getPreview(pageNo) {
  let job = previewCache.get(pageNo);
  if (job) {
    previewCache.delete(pageNo); // 移到最后 = 最近使用
  } else {
    const ref = state.doc.pages[pageNo - 1];
    job = renderLabelPage(state.doc, ref, state.settings, previewAbort.signal, { objects: objectsForRef(ref) });
    job.catch(() => previewCache.get(pageNo) === job && previewCache.delete(pageNo));
  }
  previewCache.set(pageNo, job);
  while (previewCache.size > PREVIEW_CACHE_PAGES) {
    const [oldest, oldJob] = previewCache.entries().next().value;
    previewCache.delete(oldest);
    releaseJob(oldJob);
  }
  return job;
}

function updateChrome(placement) {
  shownPlacement = placement;
  const s = state.settings;
  const { name, size } = paperLabel(s);
  const n = pageCount();
  const pct = placement ? t('tag.percent', { pct: Math.round(placement.percent * 10) / 10 }) : '';
  const dpiNote = placement && placement.dpi < s.dpi ? t('tag.dpi', { dpi: placement.dpi }) : '';
  $('paperTag').textContent = t('tag.paper', { name, size }) + pct + (s.crop ? t('tag.crop') : '') + dpiNote;
  $('cropInfo').textContent = s.crop
    ? t('crop.size', { w: Math.round((s.crop.w * 254) / 72) / 10, h: Math.round((s.crop.h * 254) / 72) / 10 })
    : t('crop.full');
  $('btnCropClear').hidden = !s.crop;
  fillTemplate($('hint'), 'hint', { paper: t('hint.paper', { name, size }), scale: t('hint.scaleDefault') });
  $('pageInfo').textContent = `${n ? state.page : 0} / ${n}`;
  $('summary').textContent = t('summary', { n });
  $('first').disabled = $('prev').disabled = !n || state.page <= 1;
  $('next').disabled = $('last').disabled = !n || state.page >= n;
  if (!placement) $('paperStage').style.setProperty('--ratio', String(s.paperW / s.paperH));
}

async function showPreview() {
  updateChrome(null);
  if (!state.doc) return;
  const seq = ++renderSeq;
  try {
    const { canvas, placement } = await getPreview(state.page);
    if (seq !== renderSeq) return;
    $('paperStage').style.setProperty('--ratio', String(placement.page.w / placement.page.h));
    // 只换排版后的画布，拖动调整用的内容层留着
    canvas.classList.add('baked');
    const old = $('paperWrap').querySelector('canvas.baked, #empty');
    if (old !== canvas) (old ? old.replaceWith(canvas) : $('paperWrap').prepend(canvas));
    updateChrome(placement);
  } catch (err) {
    if (seq !== renderSeq || isCancelled(err)) return;
    console.error('[label-print] render failed', err);
    showMessage('error', t('error.render', { page: state.page, err: errorText(err) }));
  }
}

function goPage(n) {
  if (!state.doc) return;
  const page = Math.min(pageCount(), Math.max(1, n));
  if (page === state.page) return;
  setState({ page });
  showPreview();
  visual?.refresh({ reload: true });
}

/** 页面列表或编辑内容变了：重画预览、缩略图和当前视图。 */
function docChanged() {
  resetPreview();
  renderDocName();
  updateChrome(null);
  clearTimeout(renderTimer);
  renderTimer = setTimeout(showPreview, visual?.mode === 'edit' ? PREVIEW_DELAY_EDITING : PREVIEW_DELAY);
  visual?.refresh({ reload: true });
}

/** 编辑视图提交的改动：页面列表 / 每页编辑 / 每页同位置对象（后者在设置里，跟着方案保存）。 */
function applyDocSnap(snap) {
  let changed = false;
  if (snap.pages && snap.pages !== state.doc.pages) {
    setState({ doc: Object.freeze({ ...state.doc, pages: snap.pages }), page: Math.min(state.page, snap.pages.length) });
    changed = true;
  }
  if (snap.edits && snap.edits !== state.edits) {
    setState({ edits: snap.edits });
    changed = true;
  }
  if (snap.overlays && snap.overlays !== state.settings.overlays) applyPatch({ overlays: snap.overlays });
  else if (changed) docChanged();
}

// ---------- 设置 ----------

/** 立刻写入还没保存的设置（选方案后、关页面前）。 */
function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  saveSettings(state.settings).catch((err) => console.error('[label-print] save settings failed', err));
}

function persist(next) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    saveSettings(next).catch((err) => showMessage('error', t('error.saveSettings', { err: errorText(err) })));
  }, 300);
}

function applySettings(next, { committed }) {
  syncVisibility(next);
  if (committed) writeForm(next);
  const changed = renderKey(next) !== renderKey(state.settings);
  const reload = next.rotate !== state.settings.rotate || next.overlays !== state.settings.overlays;
  setState({ settings: next });
  persist(next);
  profilesUI?.render();
  if (changed) {
    resetPreview();
    updateChrome(null);
    clearTimeout(renderTimer);
    renderTimer = setTimeout(showPreview, PREVIEW_DELAY);
    visual?.refresh({ reload });
  }
}

/** 可视化编辑 / 按钮改设置：合并后按「已确认」处理（写回面板）。 */
function applyPatch(patch) {
  applySettings(normalizeSettings({ ...state.settings, ...patch }, state.settings), { committed: true });
}

function changeLanguage(lang) {
  const next = normalizeSettings({ ...state.settings, lang }, state.settings);
  setState({ settings: next });
  persist(next);
  applyLanguage();
}

// ---------- 忙碌状态：排版输出期间锁住设置和换文件 ----------

function setBusy(on) {
  busy = on;
  for (const id of ['panel', 'stageTools', 'editBar', 'editView']) $(id).inert = on;
  for (const id of ACTION_IDS) $(id).disabled = on || !state.doc;
}

async function withBusy(button, task) {
  if (busy || !state.doc) return;
  setBusy(true);
  try {
    await task((i, n) => {
      progressText = { button, params: { i, n } };
      button.textContent = t('busy.progress', { i, n });
    });
  } catch (err) {
    console.error('[label-print] output failed', err);
    if (err?.path) {
      openInTab(err.path, t('print.openedInTab', { err: errorText(err) }));
    } else {
      showMessage('error', t('error.output', { err: errorText(err) }));
    }
  } finally {
    progressText = null;
    button.textContent = t(button.dataset.i18n); // 期间可能换过语言，按当前语言恢复
    setBusy(false);
  }
}

// ---------- 加载 / 合并 ----------

/** 文件 → { kind: 'pdf', bytes } 或 { kind: 'image', blob }。 */
async function readInput(file) {
  if (isImageFile(file)) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error(t('edit.imageSize'));
    return { kind: 'image', blob: file };
  }
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    throw new Error(t('load.unsupported', { name: file.name }));
  }
  return { kind: 'pdf', bytes: await readFileBytes(file) };
}

const openSource = (input) => (input.kind === 'pdf' ? openPdfSource(input.bytes) : openImageSource(input.blob));

async function openDocument(input, name, srcUrl, seq) {
  const source = await openSource(input);
  if (seq !== loadSeq) {
    source.destroy(); // 期间用户又打开了别的文件，这个作废
    return false;
  }
  const old = state.doc;
  resetPreview();
  editView?.reset();
  clearImages();
  const doc = Object.freeze({ sources: Object.freeze([source]), pages: makePages(0, source.numPages, newPageId) });
  setState({ doc, edits: EMPTY_EDITS, original: input, name, srcUrl, page: 1 });
  old?.sources.forEach((s) => s.destroy());
  renderDocName();
  setBusy(false);
  hideMessage();
  await showPreview();
  visual?.refresh({ reload: true });
  return true;
}

/** 合并：把文件的页面追加到当前文档末尾（能撤销）。 */
async function appendFiles(files) {
  if (!state.doc) return openFiles(files);
  if (busy) {
    showMessage('info', t('busy.noNewFile'));
    return;
  }
  const seq = loadSeq; // 读文件期间又打开了别的文件，这次追加作废
  const opened = [];
  for (const file of files) {
    try {
      opened.push(await openSource(await readInput(file)));
    } catch (err) {
      console.error('[label-print] failed to append file', err);
      showMessage('error', t('load.openFailed', { err: errorText(err) }));
    }
    if (seq !== loadSeq) break;
  }
  if (seq !== loadSeq || !state.doc) {
    opened.forEach((src) => src.destroy());
    return;
  }
  if (!opened.length) return;
  editView?.pushHistory();
  const base = state.doc.sources.length;
  const pages = opened.reduce((acc, src, i) => appendPages(acc, makePages(base + i, src.numPages, newPageId)), state.doc.pages);
  setState({ doc: Object.freeze({ sources: Object.freeze([...state.doc.sources, ...opened]), pages }) });
  docChanged();
  showMessage('info', t('edit.appended', { n: opened.reduce((n, src) => n + src.numPages, 0) }));
}

async function openNative(url) {
  await addBypassOnce(url);
  location.href = url;
}

function handleLoadError(err, url) {
  console.error('[label-print] failed to load PDF', url, err);
  const pick = { label: t('btn.pickLocal'), onClick: () => $('fileInput').click() };
  if (err?.kind === 'permission') {
    showMessage('info', t('load.authorize', { msg: err.message }), [
      { label: t('btn.authorize'), primary: true, onClick: async () => (await requestOrigins(err.extra.origins)) && loadFromUrl(url) },
      pick,
    ]);
    return;
  }
  if (err?.kind === 'file-access') {
    showMessage('info', t('load.localHint'), [pick]);
    return;
  }
  const native = IS_EXTENSION && /^https?:/i.test(url) ? [{ label: t('btn.openNative'), onClick: () => openNative(url) }] : [];
  showMessage('error', t('load.failed', { err: errorText(err) }), [...native, pick]);
}

async function loadFromUrl(url) {
  if (busy) {
    showMessage('info', t('busy.noNewFile'));
    return false;
  }
  const seq = ++loadSeq;
  showMessage('info', t('load.reading', { name: fileBaseName(url) }));
  try {
    const bytes = await fetchPdfBytes(url);
    if (seq !== loadSeq) return false;
    return await openDocument({ kind: 'pdf', bytes }, fileBaseName(url), url, seq);
  } catch (err) {
    if (seq === loadSeq) handleLoadError(err, url);
    return false;
  }
}

/** 打开文件：第一个作为新文档，其余合并到后面。 */
async function openFiles(files) {
  const [first, ...rest] = files.filter(Boolean);
  if (!first) return;
  if (busy) {
    showMessage('info', t('busy.noNewFile'));
    return;
  }
  const seq = ++loadSeq;
  try {
    const opened = await openDocument(await readInput(first), first.name.replace(/\.[^.]+$/, '') || 'label', '', seq);
    if (opened && rest.length) await appendFiles(rest);
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error('[label-print] failed to open file', err);
    showMessage('error', t('load.openFailed', { err: errorText(err) }));
  }
}

// ---------- 输出 ----------

/** 用开始时的文档、编辑和设置生成（排版期间面板已锁，结束再核对一次）。 */
async function buildOutput(onProgress) {
  const { doc, edits, settings, name } = state;
  const bytes = await buildLabelPdf({
    doc,
    settings,
    objectsFor: (ref) => objectsFor(edits, ref.id, settings.overlays),
    title: `${name}${t('file.suffix')}`,
    onProgress,
  });
  if (state.doc !== doc || state.edits !== edits || renderKey(state.settings) !== renderKey(settings)) {
    throw new Error(t('error.changed'));
  }
  return bytes;
}

function openInTab(url, note) {
  window.open(url, '_blank');
  if (note) showMessage('info', note);
}

const doPrint = () => withBusy($('btnPrint'), async (progress) => printPdf(await buildOutput(progress)));

const doDownload = () =>
  withBusy($('btnDownload'), async (progress) => {
    const url = URL.createObjectURL(new Blob([await buildOutput(progress)], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.name}${t('file.suffix')}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });

function openOriginal() {
  const input = state.original;
  if (!input) return;
  const blob = input.kind === 'pdf' ? new Blob([input.bytes], { type: 'application/pdf' }) : input.blob;
  const url = URL.createObjectURL(blob);
  openInTab(url);
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

/** 编辑视图里点「水印」：回到预览，把面板的水印设置亮出来。 */
function revealWatermark() {
  visual?.setMode('preview');
  const section = $('wmSection');
  section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  section.classList.add('flash');
  setTimeout(() => section.classList.remove('flash'), 1600);
  $('wmEnabled').focus({ preventScroll: true });
}

// ---------- 事件 ----------

const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

function bindEvents() {
  onFormChange($('panel'), (opts) => applySettings(readForm(state.settings), opts));
  $('lang').addEventListener('change', (e) => changeLanguage(e.target.value));
  $('btnReset').addEventListener('click', () => {
    if (busy) return;
    editView.clearHistory();
    applySettings(normalizeSettings({ lang: state.settings.lang }), { committed: true });
  });
  $('btnCropClear').addEventListener('click', () => visual.wholePage());
  $('fileInput').addEventListener('change', (e) => {
    openFiles([...(e.target.files ?? [])]);
    e.target.value = ''; // 同一个文件再选一次也能触发
  });
  $('btnSample').addEventListener('click', () => loadFromUrl(assetUrl(SAMPLE_PDF)));
  $('btnPrint').addEventListener('click', doPrint);
  $('btnDownload').addEventListener('click', doDownload);
  $('btnOriginal').addEventListener('click', openOriginal);
  $('btnEditDone').addEventListener('click', () => visual.setMode('preview'));
  $('first').addEventListener('click', () => goPage(1));
  $('prev').addEventListener('click', () => goPage(state.page - 1));
  $('next').addEventListener('click', () => goPage(state.page + 1));
  $('last').addEventListener('click', () => goPage(pageCount()));

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault(); // Ctrl+P 打印排版后的标签，而不是这个设置页面
      doPrint();
      return;
    }
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') goPage(state.page - 1);
    if (e.key === 'ArrowRight' || e.key === 'PageDown') goPage(state.page + 1);
  });

  // 拖文件进来：编辑 PDF 视图里是合并到后面，其他时候是打开（多个文件则合并）
  const stage = $('stage');
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!busy) stage.classList.add('dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) stage.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    stage.classList.remove('dragging');
    const files = [...e.dataTransfer.files];
    if (visual?.mode === 'edit' && state.doc) appendFiles(files);
    else openFiles(files);
  });
}

/** 只有被自动接管、且是第一次打开（不是刷新/前进后退/恢复标签）时才自动弹打印。 */
function takeAutoPrintFlag(params) {
  const fromTakeover = params.get('from') === 'takeover';
  if (params.has('from')) {
    params.delete('from');
    history.replaceState(null, '', `#${params.toString()}`);
  }
  const navType = performance.getEntriesByType('navigation')[0]?.type;
  return fromTakeover && navType === 'navigate';
}

/** 扩展 / 网页版各自显示的区块。网页版顺便提前注册提供打印文件的 service worker。 */
function setupPlatform() {
  document.querySelectorAll('[data-web-only]').forEach((el) => (el.hidden = IS_EXTENSION));
  document.querySelectorAll('[data-ext-only]').forEach((el) => (el.hidden = !IS_EXTENSION));
  if (!IS_EXTENSION) ensureOutputServer().catch((err) => console.warn('[label-print] service worker unavailable', err));
}

/** 扩展更新后后台没重新加载：提示并给「重新加载扩展」按钮（重新加载后自动打开本页）。 */
async function warnIfStale() {
  if (!IS_EXTENSION || (await backgroundIsCurrent())) return;
  showMessage('error', t('ext.stale'), [
    {
      label: t('btn.reloadExt'),
      primary: true,
      onClick: async () => {
        await chrome.storage.local.set({ reopenAfterReload: location.href });
        chrome.runtime.reload();
      },
    },
  ]);
}

async function init() {
  profilesUI = createProfilesUI({
    getSettings: () => state.settings,
    onApply: (next) => {
      editView?.clearHistory(); // 换了方案，每页同位置的对象整体换掉，旧撤销记录作废
      applySettings(next, { committed: true });
      flushSave();
    },
    notify: (kind, text) => showMessage(kind, text),
  });
  // 沿用上次用的设置（含上次选的方案和之后没点「保存」的改动），不再用方案覆盖；方案下拉框只显示是哪个方案、有没有改过
  const settings = await loadSettings();
  setState({ settings });
  await profilesUI.init();
  window.addEventListener('pagehide', flushSave);
  editView = createEditView({
    getState: () => ({ doc: state.doc, edits: state.edits, page: state.page, settings: state.settings, ref: currentRef(), objectsFor: objectsForRef }),
    apply: applyDocSnap,
    goPage,
    onAppend: appendFiles,
    onWatermark: revealWatermark,
    notify: (kind, text) => showMessage(kind, text),
  });
  visual = createVisualEditor({
    getState: () => {
      const ref = currentRef();
      return { doc: state.doc, ref, settings: state.settings, objects: ref ? objectsForRef(ref) : [] };
    },
    applyPatch,
    onError: (err) => showMessage('error', t('error.render', { page: state.page, err: errorText(err) })),
    editView,
  });
  setupPlatform();
  fillLangOptions(settings.lang);
  applyLanguage();
  writeForm(settings);
  bindEvents();
  const params = new URLSearchParams(location.hash.slice(1));
  const autoPrint = takeAutoPrintFlag(params);
  let src = params.has('demo') && !IS_EXTENSION ? assetUrl(SAMPLE_PDF) : params.get('src');
  // 网页版不接受别的网站的地址（防止有人用本站页面展示他人的 PDF）
  if (src && !IS_EXTENSION && new URL(src, location.href).origin !== location.origin) src = null;
  if (!src) return warnIfStale();
  const loaded = await loadFromUrl(src);
  if (loaded && autoPrint && state.settings.autoPrint && state.srcUrl === src) doPrint();
  await warnIfStale();
}

const ready = init().catch((err) => {
  console.error('[label-print] init failed', err);
  showMessage('error', t('error.init', { err: errorText(err) }));
});

// 给自动化测试用的只读入口
window.__lpe = Object.freeze({
  ready,
  getState: () => state,
  pageCount,
  buildOutput: () => buildOutput(() => {}),
  setMode: (mode) => visual?.setMode(mode),
});
