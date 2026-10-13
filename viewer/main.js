// 排版页主逻辑：加载 PDF → 按设置预览 → 打印 / 下载。扩展和网页版（GitHub Pages）共用。
import { DEFAULT_SETTINGS, normalizeSettings, fileBaseName } from '../core/layout.js';
import { loadSettings, saveSettings, addBypassOnce } from '../core/storage.js';
import { t, setLang, resolveLang, applyI18n, fillTemplate } from '../core/i18n.js';
import { IS_EXTENSION, assetUrl, ensureOutputServer } from '../core/platform.js';
import { openPdf, renderLabelPage, buildLabelPdf, isCancelled, releaseCanvas } from './render.js';
import { fetchPdfBytes, readFileBytes, requestOrigins } from './source.js';
import { fillPaperOptions, fillLangOptions, writeForm, readForm, syncVisibility, onFormChange, paperLabel } from './form.js';
import { showMessage, hideMessage, errorText } from './message.js';
import { printPdf } from './printer.js';
import { createVisualEditor } from './visual.js';
import { createProfilesUI } from './profiles-ui.js';
import { applyProfile } from '../core/profiles.js';

const $ = (id) => document.getElementById(id);
const RENDER_KEYS = ['paperW', 'paperH', 'fitMode', 'scale', 'marginTop', 'marginLeft', 'align', 'autoPadding', 'rotate', 'dpi', 'mono', 'threshold', 'crop'];
const ACTION_IDS = ['btnPrint', 'btnDownload', 'btnOriginal'];
const PREVIEW_CACHE_PAGES = 3;
const SAMPLE_PDF = 'samples/sample-label.pdf';

let state = Object.freeze({ settings: DEFAULT_SETTINGS, pdf: null, bytes: null, name: '', srcUrl: '', page: 1 });
let busy = false;
let loadSeq = 0; // 后发起的加载才算数
let renderSeq = 0; // 只显示最新一次预览
let previewAbort = new AbortController();
const previewCache = new Map(); // 页码 → Promise<{canvas, placement}>，最近用过的放最后
let shownPlacement = null; // 当前预览页的版面（换语言时重画标签文字用）
let progressText = null; // 忙碌时按钮上的进度（换语言后恢复）
let saveTimer = 0;
let renderTimer = 0;

function setState(patch) {
  state = Object.freeze({ ...state, ...patch });
}

const renderKey = (s) => JSON.stringify(RENDER_KEYS.map((k) => s[k]));
const shownCanvas = () => $('paperWrap').querySelector('canvas.baked');
let visual = null; // 可视化编辑（框选 / 拖动调整），init 里创建
let profilesUI = null; // 打印方案面板

// ---------- 语言 ----------

function renderDocName() {
  $('docName').textContent = state.pdf ? t('doc.loaded', { name: state.name, n: state.pdf.numPages }) : t('doc.none');
  document.title = state.pdf ? t('doc.title', { name: state.name }) : t('app.name');
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

/** 设置或文件变了：取消进行中的预览渲染、作废旧结果、清缓存。 */
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
    job = renderLabelPage(state.pdf, pageNo, state.settings, previewAbort.signal);
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
  const n = state.pdf?.numPages ?? 0;
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
  if (!state.pdf) return;
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
  if (!state.pdf) return;
  const page = Math.min(state.pdf.numPages, Math.max(1, n));
  if (page === state.page) return;
  setState({ page });
  showPreview();
  visual?.refresh({ reload: true });
}

// ---------- 设置 ----------

function persist(next) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveSettings(next).catch((err) => showMessage('error', t('error.saveSettings', { err: errorText(err) })));
  }, 300);
}

function applySettings(next, { committed }) {
  syncVisibility(next);
  if (committed) writeForm(next);
  const changed = renderKey(next) !== renderKey(state.settings);
  const rotated = next.rotate !== state.settings.rotate;
  setState({ settings: next });
  persist(next);
  profilesUI?.render();
  if (changed) {
    resetPreview();
    updateChrome(null);
    clearTimeout(renderTimer);
    renderTimer = setTimeout(showPreview, 150);
    visual?.refresh({ reload: rotated });
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
  $('panel').inert = on;
  $('stageTools').inert = on;
  $('editBar').inert = on;
  for (const id of ACTION_IDS) $(id).disabled = on || !state.pdf;
}

async function withBusy(button, task) {
  if (busy || !state.pdf) return;
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

// ---------- 加载 ----------

async function loadBytes(bytes, name, srcUrl, seq) {
  const pdf = await openPdf(bytes);
  if (seq !== loadSeq) {
    pdf.destroy(); // 期间用户又打开了别的文件，这个作废
    return false;
  }
  const old = state.pdf;
  resetPreview();
  setState({ pdf, bytes, name, srcUrl, page: 1 });
  old?.destroy();
  renderDocName();
  setBusy(false);
  hideMessage();
  await showPreview();
  visual?.refresh({ reload: true });
  return true;
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
    return await loadBytes(bytes, fileBaseName(url), url, seq);
  } catch (err) {
    if (seq === loadSeq) handleLoadError(err, url);
    return false;
  }
}

async function loadFile(file) {
  if (!file) return;
  if (busy) {
    showMessage('info', t('busy.noNewFile'));
    return;
  }
  const seq = ++loadSeq;
  try {
    await loadBytes(await readFileBytes(file), file.name.replace(/\.pdf$/i, '') || 'label', '', seq);
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error('[label-print] failed to open file', err);
    showMessage('error', t('load.openFailed', { err: errorText(err) }));
  }
}

// ---------- 输出 ----------

/** 用开始时的文件和设置生成（排版期间面板已锁，结束再核对一次）。 */
async function buildOutput(onProgress) {
  const { pdf, settings, name } = state;
  const bytes = await buildLabelPdf({ pdf, settings, title: `${name}${t('file.suffix')}`, onProgress });
  if (state.pdf !== pdf || renderKey(state.settings) !== renderKey(settings)) {
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
  if (!state.bytes) return;
  const url = URL.createObjectURL(new Blob([state.bytes], { type: 'application/pdf' }));
  openInTab(url);
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

// ---------- 事件 ----------

function bindEvents() {
  onFormChange($('panel'), (opts) => applySettings(readForm(state.settings), opts));
  $('lang').addEventListener('change', (e) => changeLanguage(e.target.value));
  $('btnReset').addEventListener('click', () => {
    if (!busy) applySettings(normalizeSettings({ lang: state.settings.lang }), { committed: true });
  });
  $('btnCropClear').addEventListener('click', () => visual.wholePage());
  $('fileInput').addEventListener('change', (e) => {
    loadFile(e.target.files[0]);
    e.target.value = ''; // 同一个文件再选一次也能触发
  });
  $('btnSample').addEventListener('click', () => loadFromUrl(assetUrl(SAMPLE_PDF)));
  $('btnPrint').addEventListener('click', doPrint);
  $('btnDownload').addEventListener('click', doDownload);
  $('btnOriginal').addEventListener('click', openOriginal);
  $('first').addEventListener('click', () => goPage(1));
  $('prev').addEventListener('click', () => goPage(state.page - 1));
  $('next').addEventListener('click', () => goPage(state.page + 1));
  $('last').addEventListener('click', () => goPage(state.pdf?.numPages ?? 1));

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

  const stage = $('stage');
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!busy) stage.classList.add('dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) stage.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragging');
    loadFile(e.dataTransfer?.files?.[0]);
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

async function init() {
  profilesUI = createProfilesUI({
    getSettings: () => state.settings,
    onApply: (next) => applySettings(next, { committed: true }),
    notify: (kind, text) => showMessage(kind, text),
  });
  let settings = await loadSettings();
  const profile = await profilesUI.init();
  if (profile) settings = applyProfile(settings, profile); // 默认方案：上次选中的方案
  setState({ settings });
  visual = createVisualEditor({
    getState: () => ({ pdf: state.pdf, page: state.page, settings: state.settings }),
    applyPatch,
    onError: (err) => showMessage('error', t('error.render', { page: state.page, err: errorText(err) })),
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
  if (!src) return;
  const loaded = await loadFromUrl(src);
  if (loaded && autoPrint && state.settings.autoPrint && state.srcUrl === src) doPrint();
}

const ready = init().catch((err) => {
  console.error('[label-print] init failed', err);
  showMessage('error', t('error.init', { err: errorText(err) }));
});

// 给自动化测试用的只读入口
window.__lpe = Object.freeze({ ready, getState: () => state, buildOutput: () => buildOutput(() => {}) });
