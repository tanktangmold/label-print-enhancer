// 可视化编辑：三种视图
//   preview  排版后的纸张预览（默认）
//   select   在原页面上框选要打印的区域（坐标 mm，相对原页面左上）
//   arrange  在纸张上拖动/缩放选中内容（坐标 mm，相对纸张左上；靠近中线自动吸附居中）
import { normalizeCrop } from '../core/layout.js';
import {
  paperMm, sourceRect, contentBoxOnPaper, settingsFromBox, snapToCenter, fitBoxToPaper, clampRect, ptToMm, mmToPt,
} from '../core/visual.js';
import { t } from '../core/i18n.js';
import { createBoxEditor } from './box-editor.js';
import { renderRegion, sourceSize, detectContent, isCancelled, releaseCanvas } from './render.js';

const $ = (id) => document.getElementById(id);
const fmt = (v) => (Math.round(v * 10) / 10).toFixed(1);
const SNAP_PX = 8; // 离中线多少屏幕像素以内吸附
const DETECT_PAD_MM = 1;

/**
 * @param {object} deps
 * @param {() => object} deps.getState  { pdf, page, settings }
 * @param {(patch: object) => void} deps.applyPatch  合并设置并重新排版
 * @param {(err) => void} deps.onError
 */
export function createVisualEditor({ getState, applyPatch, onError }) {
  let mode = 'preview';
  let editor = null;
  let src = null; // 当前页源尺寸 pt
  let layer = null; // arrange 模式的内容层画布
  let layerKey = '';
  let seq = 0;
  let abort = new AbortController();

  const stage = $('stage');
  const paperStage = $('paperStage');
  const sourceWrap = $('sourceWrap');
  const editBar = $('editBar');

  function setButtons() {
    const hasPdf = !!getState().pdf;
    document.querySelectorAll('#stageTools [data-view]').forEach((btn) => {
      btn.disabled = !hasPdf;
      btn.classList.toggle('active', btn.dataset.view === mode);
      btn.setAttribute('aria-pressed', String(btn.dataset.view === mode));
    });
    stage.dataset.view = mode;
    editBar.hidden = mode === 'preview';
    document.querySelectorAll('[data-for-view]').forEach((el) => {
      el.hidden = el.dataset.forView !== mode;
    });
  }

  function teardown() {
    abort.abort();
    abort = new AbortController();
    editor?.destroy();
    editor = null;
    if (layer) {
      layer.remove();
      releaseCanvas(layer);
      layer = null;
      layerKey = '';
    }
    sourceWrap.replaceChildren();
    paperStage.classList.remove('arranging');
  }

  // ---------- 框选打印区域 ----------

  const srcUnits = () => ({ w: ptToMm(src.w), h: ptToMm(src.h) });
  const cropToMm = (c) => c && { x: ptToMm(c.x), y: ptToMm(c.y), w: ptToMm(c.w), h: ptToMm(c.h) };
  const mmToCrop = (b) => normalizeCrop({ x: mmToPt(b.x), y: mmToPt(b.y), w: mmToPt(b.w), h: mmToPt(b.h) });

  async function proposeCrop() {
    const { pdf, page, settings } = getState();
    const found = await detectContent(pdf, page, settings, abort.signal);
    if (!found) return null;
    const pad = mmToPt(DETECT_PAD_MM);
    return clampCrop({ x: found.x - pad, y: found.y - pad, w: found.w + 2 * pad, h: found.h + 2 * pad });
  }

  function clampCrop(c) {
    const b = clampRect({ x: ptToMm(c.x), y: ptToMm(c.y), w: ptToMm(c.w), h: ptToMm(c.h) }, srcUnits().w, srcUnits().h);
    return mmToCrop(b);
  }

  async function enterSelect(token) {
    const { pdf, page, settings } = getState();
    src = await sourceSize(pdf, page, settings);
    const width = Math.min(1600, Math.round(stage.clientWidth * (window.devicePixelRatio || 1)));
    const canvas = await renderRegion(pdf, page, settings, width, null, abort.signal);
    if (token !== seq) return releaseCanvas(canvas);
    sourceWrap.style.setProperty('--ratio', String(src.w / src.h));
    sourceWrap.replaceChildren(canvas);
    const crop = settings.crop ?? (await proposeCrop());
    if (token !== seq) return;
    editor = createBoxEditor({
      host: sourceWrap,
      units: srcUnits,
      box: cropToMm(crop),
      aspectLock: false,
      allowDraw: true,
      label: t('mode.select'),
      constrain: (b) => ({ box: clampRect(b, srcUnits().w, srcUnits().h) }),
      readout: (b) => t('select.readout', { x: fmt(b.x), y: fmt(b.y), w: fmt(b.w), h: fmt(b.h) }),
      onChange: (b, { final }) => {
        updateReadout(t('select.readout', { x: fmt(b.x), y: fmt(b.y), w: fmt(b.w), h: fmt(b.h) }));
        if (final) applyPatch({ crop: mmToCrop(b) });
      },
    });
    if (crop && !settings.crop) applyPatch({ crop }); // 自动识别出的区域直接生效，用户再微调
    updateReadout(crop ? t('select.readout', { ...mapFmt(cropToMm(crop)) }) : t('select.hint'));
  }

  const mapFmt = (b) => ({ x: fmt(b.x), y: fmt(b.y), w: fmt(b.w), h: fmt(b.h) });

  // ---------- 拖动调整 ----------

  const paperUnits = () => paperMm(getState().settings);

  function arrangeReadout(b, guides = {}) {
    const s = getState().settings;
    const pct = (b.w / ptToMm(sourceRect(s, src.w, src.h).w)) * 100;
    const marks = [guides.x && t('arrange.centerH'), guides.y && t('arrange.centerV')].filter(Boolean).join('  ');
    return `${t('arrange.readout', { ...mapFmt(b), pct: fmt(pct) })}${marks ? `  ${marks}` : ''}`;
  }

  function placeLayer(b) {
    if (!layer) return;
    const u = paperUnits();
    Object.assign(layer.style, {
      left: `${(b.x / u.w) * 100}%`,
      top: `${(b.y / u.h) * 100}%`,
      width: `${(b.w / u.w) * 100}%`,
      height: `${(b.h / u.h) * 100}%`,
    });
  }

  async function ensureLayer(token) {
    const { pdf, page, settings } = getState();
    const rect = sourceRect(settings, src.w, src.h);
    const key = JSON.stringify([page, rect, settings.rotate, settings.mono, settings.threshold]);
    if (layer && key === layerKey) return;
    const width = Math.min(2400, Math.round(stage.clientWidth * (window.devicePixelRatio || 1)));
    const canvas = await renderRegion(pdf, page, settings, width, rect, abort.signal);
    if (token !== seq) return releaseCanvas(canvas);
    if (layer) {
      layer.remove();
      releaseCanvas(layer);
    }
    canvas.className = 'content-layer';
    layer = canvas;
    layerKey = key;
    $('paperWrap').append(canvas);
  }

  function snapper(b) {
    const u = paperUnits();
    const threshold = SNAP_PX * (u.w / Math.max(1, paperStage.getBoundingClientRect().width));
    const r = snapToCenter(b, u, threshold);
    return { box: r.box, guides: { x: r.centeredX, y: r.centeredY } };
  }

  async function enterArrange(token) {
    const { pdf, page, settings } = getState();
    src = await sourceSize(pdf, page, settings);
    if (token !== seq) return;
    await ensureLayer(token);
    if (token !== seq) return;
    paperStage.classList.add('arranging');
    const box = contentBoxOnPaper(settings, sourceRect(settings, src.w, src.h));
    placeLayer(box);
    editor = createBoxEditor({
      host: paperStage,
      units: paperUnits,
      box,
      aspectLock: true,
      allowDraw: false,
      label: t('mode.arrange'),
      constrain: snapper,
      readout: (b, info) => arrangeReadout(b, info.guides),
      onChange: (b, { final, guides }) => {
        placeLayer(b);
        updateReadout(arrangeReadout(b, guides));
        if (final) applyPatch(settingsFromBox(sourceRect(getState().settings, src.w, src.h), b));
      },
    });
    updateReadout(arrangeReadout(box, snapper(box).guides));
  }

  function updateReadout(text) {
    $('editReadout').textContent = text;
  }

  // ---------- 对外 ----------

  async function setMode(next) {
    if (!getState().pdf) next = 'preview';
    const token = ++seq;
    teardown();
    mode = next;
    setButtons();
    if (mode === 'preview') return;
    try {
      if (mode === 'select') await enterSelect(token);
      else await enterArrange(token);
    } catch (err) {
      if (!isCancelled(err)) onError(err);
    }
  }

  /** 设置/翻页/换文件后调用：编辑视图里同步框和内容层。 */
  function refresh({ reload = false } = {}) {
    if (mode === 'preview') return setButtons();
    if (reload) return setMode(mode);
    if (mode === 'select') return; // 框选视图里的改动来自框本身，不用重画
    // arrange：面板改了数值 → 框和内容层跟着变
    const token = seq;
    const { settings } = getState();
    ensureLayer(token)
      .then(() => {
        if (token !== seq || !editor) return;
        const box = contentBoxOnPaper(settings, sourceRect(settings, src.w, src.h));
        editor.set(box);
        placeLayer(box);
        updateReadout(arrangeReadout(box, snapper(box).guides));
      })
      .catch((err) => !isCancelled(err) && onError(err));
  }

  function centerContent() {
    if (!editor) return;
    const u = paperUnits();
    const b = editor.box;
    const box = { ...b, x: (u.w - b.w) / 2, y: (u.h - b.h) / 2 };
    applyPatch(settingsFromBox(sourceRect(getState().settings, src.w, src.h), box));
  }

  function fitContent() {
    if (!editor) return;
    const rect = sourceRect(getState().settings, src.w, src.h);
    const box = fitBoxToPaper({ ...rect, w: ptToMm(rect.w), h: ptToMm(rect.h) }, paperUnits(), 2);
    applyPatch(settingsFromBox(rect, box));
  }

  /** 框选完成：把选区等比铺满纸张并居中，然后进入拖动调整。 */
  function finishSelect() {
    const { settings } = getState();
    if (settings.crop) {
      const box = fitBoxToPaper({ x: 0, y: 0, w: ptToMm(settings.crop.w), h: ptToMm(settings.crop.h) }, paperMm(settings), 2);
      applyPatch(settingsFromBox(settings.crop, box));
    }
    setMode('arrange');
  }

  async function redetect() {
    if (mode !== 'select') return;
    try {
      const crop = await proposeCrop();
      if (crop) {
        applyPatch({ crop });
        editor?.set(cropToMm(crop));
        updateReadout(t('select.readout', mapFmt(cropToMm(crop))));
      }
    } catch (err) {
      if (!isCancelled(err)) onError(err);
    }
  }

  function wholePage() {
    applyPatch({ crop: null });
    if (mode === 'select' && editor) {
      editor.set({ x: 0, y: 0, ...srcUnits() });
      updateReadout(t('select.readout', mapFmt({ x: 0, y: 0, ...srcUnits() })));
    }
  }

  document.querySelectorAll('#stageTools [data-view]').forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.view)));
  $('btnDetect').addEventListener('click', redetect);
  $('btnWholePage').addEventListener('click', wholePage);
  $('btnSelectDone').addEventListener('click', finishSelect);
  $('btnCenter').addEventListener('click', centerContent);
  $('btnFit').addEventListener('click', fitContent);
  $('btnArrangeDone').addEventListener('click', () => setMode('preview'));
  setButtons();

  return {
    get mode() {
      return mode;
    },
    setMode,
    refresh,
    wholePage,
  };
}
