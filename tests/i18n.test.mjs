import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTS, LANGS, resolveLang, setLang, t } from '../core/i18n.js';
import { PAPER_PRESETS } from '../core/layout.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('三种语言的词条完全一致（不缺不多）', () => {
  const base = Object.keys(DICTS.en).sort();
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(DICTS[lang]).sort(), base, `${lang} 词条和英文不一致`);
  }
});

test('同一词条在各语言里的 {占位符} 一致', () => {
  for (const key of Object.keys(DICTS.en)) {
    for (const lang of LANGS) {
      assert.equal(placeholders(DICTS[lang][key]), placeholders(DICTS.en[key]), `${lang}:${key}`);
    }
  }
});

test('每个纸张预设和分组都有三语名称', () => {
  for (const p of PAPER_PRESETS) {
    for (const lang of LANGS) assert.ok(DICTS[lang][`paper.${p.id}`], `${lang}: paper.${p.id}`);
  }
  for (const group of ['label', 'paper']) {
    for (const lang of LANGS) assert.ok(DICTS[lang][`paper.group.${group}`]);
  }
});

test('页面里用到的 data-i18n 词条都存在', () => {
  for (const file of ['viewer.html', 'index.html']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const html = readFileSync(path, 'utf8');
    const keys = [...html.matchAll(/data-i18n(?:-title|-label|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(keys.length > 0, file);
    for (const key of keys) assert.ok(key in DICTS.en, `${file}: ${key}`);
  }
});

test('扩展清单文字（_locales）三语齐全', () => {
  const read = (loc) => JSON.parse(readFileSync(join(root, '_locales', loc, 'messages.json'), 'utf8'));
  const en = Object.keys(read('en')).sort();
  for (const loc of ['ja', 'zh_CN']) assert.deepEqual(Object.keys(read(loc)).sort(), en, loc);
});

test('resolveLang：指定优先，auto 按浏览器语言，其他回落英文', () => {
  assert.equal(resolveLang('ja', ['zh-CN']), 'ja');
  assert.equal(resolveLang('auto', ['zh-TW', 'en']), 'zh');
  assert.equal(resolveLang('auto', ['ja-JP']), 'ja');
  assert.equal(resolveLang('auto', ['fr-FR', 'en-GB']), 'en');
  assert.equal(resolveLang('auto', ['ko-KR']), 'en');
});

test('t()：替换占位符，缺词条回落英文或 key', () => {
  setLang('zh');
  assert.equal(t('summary', { n: 3 }), '共 3 页 → 打印 3 张');
  assert.equal(t('no.such.key'), 'no.such.key');
  setLang('en');
  assert.equal(t('doc.loaded', { name: 'a', n: 2 }), 'a.pdf · 2 pages');
});

test('英文单数：1 page / 2 pages', () => {
  setLang('en');
  assert.equal(t('summary', { n: 1 }), '1 page → 1 label');
  assert.equal(t('summary', { n: 2 }), '2 pages → 2 labels');
  assert.equal(t('doc.loaded', { name: 'a', n: 1 }), 'a.pdf · 1 page');
  setLang('zh');
  assert.equal(t('summary', { n: 1 }), '共 1 页 → 打印 1 张');
});

test('首页写的预设数量和实际一致（加预设时别忘改文案）', () => {
  const count = String(PAPER_PRESETS.length - 1); // 不算「自定义」
  for (const lang of LANGS) assert.ok(DICTS[lang]['site.feat.2'].includes(count), `${lang}: ${DICTS[lang]['site.feat.2']}`);
});
