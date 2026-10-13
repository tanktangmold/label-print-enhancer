// 真打印预览对比（只看预览，不会真的打印）：同一个 PDF「直接打印」vs「排版后打印」。
// 会弹出一个独立的 Chrome for Testing 窗口（独立用户目录，不碰日常 Chrome），跑完自动关闭。
// 用法：node tools/print-preview-check.mjs [--pdf tests/fixtures/a4-label.pdf] [--printer Xprinter] [--paper "ゆうパケット 2"] [--out 目录] [--lang en-US]
// 注意：依赖 chrome://print 内部组件（destinationStore_ 等），Chrome 大版本升级后可能要调整。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const CHROME = arg('--chrome', process.env.CHROME_PATH || join(process.env.USERPROFILE || '', '.agent-browser/browsers/chrome-152.0.7977.64/chrome.exe'));
const PDF = relative(root, resolve(arg('--pdf', join(root, 'tests/fixtures/a4-label.pdf')))).replaceAll('\\', '/');
const PRINTER = arg('--printer', 'Xprinter');
const PAPER = arg('--paper', 'ゆうパケット 2');
const OUT = resolve(arg('--out', join(root, 'tests', 'shots')));
const LANG = arg('--lang', ''); // 测试浏览器界面语言，如 en-US / ja / zh-CN（打印对话框跟着变）
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEEP = `function deepAll(root, sel, out = []) {
  root.querySelectorAll(sel).forEach((e) => out.push(e));
  root.querySelectorAll('*').forEach((e) => e.shadowRoot && deepAll(e.shadowRoot, sel, out));
  return out;
}`;

let ws;
let seq = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((ok, fail) => pending.set(id, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result))));
}
async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function targets() {
  return (await send('Target.getTargets')).targetInfos;
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return sessionId;
}

async function findExtension() {
  for (const t of (await targets()).filter((x) => x.type === 'service_worker' && x.url.endsWith('/background.js'))) {
    const sid = await attach(t.targetId);
    if ((await evaluate(sid, "(chrome.runtime.getManifest().homepage_url || '').endsWith('/label-print-enhancer')")) === true) return new URL(t.url).host;
  }
  throw new Error('没找到扩展');
}

/** 等打印预览出现 → 选打印机和纸张 → 截图 → 关闭预览。 */
async function captureDialog(label, file, previousId = null) {
  let dialog = null;
  for (let i = 0; i < 40 && !dialog; i++) {
    await sleep(500);
    dialog = (await targets()).find((x) => x.url.startsWith('chrome://print') && x.targetId !== previousId);
  }
  if (!dialog) throw new Error(`${label}：打印预览没出现`);
  const sid = await attach(dialog.targetId);
  await sleep(2500);
  const picked = await evaluate(sid, `(async () => { ${DEEP}
    const store = deepAll(document, 'print-preview-destination-settings')[0]?.destinationStore_;
    if (!store) return '找不到 destinationStore_（Chrome 版本变了？）';
    store.startLoadAllDestinations?.();
    for (let i = 0; i < 30; i++) {
      const d = store.destinations().find((x) => x.displayName.includes(${JSON.stringify(PRINTER)}));
      if (d) { store.selectDestination(d); return d.displayName; }
      await new Promise((r) => setTimeout(r, 300));
    }
    return '没找到打印机：' + store.destinations().map((x) => x.displayName).join(', ');
  })()`);
  await sleep(3500);
  const paper = await evaluate(sid, `(() => { ${DEEP}
    const s = deepAll(document, 'select').find((x) => ['纸张尺寸', 'Paper size', '用紙サイズ'].includes(x.getAttribute('aria-label')));
    const o = s && [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(PAPER)});
    if (!o) return '没找到纸张';
    s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true }));
    const m = JSON.parse(o.value);
    return o.textContent.trim() + '（Chrome 认为 ' + m.width_microns / 1000 + '×' + m.height_microns / 1000 + 'mm）';
  })()`);
  await sleep(5000);
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sid);
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  console.log(`✔ ${label}：打印机 ${picked}，纸张 ${paper} → ${join(OUT, file)}`);
  // 点「取消」关掉预览，并等它真正消失；否则同一标签页的下一次打印会被 Chrome 忽略
  await evaluate(sid, `(() => { ${DEEP} deepAll(document, 'cr-button.cancel-button')[0]?.click(); })()`).catch(() => {});
  for (let i = 0; i < 20 && (await targets()).some((x) => x.targetId === dialog.targetId); i++) await sleep(300);
  return dialog.targetId;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'lpe-preview-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--load-extension=${root}`,
    `--disable-extensions-except=${root}`, '--no-first-run', '--no-default-browser-check', '--window-size=1400,950', ...(LANG ? [`--lang=${LANG}`] : []),
  ], { stdio: 'ignore' });
  try {
    await sleep(3500);
    const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) pending.get(m.id)?.(m);
    });
    const ext = await findExtension();
    const base = `chrome-extension://${ext}`;
    const { targetId } = await send('Target.createTarget', { url: `${base}/viewer.html#src=${encodeURIComponent(`${base}/${PDF}`)}` });
    const page = await attach(targetId);
    await sleep(2500);
    await evaluate(page, 'window.__lpe.ready');

    await evaluate(page, `(() => { const f = document.createElement('iframe'); f.className = 'print-frame';
      f.src = ${JSON.stringify(`/${PDF}`)}; f.onload = () => setTimeout(() => f.contentWindow.print(), 600); document.body.append(f); })()`);
    const firstId = await captureDialog('原 PDF 直接打印', 'preview-before.png');

    await evaluate(page, `document.getElementById('btnPrint').click()`);
    await captureDialog('排版后打印', 'preview-after.png', firstId);
  } finally {
    chrome.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Chrome 退出慢时目录可能被占用，忽略 */
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('✖', err.message);
    process.exit(1);
  },
);
