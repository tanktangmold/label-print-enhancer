// 后台：① 日本邮政送り状 PDF 打开时自动换成标签排版页 ② 点工具栏图标用排版页打开当前 PDF
import { loadSettings, consumeBypass } from './core/storage.js';
import { handleGeneratedFetch } from './core/output.js';
import { CODE_VERSION } from './core/version.js';

const REOPEN_KEY = 'reopenAfterReload';

const JP_POST_HOST = 'jpo-prd-tokyo-app-front.s3.ap-northeast-1.amazonaws.com';

function viewerUrl(src, from) {
  const params = new URLSearchParams();
  if (src) params.set('src', src);
  if (from) params.set('from', from);
  return `${chrome.runtime.getURL('viewer.html')}#${params.toString()}`;
}

const JP_POST_FILTER = { url: [{ hostEquals: JP_POST_HOST, pathContains: '/pdffiles/' }] };

async function takeOver(tabId, url) {
  try {
    // 排版页取不到文件时会「放行一次」，让 Chrome 原生查看器打开
    if (await consumeBypass(url)) return;
    const settings = await loadSettings();
    if (!settings.autoTakeover) return;
    await chrome.tabs.update(tabId, { url: viewerUrl(url, 'takeover') });
  } catch (err) {
    // 接管失败就让 Chrome 正常打开原 PDF，不影响用户
    console.error('[标签打印增强] 接管 PDF 失败', url, err);
  }
}

// 直接打开送り状 PDF：加载前就换成排版页
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) takeOver(details.tabId, details.url);
}, JP_POST_FILTER);

// 网站先经服务器跳转再到 PDF 时 onBeforeNavigate 拿不到最终地址，在提交时补接管
// （只认服务器跳转：脚本跳转本身会触发 onBeforeNavigate，再认一次会和「放行一次」冲突）
chrome.webNavigation.onCommitted.addListener((details) => {
  const redirected = details.transitionQualifiers?.includes('server_redirect');
  if (details.frameId === 0 && redirected) takeOver(details.tabId, details.url);
}, JP_POST_FILTER);

// 排版后的 PDF 由这里按扩展自己的地址提供：blob: 地址的 PDF 在 iframe 里算跨源，没法直接调打印
self.addEventListener('fetch', handleGeneratedFetch);

// 排版页问后台版本（对不上就提示重新加载扩展）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'lpe-version') return false;
  sendResponse({ version: CODE_VERSION });
  return false;
});

// 排版页点「重新加载扩展」前记下自己的地址，扩展重载后把它打开（只认本扩展的排版页地址）。
// 后台是按需唤醒的：重载会触发 onInstalled（reason=update），靠它把后台叫起来。
async function reopenAfterReload() {
  const got = await chrome.storage.local.get(REOPEN_KEY);
  const url = got[REOPEN_KEY];
  if (!url) return;
  await chrome.storage.local.remove(REOPEN_KEY);
  if (typeof url === 'string' && url.startsWith(chrome.runtime.getURL('viewer.html'))) await chrome.tabs.create({ url });
}

chrome.runtime.onInstalled.addListener(() => {
  reopenAfterReload().catch((err) => console.error('[label-print] reopen after reload failed', err));
});

chrome.action.onClicked.addListener(async (tab) => {
  const src = tab?.url && /^(https?|file):/i.test(tab.url) ? tab.url : '';
  await chrome.tabs.create({ url: viewerUrl(src, 'action'), index: (tab?.index ?? 0) + 1 });
});
