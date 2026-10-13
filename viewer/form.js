// 设置面板 ↔ 设置对象 的双向绑定。
import { PAPER_PRESETS, normalizeSettings } from '../core/layout.js';
import { t, LANGS, LANG_NAMES } from '../core/i18n.js';

const $ = (id) => document.getElementById(id);

const NUMBER_FIELDS = ['paperW', 'paperH', 'scale', 'marginTop', 'marginLeft', 'autoPadding', 'threshold'];
const CHECK_FIELDS = ['mono', 'autoTakeover', 'autoPrint'];
const RADIO_FIELDS = ['fitMode', 'align'];
const SELECT_FIELDS = ['paper', 'rotate', 'dpi'];
const PAPER_GROUPS = ['label', 'paper'];

function paperOption(p) {
  const opt = document.createElement('option');
  opt.value = p.id;
  opt.textContent = p.w === null ? t(`paper.${p.id}`) : t('paper.option', { name: t(`paper.${p.id}`), w: p.w, h: p.h });
  return opt;
}

/** 按当前语言重建纸张下拉框（分组：快递面单 / 常用纸张 / 自定义），保留选中项。 */
export function fillPaperOptions() {
  const select = $('paper');
  const selected = select.value;
  const groups = PAPER_GROUPS.map((group) => {
    const og = document.createElement('optgroup');
    og.label = t(`paper.group.${group}`);
    og.append(...PAPER_PRESETS.filter((p) => p.group === group).map(paperOption));
    return og;
  });
  const custom = PAPER_PRESETS.filter((p) => p.group === 'custom').map(paperOption);
  select.replaceChildren(...groups, ...custom);
  if (selected) select.value = selected;
}

/** 语言下拉框：自动 + 三种语言（语言名用各自的写法）。 */
export function fillLangOptions(value) {
  const select = $('lang');
  select.replaceChildren(
    ...['auto', ...LANGS].map((code) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code === 'auto' ? 'Auto / 自动 / 自動' : LANG_NAMES[code];
      return opt;
    }),
  );
  select.value = value;
}

/** 把设置写进表单，并按设置显示/隐藏相关项。 */
export function writeForm(s) {
  for (const key of NUMBER_FIELDS) $(key).value = String(s[key]);
  for (const key of CHECK_FIELDS) $(key).checked = s[key];
  for (const key of SELECT_FIELDS) $(key).value = String(s[key]);
  for (const key of RADIO_FIELDS) {
    const radio = document.querySelector(`input[name="${key}"][value="${s[key]}"]`);
    if (radio) radio.checked = true;
  }
  syncVisibility(s);
}

/** 只更新显示/隐藏和阈值读数，不动用户正在输入的数字框。 */
export function syncVisibility(s) {
  $('thresholdOut').textContent = String(s.threshold);
  $('customPaperRow').hidden = s.paper !== 'custom';
  $('thresholdRow').hidden = !s.mono;
  document.querySelectorAll('[data-mode]').forEach((el) => {
    el.hidden = el.dataset.mode !== s.fitMode;
  });
}

/** 从表单读出设置（经过校验；无效项回落到 base，即当前设置）。 */
export function readForm(base) {
  const raw = { lang: base.lang };
  for (const key of NUMBER_FIELDS) raw[key] = $(key).value;
  for (const key of CHECK_FIELDS) raw[key] = $(key).checked;
  for (const key of SELECT_FIELDS) raw[key] = key === 'paper' ? $(key).value : Number($(key).value);
  for (const key of RADIO_FIELDS) raw[key] = document.querySelector(`input[name="${key}"]:checked`)?.value;
  return normalizeSettings(raw, base);
}

/**
 * 表单变化回调：输入中（input）只更新设置；失焦/选择（change）后再把校验后的值写回表单。
 */
export function onFormChange(panel, callback) {
  const isSetting = (e) => e.target instanceof HTMLElement && e.target.type !== 'file';
  panel.addEventListener('input', (e) => isSetting(e) && callback({ committed: false }));
  panel.addEventListener('change', (e) => isSetting(e) && callback({ committed: true }));
}

/** 预览上方标签和打印提示里用的纸张名称/尺寸。 */
export function paperLabel(s) {
  const preset = PAPER_PRESETS.find((p) => p.id === s.paper);
  return {
    name: t(`paper.${preset?.id ?? 'custom'}`),
    size: t('tag.size', { w: s.paperW, h: s.paperH }),
  };
}
