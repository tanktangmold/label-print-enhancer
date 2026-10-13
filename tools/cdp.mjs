// 测试脚本共用：启动独立的 Chrome for Testing（独立用户目录，不碰日常 Chrome）+ 极简 CDP 客户端。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 默认用 agent-browser 下载的 Chrome for Testing；别的路径用环境变量 CHROME_PATH 或脚本的 --chrome 参数
export const DEFAULT_CHROME = process.env.CHROME_PATH || join(process.env.USERPROFILE || process.env.HOME || '', '.agent-browser/browsers/chrome-152.0.7977.64/chrome.exe');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await sleep(200);
  }
}

export async function launchChrome({ chrome, port, headless = true, args = [] }) {
  chrome ??= DEFAULT_CHROME;
  if (!existsSync(chrome)) throw new Error(`找不到 Chrome for Testing：${chrome}`);
  const profile = mkdtempSync(join(tmpdir(), 'lpe-chrome-'));
  const proc = spawn(chrome, [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', ...args,
  ], { stdio: 'ignore' });
  const version = await waitFor(
    () => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null),
    15000,
    'Chrome 启动',
  );
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const close = async () => {
    proc.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Chrome 退出慢时目录可能被占用，忽略 */
    }
  };
  return { cdp, close };
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
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
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }

  on(fn) {
    this.listeners.push(fn);
  }

  /** 开新标签并附着：返回 evaluate / shot / 报错收集。 */
  async openPage(url, { width = 1400, height = 900 } = {}) {
    const errors = [];
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`);
    });
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Log.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
    const evaluate = async (expression) => {
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (file) => {
      const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, Buffer.from(data, 'base64'));
    };
    return { targetId, sessionId, evaluate, shot, errors };
  }
}
