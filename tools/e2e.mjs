// 端到端实测：用 Chrome for Testing（无头、独立用户目录，不碰日常 Chrome）加载扩展，跑排版页。
// 用法：node tools/e2e.mjs [--chrome <chrome.exe>] [--shots <截图目录>]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const CHROME = arg('--chrome', process.env.CHROME_PATH || join(process.env.USERPROFILE || '', '.agent-browser/browsers/chrome-152.0.7977.64/chrome.exe'));
const SHOTS = resolve(arg('--shots', join(root, 'tests', 'shots')));
const PORT = 9335;
const JP_URL = 'https://jpo-prd-tokyo-app-front.s3.ap-northeast-1.amazonaws.com/customer/0/pdffiles/e2e-test.pdf';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 极简 CDP 客户端 ----------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((fn) => fn(msg));
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, reject) => this.pending.set(id, { resolve: ok, reject }));
  }
  on(fn) {
    this.listeners.push(fn);
  }
}

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await sleep(200);
  }
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome for Testing：${CHROME}`);
  mkdirSync(SHOTS, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'lpe-e2e-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${root}`,
    `--disable-extensions-except=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900',
    '--lang=zh-CN', // 断言用的是中文文案，不随测试机系统语言变
  ], { stdio: 'ignore' });

  try {
    const version = await waitFor(
      () => fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null),
      15000,
      'Chrome 启动',
    );
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const errors = [];
    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });

    // 测试浏览器自带几个内置扩展，按 manifest 名字认出我们自己的
    const extId = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      for (const t of targetInfos.filter((x) => x.type === 'service_worker' && x.url.endsWith('/background.js'))) {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const r = await cdp.send('Runtime.evaluate', { expression: "(chrome.runtime.getManifest().homepage_url || '').endsWith('/label-print-enhancer')", returnByValue: true }, sessionId);
        if (r.result?.value === true) {
          await cdp.send('Runtime.enable', {}, sessionId); // 后台 service worker 的报错也收集
          await cdp.send('Log.enable', {}, sessionId);
          return new URL(t.url).host;
        }
        await cdp.send('Target.detachFromTarget', { sessionId });
      }
      return null;
    }, 10000, '扩展 service worker');
    check('扩展已加载', true, extId);
    const base = `chrome-extension://${extId}`;

    async function openPage(url) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Log.enable', {}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      if (url !== 'about:blank') await cdp.send('Page.navigate', { url }, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
      const evaluate = async (expression) => {
        const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      };
      const shot = async (name) => {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'));
      };
      const ready = async () => {
        try {
          await waitFor(() => evaluate('!!window.__lpe'), 10000, '排版页脚本加载');
        } catch (err) {
          await cdp.send('Page.reload', {}, sessionId);
          await sleep(1500);
          throw new Error(`${err.message}；页面报错：${errors.join(' | ') || '无'}`);
        }
        await evaluate('window.__lpe.ready');
      };
      return { targetId, sessionId, evaluate, shot, ready };
    }

    // 预览画布上黑色像素的包围盒，换算成 mm
    const BBOX_JS = `(() => {
      const c = document.querySelector('#paperWrap canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4] < 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      const dpi = window.__lpe.getState().settings.dpi, mm = (px) => +(px / dpi * 25.4).toFixed(2);
      return { w: c.width, h: c.height, left: mm(x0), top: mm(y0), right: mm(x1 + 1), bottom: mm(y1 + 1) };
    })()`;
    const OUTPUT_SIZES_JS = `(async () => {
      const bytes = await window.__lpe.buildOutput();
      const { PDFDocument } = await import('/lib/pdf-lib/pdf-lib.esm.min.js');
      const doc = await PDFDocument.load(bytes);
      return { bytes: bytes.length, sizes: doc.getPages().map((p) => p.getSize()) };
    })()`;

    // ① A4 竖版标签 → ゆうパケット 2 默认设置（93%、上 2mm、左 0）
    const v = await openPage(`${base}/viewer.html#src=${encodeURIComponent(`${base}/tests/fixtures/a4-label.pdf`)}`);
    await v.ready();
    await waitFor(() => v.evaluate(`!!document.querySelector('#paperWrap canvas')`), 15000, '预览渲染');
    const st = await v.evaluate(`(() => { const s = window.__lpe.getState(); return { pages: s.pdf.numPages, name: s.name } })()`);
    check('读取 3 页 PDF', st.pages === 3, JSON.stringify(st));
    const box = await v.evaluate(BBOX_JS);
    // 假标签框：左上 (3,3)mm、104×58mm → ×0.93 再下移 2mm
    const expect = { left: 3 * 0.93, top: 2 + 3 * 0.93, right: 107 * 0.93, bottom: 2 + 61 * 0.93 };
    const near = (a, b) => Math.abs(a - b) <= 0.4;
    check('画布 = 纸张 314×241pt@400dpi', box.w === 1744 && box.h === 1339, `${box.w}×${box.h}`);
    check('标签按 93% 放在左上（左/上边距正确）', near(box.left, expect.left) && near(box.top, expect.top), `left ${box.left} top ${box.top}`);
    check('标签右边/下边完整没被切', near(box.right, expect.right) && near(box.bottom, expect.bottom) && box.right < 110.7, `right ${box.right} bottom ${box.bottom}`);
    const out = await v.evaluate(OUTPUT_SIZES_JS);
    check('输出 PDF 3 页且每页 314×241pt（横向=纸张）', out.sizes.length === 3 && out.sizes.every((s) => s.width === 314 && s.height === 241), `${JSON.stringify(out.sizes[0])}, ${out.bytes} 字节`);
    const served = await v.evaluate(`(async () => {
      const { stageOutput } = await import('/core/output.js');
      const path = await stageOutput(await window.__lpe.buildOutput());
      const r = await fetch(path);
      const b = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, type: r.headers.get('content-type'), head: String.fromCharCode(...b.slice(0, 5)) };
    })()`);
    check('排版后 PDF 由扩展自己的地址提供（打印走这里）', served.status === 200 && served.type === 'application/pdf' && served.head === '%PDF-', JSON.stringify(served));
    await v.shot('1-default-93.png');

    // ② 切到「自动裁切适配」→ 标签放大铺满
    await v.evaluate(`(() => { const r = document.querySelector('input[name=fitMode][value=auto]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(400);
    await waitFor(() => v.evaluate(`window.__lpe.getState().settings.fitMode === 'auto' && !!document.querySelector('#paperWrap canvas')`), 10000, '自动适配渲染');
    await sleep(800);
    const autoBox = await v.evaluate(BBOX_JS);
    check('自动适配：内容铺满（四周留白≈2mm）', autoBox.left >= 1.5 && autoBox.right <= 110.7 - 1.5 && (autoBox.left < 3 || autoBox.top < 3), JSON.stringify(autoBox));
    await v.shot('2-auto-fit.png');

    // 清空「缩放」再失焦：应保持原值，不能变成最小值 10%
    await v.evaluate(`(() => { const r = document.querySelector('input[name=fitMode][value=scale]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await v.evaluate(`(() => { const i = document.getElementById('scale'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const kept = await v.evaluate(`({ setting: window.__lpe.getState().settings.scale, field: document.getElementById('scale').value })`);
    check('清空缩放框不会变成 10%', kept.setting === 93 && kept.field === '93', JSON.stringify(kept));

    // 点「打印」：排版期间设置面板被锁、按钮显示进度，结束后解锁且无报错
    const during = await v.evaluate(`(() => { document.getElementById('btnPrint').click(); return { inert: document.getElementById('panel').inert, btn: document.getElementById('btnPrint').textContent }; })()`);
    check('排版中锁住设置面板', during.inert === true, JSON.stringify(during));
    await waitFor(() => v.evaluate(`!document.getElementById('panel').inert`), 20000, '排版结束解锁');
    const after = await v.evaluate(`({ frame: document.querySelector('iframe.print-frame')?.src || '', type: document.querySelector('iframe.print-frame')?.contentDocument?.contentType, msg: document.getElementById('message').hidden ? '' : document.getElementById('message').textContent })`);
    check('打印流程：排版后 PDF 已加载进打印 iframe', /\/generated\/label-\d+-\w+\.pdf$/.test(after.frame) && after.type === 'application/pdf' && !after.msg, JSON.stringify(after));
    // 改回默认，设置应持久化
    await v.evaluate(`document.getElementById('btnReset').click()`);
    await sleep(600);

    // ③ 带 /Rotate 90 的 PDF 也能排
    const r = await openPage(`${base}/viewer.html#src=${encodeURIComponent(`${base}/tests/fixtures/a4-label-rot90.pdf`)}`);
    await r.ready();
    await waitFor(() => r.evaluate(`!!document.querySelector('#paperWrap canvas')`), 15000, '旋转页预览');
    const rotOut = await r.evaluate(OUTPUT_SIZES_JS);
    check('带旋转的源页面：输出仍是 314×241pt', rotOut.sizes.every((s) => s.width === 314 && s.height === 241));
    await r.shot('3-rotated-source.png');

    // ④ 打开日本邮政送り状网址 → 自动接管到排版页；取不到文件时给出退路
    const t = await openPage('about:blank');
    await cdp.send('Page.navigate', { url: JP_URL }, t.sessionId);
    const landed = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const info = targetInfos.find((x) => x.targetId === t.targetId);
      return info?.url.startsWith(`${base}/viewer.html`) ? info.url : null;
    }, 10000, '自动接管跳转');
    check('送り状 PDF 网址被自动接管', !!landed, landed.slice(0, 80));
    await sleep(1500);
    await waitFor(() => t.evaluate(`!document.getElementById('message').hidden && document.getElementById('message').textContent.includes('读取失败')`), 15000, '错误提示');
    const btns = await t.evaluate(`[...document.querySelectorAll('#message button')].map((b) => b.textContent)`);
    check('取不到文件时提示 + 退路按钮', btns.includes('用 Chrome 原生查看器打开') && btns.includes('选择本地 PDF'), btns.join(' / '));
    await t.shot('4-takeover-error.png');
    await t.evaluate(`[...document.querySelectorAll('#message button')].find((b) => b.textContent === '用 Chrome 原生查看器打开').click()`);
    const native = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const info = targetInfos.find((x) => x.targetId === t.targetId);
      return info?.url === JP_URL ? info.url : null;
    }, 10000, '放行到原生查看器');
    check('「用原生查看器打开」放行一次、不再被接管', !!native);

    // 只放过测试④里故意制造的 S3 403；其他任何报错（包括 /generated/ 404）都算失败
    const relevant = errors.filter((e) => !(/failed to load PDF/.test(String(e)) || (/403/.test(String(e)) && /jpo-prd-tokyo-app-front/.test(String(e)))));
    check('页面无意外报错', relevant.length === 0, relevant.slice(0, 3).join(' | '));

    // ⑤ 后台版本自检：同版本时不提示
    const ok = await openPage(`${base}/viewer.html#src=${encodeURIComponent(`${base}/tests/fixtures/a4-label.pdf`)}`);
    await ok.ready();
    await sleep(800);
    const ver = await ok.evaluate(`chrome.runtime.sendMessage({ type: 'lpe-version' }).then((r) => r.version)`);
    const okMsg = await ok.evaluate(`document.getElementById('message').hidden ? '' : document.getElementById('message').textContent`);
    check('后台版本一致时不提示重新加载', ver === JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version && !okMsg.includes('重新加载'), `${ver} ${okMsg}`);

    // ⑥ 排版文件取不到（模拟后台找不到文件）→ 自动在新标签打开排版后的 PDF
    const before = new Set((await cdp.send('Target.getTargets')).targetInfos.map((x) => x.targetId));
    await ok.evaluate(`(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (v, k) { return put.call(this, v, 'generated/elsewhere.pdf'); }; document.getElementById('btnPrint').click(); })()`);
    const blobTab = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find((x) => !before.has(x.targetId) && x.url.startsWith('blob:chrome-extension://')), 20000, '退路：新标签打开 PDF');
    const fbMsg = await ok.evaluate(`document.getElementById('message').textContent`);
    check('打印文件取不到：自动在新标签打开排版后的 PDF 并提示', !!blobTab && fbMsg.includes('新标签'), fbMsg.slice(0, 60));
    await cdp.send('Target.closeTarget', { targetId: blobTab.targetId });

    // 和用户一样打开「开发者模式」（加载已解压的扩展必须开）；不开的话测试浏览器里扩展一重载就被停用
    const mgr = await openPage('chrome://extensions/');
    await sleep(1000);
    await mgr.evaluate('chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');

    // ⑦ 模拟「改了文件没重新加载扩展」：后台回旧版本号 → 提示 + 重新加载按钮；点了以后扩展重载、本页自动重新打开
    const { targetId: staleId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: staleSid } = await cdp.send('Target.attachToTarget', { targetId: staleId, flatten: true });
    await cdp.send('Page.enable', {}, staleSid);
    await cdp.send('Runtime.enable', {}, staleSid);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "chrome.runtime.sendMessage = async () => ({ version: '0.0.1' });" }, staleSid);
    const staleUrl = `${base}/viewer.html#src=${encodeURIComponent(`${base}/tests/fixtures/a4-label.pdf`)}`;
    await cdp.send('Page.navigate', { url: staleUrl }, staleSid);
    const evalStale = async (expression) => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, staleSid)).result.value;
    await waitFor(() => evalStale(`!document.getElementById('message').hidden && document.getElementById('message').textContent.includes('旧版本')`), 15000, '旧后台提示');
    const btns2 = await evalStale(`[...document.querySelectorAll('#message button')].map((b) => b.textContent)`);
    check('后台是旧版本：提示并给「重新加载扩展」按钮', btns2.includes('重新加载扩展'), btns2.join(' / '));
    const beforeReload = new Set((await cdp.send('Target.getTargets')).targetInfos.map((x) => x.targetId));
    await evalStale(`[...document.querySelectorAll('#message button')].find((b) => b.textContent === '重新加载扩展').click()`);
    const reopened = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find((x) => !beforeReload.has(x.targetId) && x.type === 'page' && x.url.startsWith(`${base}/viewer.html`));
    }, 20000, '重新加载后自动重开排版页');
    check('点「重新加载扩展」：扩展重载并自动重新打开本页', !!reopened && reopened.url.includes('a4-label.pdf'), reopened?.url.slice(0, 90));
  } finally {
    chrome.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Chrome 退出慢时目录可能被占用，忽略 */
    }
  }

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过，截图在 ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('✖ e2e 中断：', err.message);
  process.exit(1);
});
