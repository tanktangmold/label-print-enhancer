// 界面多语言：t(key, params) 取文字；applyI18n() 按 data-i18n* 属性刷新页面。
import zh from '../i18n/zh.js';
import en from '../i18n/en.js';
import ja from '../i18n/ja.js';

export const DICTS = Object.freeze({ zh, en, ja });
export const LANGS = Object.freeze(['zh', 'en', 'ja']);
export const LANG_NAMES = Object.freeze({ zh: '中文', en: 'English', ja: '日本語' });
const HTML_LANG = Object.freeze({ zh: 'zh-CN', en: 'en', ja: 'ja' });

let current = 'en';

/** 'auto' 或无效值时按浏览器语言选：中文 → zh，日语 → ja，其他 → en。 */
export function resolveLang(pref, browserLangs = globalThis.navigator?.languages ?? []) {
  if (LANGS.includes(pref)) return pref;
  for (const raw of browserLangs) {
    const code = String(raw).toLowerCase();
    if (code.startsWith('zh')) return 'zh';
    if (code.startsWith('ja')) return 'ja';
    if (code.startsWith('en')) return 'en';
  }
  return 'en';
}

export function setLang(lang) {
  current = LANGS.includes(lang) ? lang : 'en';
  if (globalThis.document) document.documentElement.lang = HTML_LANG[current];
  return current;
}

export function getLang() {
  return current;
}

/** 取当前语言文字，缺了退回英文，再缺返回 key；{name} 占位符用 params 替换。 */
export function t(key, params = {}) {
  // 数量为 1 时有单数写法就用（英文 1 page / 2 pages）
  const one = params.n === 1 && `${key}.one` in DICTS.en ? `${key}.one` : null;
  const text = (one && DICTS[current][one]) ?? DICTS[current][key] ?? DICTS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

/**
 * 把带 {占位符} 的文字填进元素：占位符的值包成 <b>，其余是纯文本（不走 innerHTML）。
 */
export function fillTemplate(el, key, params) {
  const parts = t(key).split(/(\{\w+\})/);
  el.replaceChildren(
    ...parts.map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (!m || !(m[1] in params)) return document.createTextNode(part);
      const b = document.createElement('b');
      b.textContent = String(params[m[1]]);
      return b;
    }),
  );
}

/** 刷新页面上所有 data-i18n（文字）、data-i18n-title（提示）、data-i18n-label（optgroup 标签）、data-i18n-placeholder。 */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  });
  root.querySelectorAll('[data-i18n-label]').forEach((el) => {
    el.label = t(el.dataset.i18nLabel);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}
