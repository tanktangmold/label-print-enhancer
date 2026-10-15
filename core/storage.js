// 设置读写 + 「放行一次」名单。扩展里用 chrome.storage，网页版用 localStorage / sessionStorage。
import { normalizeSettings } from './layout.js';
import { IS_EXTENSION } from './platform.js';
import { normalizeProfiles } from './profiles.js';

const SETTINGS_KEY = 'settings';
const BYPASS_KEY = 'bypassOnce';
const BYPASS_TTL_MS = 60_000;
const WEB_SETTINGS_KEY = 'label-print-enhancer.settings';

function readWebSettings() {
  try {
    return JSON.parse(localStorage.getItem(WEB_SETTINGS_KEY) || 'null');
  } catch {
    return null; // 隐私模式或数据损坏：用默认值
  }
}

export async function loadSettings() {
  try {
    if (!IS_EXTENSION) return normalizeSettings(readWebSettings());
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(got[SETTINGS_KEY]);
  } catch (err) {
    console.error('[label-print] failed to read settings, using defaults', err);
    return normalizeSettings({});
  }
}

export async function saveSettings(settings) {
  const clean = normalizeSettings(settings);
  if (IS_EXTENSION) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...clean } });
  } else {
    localStorage.setItem(WEB_SETTINGS_KEY, JSON.stringify(clean));
  }
  return clean;
}

async function readBypass() {
  const got = await chrome.storage.session.get(BYPASS_KEY);
  const now = Date.now();
  return (got[BYPASS_KEY] || []).filter((e) => e && now - e.at < BYPASS_TTL_MS);
}

/** 记一条「下次打开这个 URL 不接管」，用于取不到文件时退回 Chrome 原生查看器（仅扩展）。 */
export async function addBypassOnce(url) {
  if (!IS_EXTENSION) return;
  const list = await readBypass();
  await chrome.storage.session.set({ [BYPASS_KEY]: [...list, { url, at: Date.now() }] });
}

/** 命中则消费掉这条放行记录并返回 true。 */
export async function consumeBypass(url) {
  const list = await readBypass();
  const hit = list.some((e) => e.url === url);
  if (hit) {
    await chrome.storage.session.set({ [BYPASS_KEY]: list.filter((e) => e.url !== url) });
  }
  return hit;
}

// ---------- 打印方案 ----------

const PROFILES_KEY = 'profiles';
const WEB_PROFILES_KEY = 'label-print-enhancer.profiles';

export async function loadProfiles() {
  try {
    if (!IS_EXTENSION) return normalizeProfiles(JSON.parse(localStorage.getItem(WEB_PROFILES_KEY) || 'null'));
    const got = await chrome.storage.local.get(PROFILES_KEY);
    return normalizeProfiles(got[PROFILES_KEY]);
  } catch (err) {
    console.error('[label-print] failed to read profiles', err);
    return normalizeProfiles(null);
  }
}

export async function saveProfiles(profiles) {
  const plain = { list: profiles.list.map((p) => ({ ...p, settings: { ...p.settings } })), active: profiles.active };
  if (IS_EXTENSION) await chrome.storage.local.set({ [PROFILES_KEY]: plain });
  else localStorage.setItem(WEB_PROFILES_KEY, JSON.stringify(plain));
}
