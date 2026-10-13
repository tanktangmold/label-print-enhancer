// 构建在线版（GitHub Pages）：npm run pages:build → dist/pages/
// 网页版和扩展用同一套排版页代码（core/platform.js 判断运行环境），这里只按白名单拷文件。
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'dist', 'pages');

export const PAGES_FILES = Object.freeze([
  'index.html', 'site.css', 'site.js',
  'viewer.html', 'viewer.css', 'viewer', 'core', 'i18n', 'sw.js',
  'lib', 'icons', 'samples', 'docs/images',
]);

/** git 已跟踪的文件（相对路径）。 */
function trackedFiles(entry) {
  const out = execFileSync('git', ['ls-files', '-z', '--', entry], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/**
 * trackedOnly：只拷 git 已跟踪的文件（发布用，防止被 .gitignore 忽略的测试文件/截图被公开）；
 * 本地预览和测试用 false，新文件没提交也能看。
 */
export function build({ trackedOnly = false } = {}) {
  rmSync(OUT, { recursive: true, force: true });
  for (const entry of PAGES_FILES) {
    const src = join(ROOT, entry);
    if (!existsSync(src)) throw new Error(`缺少 ${entry}（先跑 npm run vendor / 截图脚本）`);
    if (trackedOnly) {
      const files = trackedFiles(entry);
      if (!files.length) throw new Error(`${entry} 没有提交到 git`);
      for (const file of files) {
        mkdirSync(dirname(join(OUT, file)), { recursive: true });
        cpSync(join(ROOT, file), join(OUT, file));
      }
      continue;
    }
    mkdirSync(dirname(join(OUT, entry)), { recursive: true });
    cpSync(src, join(OUT, entry), { recursive: true });
  }
  writeFileSync(join(OUT, '.nojekyll'), ''); // 不让 GitHub Pages 用 Jekyll 处理
  return OUT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`✓ 在线版已构建到 ${build()}`);
}
