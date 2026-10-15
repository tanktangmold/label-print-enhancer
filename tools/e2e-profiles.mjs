// 打印方案的端到端实测：多个方案来回切换、手动改设置、重新打开页面后应保持「上次用的」。
// 用法：node tools/e2e-profiles.mjs [--chrome <chrome.exe>]
import { launchChrome, waitFor, sleep } from './cdp.mjs';
import { startServer, BASE } from './serve-pages.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const PORT = 18795;
const site = `http://127.0.0.1:${PORT}${BASE}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  (${detail})` : ''}`);
};

const server = await startServer({ port: PORT });
const { cdp, close } = await launchChrome({ port: 9342, chrome: arg('--chrome') ?? undefined, args: ['--lang=zh-CN'] });
try {
  const v = await cdp.openPage(`${site}viewer.html#demo`);
  const ready = async () => {
    await waitFor(() => v.evaluate('!!window.__lpe'), 15000, '排版页');
    await v.evaluate('window.__lpe.ready');
    await waitFor(() => v.evaluate(`!!document.querySelector('#paperWrap canvas.baked')`), 20000, '预览');
  };
  const reopen = async () => {
    await cdp.send('Page.reload', { ignoreCache: false }, v.sessionId); // 只改 # 的跳转不会重新加载页面
    await sleep(800);
    await ready();
  };
  const state = () => v.evaluate(`({ paper: window.__lpe.getState().settings.paper, scale: window.__lpe.getState().settings.scale, profile: document.getElementById('profile').selectedOptions[0]?.textContent, note: document.getElementById('profileState').textContent })`);
  const setField = (id, value) => v.evaluate(`(() => { const el = document.getElementById('${id}'); el.value = '${value}'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const pickProfile = (name) => v.evaluate(`(() => { const s = document.getElementById('profile'); const o = [...s.options].find((x) => x.textContent === '${name}'); s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const saveAs = async (name) => {
    await v.evaluate(`document.getElementById('btnProfileSaveAs').click()`);
    await v.evaluate(`document.getElementById('profileName').value = '${name}'`);
    await v.evaluate(`document.getElementById('btnProfileNameOk').click()`);
    await sleep(300);
  };

  await ready();
  // 两个方案：A6 post（A6、50%）、ゆうパケット（ゆうパケット 2、93%）
  await setField('paper', 'a6');
  await setField('scale', '50');
  await saveAs('A6 post');
  await setField('paper', 'yupacket2');
  await setField('scale', '93');
  await saveAs('ゆうパケット');
  let s = await state();
  check('另存为两个方案，当前是后存的那个', s.profile === 'ゆうパケット' && s.paper === 'yupacket2', JSON.stringify(s));

  // 来回切换
  await pickProfile('A6 post');
  await sleep(400);
  s = await state();
  check('切到「A6 post」：纸张变 A6、50%', s.profile === 'A6 post' && s.paper === 'a6' && s.scale === 50, JSON.stringify(s));
  await pickProfile('ゆうパケット');
  await sleep(400);
  s = await state();
  check('再切回「ゆうパケット」：不会跳回 A6', s.profile === 'ゆうパケット' && s.paper === 'yupacket2' && s.scale === 93, JSON.stringify(s));

  // 重新打开：沿用上次选的方案
  await reopen();
  s = await state();
  check('重新打开：还是「ゆうパケット」', s.profile === 'ゆうパケット' && s.paper === 'yupacket2', JSON.stringify(s));

  // 用户反馈的情形：在方案基础上改了设置（没点保存），下次打开不能被方案打回去
  await setField('paper', '4x6');
  await setField('scale', '80');
  await sleep(500);
  s = await state();
  check('改了纸张和比例：提示已修改', s.note.includes('已修改'), s.note);
  await reopen();
  s = await state();
  check('重新打开：保留上次改过的设置（4×6、80%），不被方案打回', s.paper === '4x6' && s.scale === 80, JSON.stringify(s));

  // 点「保存」写入方案；切到别的方案再切回来，是保存后的设置
  await v.evaluate(`document.getElementById('btnProfileSave').click()`);
  await sleep(300);
  await pickProfile('A6 post');
  await sleep(300);
  await pickProfile('ゆうパケット');
  await sleep(300);
  s = await state();
  check('保存后再切回：方案里是保存后的设置', s.paper === '4x6' && s.scale === 80, JSON.stringify(s));

  // 选另一个方案后马上关闭页面（不等自动保存）→ 重新打开仍是它
  await pickProfile('A6 post');
  await cdp.send('Page.navigate', { url: 'about:blank' }, v.sessionId);
  await sleep(300);
  await cdp.send('Page.navigate', { url: `${site}viewer.html#demo` }, v.sessionId);
  await sleep(800);
  await ready();
  s = await state();
  check('选方案后立刻关页面：下次打开仍是刚选的方案', s.profile === 'A6 post' && s.paper === 'a6' && s.scale === 50, JSON.stringify(s));
  check('页面无报错', v.errors.length === 0, v.errors.slice(0, 2).join(' | '));
} finally {
  await close();
  server.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
