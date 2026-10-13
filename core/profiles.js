// 打印方案：给一组排版设置起名保存；选中的方案下次打开时自动使用。纯函数，存取在 storage.js。
import { normalizeSettings } from './layout.js';

// 属于方案的设置（界面语言、自动接管等全局偏好不随方案变）
export const PROFILE_KEYS = Object.freeze([
  'paper', 'paperW', 'paperH', 'fitMode', 'scale', 'marginTop', 'marginLeft', 'align',
  'autoPadding', 'rotate', 'dpi', 'mono', 'threshold', 'crop',
]);
const MAX_PROFILES = 50;
const MAX_NAME = 60;

export const EMPTY_PROFILES = Object.freeze({ list: Object.freeze([]), active: null });

function pick(settings) {
  return Object.fromEntries(PROFILE_KEYS.map((k) => [k, settings[k]]));
}

export function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** 校验存储里读出来的方案数据（坏数据丢掉，不报错）。 */
export function normalizeProfiles(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.list)) return EMPTY_PROFILES;
  const seen = new Set();
  const list = raw.list
    .filter((p) => p && typeof p.id === 'string' && cleanName(p.name) && !seen.has(p.id) && seen.add(p.id))
    .slice(0, MAX_PROFILES)
    .map((p) => Object.freeze({ id: p.id, name: cleanName(p.name), settings: Object.freeze(pick(normalizeSettings(p.settings))) }));
  const active = list.some((p) => p.id === raw.active) ? raw.active : null;
  return Object.freeze({ list: Object.freeze(list), active });
}

export function findProfile(profiles, id) {
  return profiles.list.find((p) => p.id === id) ?? null;
}

/** 把方案套到当前设置上（只换方案字段，保留语言等全局偏好）。 */
export function applyProfile(settings, profile) {
  return normalizeSettings({ ...settings, ...profile.settings }, settings);
}

/** 当前设置和方案是否不同（用来提示「已修改」）。 */
export function isModified(settings, profile) {
  if (!profile) return false;
  return JSON.stringify(pick(settings)) !== JSON.stringify(profile.settings);
}

/** 另存为新方案并设为当前方案。重名时覆盖同名方案。 */
export function saveAs(profiles, name, settings, id = `p${Date.now().toString(36)}`) {
  const clean = cleanName(name);
  if (!clean) throw new Error('empty name');
  const existing = profiles.list.find((p) => p.name === clean);
  const entry = Object.freeze({ id: existing?.id ?? id, name: clean, settings: Object.freeze(pick(settings)) });
  const list = existing ? profiles.list.map((p) => (p.id === existing.id ? entry : p)) : [...profiles.list, entry];
  return Object.freeze({ list: Object.freeze(list.slice(-MAX_PROFILES)), active: entry.id });
}

/** 用当前设置更新指定方案。 */
export function update(profiles, id, settings) {
  const list = profiles.list.map((p) => (p.id === id ? Object.freeze({ ...p, settings: Object.freeze(pick(settings)) }) : p));
  return Object.freeze({ list: Object.freeze(list), active: id });
}

export function remove(profiles, id) {
  return Object.freeze({
    list: Object.freeze(profiles.list.filter((p) => p.id !== id)),
    active: profiles.active === id ? null : profiles.active,
  });
}

export function select(profiles, id) {
  return Object.freeze({ ...profiles, active: findProfile(profiles, id) ? id : null });
}
