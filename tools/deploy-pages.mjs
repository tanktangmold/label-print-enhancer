// 发布在线版到 GitHub Pages：npm run pages:deploy
// 构建 dist/pages/ → 作为 gh-pages 分支强推到 origin（只含网站文件，不影响 main）。推送后 Pages 自动开启/更新。
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, OUT } from './build-pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

const remote = git(['remote', 'get-url', 'origin'], ROOT);
const name = git(['config', 'user.name'], ROOT);
const email = git(['config', 'user.email'], ROOT);
const sha = git(['rev-parse', '--short', 'HEAD'], ROOT);
if (git(['status', '--porcelain'], ROOT)) {
  console.error('工作区有未提交的改动，先提交再发布（发布内容要和提交一致）');
  process.exit(1);
}

build({ trackedOnly: true });
rmSync(join(OUT, '.git'), { recursive: true, force: true });
git(['init', '-q', '-b', 'gh-pages'], OUT);
git(['-c', 'core.autocrlf=false', 'add', '-A'], OUT);
git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `deploy: web version built from ${sha}`], OUT);
git(['push', '-q', '-f', remote, 'gh-pages'], OUT);
console.log(`在线版已推送到 ${remote} 的 gh-pages 分支（来自 ${sha}）`);
