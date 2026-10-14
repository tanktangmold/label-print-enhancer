// 把排版后的 PDF 交给 Chrome 自带打印预览：存进本地 → 隐藏 iframe 按扩展地址加载 → 调 print()。
import { stageOutput } from '../core/output.js';
import { t } from '../core/i18n.js';
import { ensureOutputServer, IS_EXTENSION } from '../core/platform.js';
import { CODE_VERSION } from '../core/version.js';

const PRINT_DELAY_MS = 600; // 等 PDF 查看器初始化完
const LOAD_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForLoad(frame) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('print.timeout'))), LOAD_TIMEOUT_MS);
    frame.addEventListener(
      'load',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function frameProblem(frame) {
  // 文件取不到时 iframe 照样触发 load，内容是错误文字；必须确认真的是 PDF 再打印，不然会把错误文字打到标签上
  const doc = frame.contentDocument;
  if (doc?.contentType === 'application/pdf') return null;
  const text = doc?.body?.innerText?.trim() ?? '';
  if (text.startsWith('Label file expired')) return t('print.expired');
  return text.slice(0, 80) || t('print.notLoaded');
}

/**
 * 弹出 Chrome 打印预览。调完 print() 才结束（期间调用方应保持「忙」状态，避免连点）。
 * 返回扩展内的文件地址；直接打印失败时抛错，错误上带 path 供新标签打开。
 */
/** 后台 service worker 是否和本页同一版代码（旧版后台不认这条消息，也算不一致）。 */
export async function backgroundIsCurrent() {
  if (!IS_EXTENSION) return true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'lpe-version' });
    return reply?.version === CODE_VERSION;
  } catch {
    return false;
  }
}

/** 退路：在新标签打开排版后的 PDF（页面已和纸张同尺寸，在那里直接 Ctrl+P 也是对的）。 */
function fallbackError(bytes, message) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
  return Object.assign(new Error(message), { path: url });
}

export async function printPdf(bytes) {
  if (!(await ensureOutputServer())) throw fallbackError(bytes, t('print.noSw'));
  if (!(await backgroundIsCurrent())) throw fallbackError(bytes, t('ext.stalePrint'));
  const path = await stageOutput(bytes);
  document.querySelector('iframe.print-frame')?.remove();
  const frame = document.createElement('iframe');
  frame.className = 'print-frame';
  frame.title = t('btn.print');
  frame.setAttribute('aria-hidden', 'true');
  const loaded = waitForLoad(frame);
  frame.src = path;
  document.body.append(frame);
  await loaded;
  await sleep(PRINT_DELAY_MS);
  if (!frame.isConnected) return path;

  const problem = frameProblem(frame);
  if (problem) throw fallbackError(bytes, t('print.cannotOpen', { detail: problem }));
  try {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } catch (err) {
    throw Object.assign(new Error(t('print.cannotPrint', { err: err.message })), { path });
  }
  return path;
}
