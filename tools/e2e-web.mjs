// 在线版（GitHub Pages）端到端实测：本地起同样子路径的静态服务，无头 Chrome 打开主页和排版页。
// 用法：node tools/e2e-web.mjs [--shots docs/images]   （带 --shots 时顺便拍三种语言的界面截图）
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { launchChrome, waitFor, sleep } from './cdp.mjs';
import { startServer, BASE } from './serve-pages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const SHOTS = arg('--shots') ? resolve(arg('--shots')) : null;
const PORT = 8798;
const site = `http://127.0.0.1:${PORT}${BASE}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  (${detail})` : ''}`);
};

const server = await startServer({ port: PORT });
const { cdp, close } = await launchChrome({ port: 9338, chrome: arg('--chrome') ?? undefined });
try {
  // ① 主页：三语切换、对比图加载
  const home = await cdp.openPage(site);
  await waitFor(() => home.evaluate(`document.readyState === 'complete' && !!document.querySelector('#lang option')`), 10000, '主页加载');
  const titles = {};
  for (const lang of ['en', 'ja', 'zh']) {
    titles[lang] = await home.evaluate(`(() => { const s = document.getElementById('lang'); s.value = '${lang}'; s.dispatchEvent(new Event('change')); return document.querySelector('h1').textContent; })()`);
  }
  check('主页三种语言标题都能切换', titles.en.startsWith('Label Print Enhancer') && titles.ja.startsWith('ラベル印刷アシスト') && titles.zh.startsWith('标签打印增强'), JSON.stringify(titles));
  const imgs = await home.evaluate(`[...document.querySelectorAll('.compare img')].map((img) => img.complete && img.naturalWidth > 0)`);
  check('主页截图都加载成功（前后对比 + 可视化选区）', imgs.length === 4 && imgs.every(Boolean));
  check('主页无报错', home.errors.length === 0, home.errors.slice(0, 2).join(' | '));

  // ② 排版页：#demo 自动载入示例、语言跟主页一致（刚选了中文，存在同一份设置里）
  const v = await cdp.openPage(`${site}viewer.html#demo`);
  await waitFor(() => v.evaluate(`!!window.__lpe`), 10000, '排版页脚本');
  await v.evaluate('window.__lpe.ready');
  await waitFor(() => v.evaluate(`!!document.querySelector('#paperWrap canvas')`), 20000, '示例预览');
  const st = await v.evaluate(`({ pages: window.__lpe.getState().pdf?.numPages, print: document.getElementById('btnPrint').textContent, demoBar: !document.querySelector('.demo-bar').hidden, autoHidden: document.querySelector('[data-ext-only]').hidden })`);
  check('在线版载入示例 3 页、显示提示条、隐藏扩展专用设置', st.pages === 3 && st.demoBar && st.autoHidden, JSON.stringify(st));
  check('排版页沿用主页选的语言（中文）', st.print === '打印', st.print);

  // ③ 在线版打印流程：service worker 在子路径下提供排版后的 PDF
  await v.evaluate(`document.getElementById('btnPrint').click()`);
  await waitFor(() => v.evaluate(`!document.getElementById('panel').inert && !!document.querySelector('iframe.print-frame')`), 30000, '排版输出');
  await sleep(500);
  const frame = await v.evaluate(`({ src: document.querySelector('iframe.print-frame').src, type: document.querySelector('iframe.print-frame').contentDocument?.contentType, msg: document.getElementById('message').hidden ? '' : document.getElementById('message').textContent })`);
  check('在线版打印：子路径下 service worker 提供 PDF', frame.src.startsWith(`${site}generated/label-`) && frame.type === 'application/pdf' && !frame.msg, JSON.stringify(frame));

  // ④ 三种语言界面截图（文档用）
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const lang of ['en', 'ja', 'zh']) {
      await v.evaluate(`(() => { const s = document.getElementById('lang'); s.value = '${lang}'; s.dispatchEvent(new Event('change')); document.getElementById('message').hidden = true; })()`);
      await sleep(400);
      await v.shot(join(SHOTS, `viewer-${lang}.png`));
    }
    console.log(`  截图已保存到 ${SHOTS}`);
  }
  check('排版页无报错', v.errors.length === 0, v.errors.slice(0, 2).join(' | '));
} finally {
  await close();
  server.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
