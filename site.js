// 在线主页（GitHub Pages）：语言切换，和排版页共用同一套语言包与语言选择。
import { t, setLang, resolveLang, applyI18n, LANGS, LANG_NAMES } from './core/i18n.js';

const SETTINGS_KEY = 'label-print-enhancer.settings'; // 和排版页网页版同一份设置，语言选择两边通用

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveLang(lang) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readSettings(), lang }));
  } catch {
    /* 隐私模式下存不了，只影响下次打开时的默认语言 */
  }
}

function render(pref) {
  setLang(resolveLang(pref));
  applyI18n();
  document.title = t('site.title');
  document.querySelectorAll('.compare img').forEach((img) => {
    img.alt = img.closest('figure')?.querySelector('figcaption')?.textContent ?? '';
  });
}

const select = document.getElementById('lang');
const pref = readSettings().lang || 'auto';
select.replaceChildren(
  ...['auto', ...LANGS].map((code) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = code === 'auto' ? 'Auto / 自动 / 自動' : LANG_NAMES[code];
    return opt;
  }),
);
select.value = pref;
select.addEventListener('change', () => {
  saveLang(select.value);
  render(select.value);
});
render(pref);
