// 取源 PDF：网址（先查扩展有没有该网站的读取权限）或本地文件。
import { looksLikePdf } from '../core/layout.js';
import { t } from '../core/i18n.js';
import { IS_EXTENSION } from '../core/platform.js';

export class SourceError extends Error {
  constructor(message, kind, extra = {}) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind; // permission | file-access | http | network | not-pdf | unsupported
    this.extra = extra;
  }
}

async function ensureAccess(url) {
  const u = new URL(url);
  if (u.protocol === 'chrome-extension:' || u.protocol === 'blob:') return;
  // 网页版：本地文件只能拖进来；网址同源才取得到（浏览器跨源限制），不用查扩展权限
  if (!IS_EXTENSION) {
    if (u.protocol === 'file:') throw new SourceError(t('src.noFileAccess'), 'file-access');
    return;
  }
  if (u.protocol === 'file:') {
    if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
      throw new SourceError(t('src.noFileAccess'), 'file-access');
    }
    // 只开「允许访问文件网址」还不够，fetch 还要 file:///* 主机权限（实测）
    const origins = ['file:///*'];
    if (!(await chrome.permissions.contains({ origins }))) {
      throw new SourceError(t('src.needFilePerm'), 'permission', { origins });
    }
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SourceError(t('src.unsupported', { proto: u.protocol }), 'unsupported');
  }
  const origins = [`${u.origin}/*`];
  if (!(await chrome.permissions.contains({ origins }))) {
    throw new SourceError(t('src.needHostPerm', { host: u.host }), 'permission', { origins });
  }
}

export async function fetchPdfBytes(url) {
  await ensureAccess(url);
  let res;
  try {
    // 扩展里要带登录 cookie（快递网站的面单）；网页版只取同源文件
    res = await fetch(url, { credentials: IS_EXTENSION ? 'include' : 'same-origin' });
  } catch (err) {
    throw new SourceError(t('src.network', { err: err.message }), 'network');
  }
  if (!res.ok) {
    throw new SourceError(t('src.http', { status: res.status }), 'http');
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!looksLikePdf(bytes)) {
    throw new SourceError(t('src.notPdf'), 'not-pdf');
  }
  return bytes;
}

export async function readFileBytes(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikePdf(bytes)) throw new SourceError(t('src.fileNotPdf', { name: file.name }), 'not-pdf');
  return bytes;
}

export function requestOrigins(origins) {
  return chrome.permissions.request({ origins });
}
