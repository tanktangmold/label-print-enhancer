// 运行环境：Chrome 扩展 或 普通网页（GitHub Pages 在线版）。两边共用同一套排版页代码。
export const IS_EXTENSION = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

/** 项目根目录下资源的绝对地址（扩展里是 chrome-extension://id/…，网页里是站点目录）。 */
export function assetUrl(path) {
  return new URL(`../${path}`, import.meta.url).href;
}

const SW_READY_TIMEOUT_MS = 10_000;

/**
 * 网页版：注册提供排版后 PDF 的 service worker（扩展版由 background.js 提供）。
 * 浏览器不支持、禁止存站点数据或超时都返回 false，调用方退回「新标签打开 PDF」。
 */
export async function ensureOutputServer() {
  if (IS_EXTENSION) return true;
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register(assetUrl('sw.js'), { type: 'module', scope: assetUrl('') });
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), SW_READY_TIMEOUT_MS));
    return (await Promise.race([navigator.serviceWorker.ready.then(() => true), timeout])) === true;
  } catch (err) {
    console.warn('[label-print] service worker unavailable', err);
    return false;
  }
}
