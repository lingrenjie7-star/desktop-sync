/**
 * 刷新行为的回归测试。
 *
 * 真实故障（用户报的）：
 *   1. 删除仓库后界面不刷新，云端已删但卡片还在；
 *      再点删除 → 404 被当成「删除失败」→ 弹「云端删除失败」，
 *      用户以为云端还在，其实早没了。
 *   2. 从别的页面切回仓库页不刷新（旧条件 `!state.remote` 让它只扫一次）。
 *   3. 删除后立刻重扫会把「GitHub 上还在的仓库」自动登记回来 → 看起来「删了还在」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const UI = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'app.js'), 'utf8');
const GH = fs.readFileSync(path.join(ROOT, 'app', 'lib', 'github.mjs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'index.html'), 'utf8');

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

console.log('404 = 已经删掉了，不是失败');

check('deleteRepo 把 404 当成功（alreadyGone）', () => {
  const start = GH.indexOf('export async function deleteRepo');
  const fn = GH.slice(start, start + 1200);
  assert.match(fn, /404/, '没有处理 404');
  assert.match(fn, /ok:\s*true[\s\S]{0,40}alreadyGone|alreadyGone:\s*true/, '404 没有返回 ok:true + alreadyGone');
});

check('界面用 alreadyGone 给出不同的提示，而不是报错弹窗', () => {
  assert.match(UI, /alreadyGone/, '界面没有使用 alreadyGone');
});

console.log('切页必须刷新');

check('showView 进仓库页时不再有「扫过就不扫」的条件', () => {
  // 旧代码：if (state.bootstrap?.hasToken && !state.remote && !state.remoteBusy)
  const bad = /hasToken\s*&&\s*!state\.remote\s*&&\s*!state\.remoteBusy/;
  assert.ok(!bad.test(UI), '仍有 !state.remote 导致只扫一次');
});

check('进仓库页总会触发 refreshRemote', () => {
  const start = UI.indexOf('function showView');
  const fn = UI.slice(start, start + 2400);
  assert.match(fn, /refreshRemote\(\{\s*silent:\s*true\s*\}\)/, 'showView 里没有自动刷新');
});

check('刷新按钮文案是「刷新」而不是「扫描 GitHub」', () => {
  assert.match(HTML, /id="scan-remote">刷新</, '按钮文案没改');
});

check('界面上有「上次刷新时间」的位置', () => {
  assert.match(HTML, /id="repo-freshness"/, '缺少新鲜度指示');
  assert.match(UI, /已刷新 /, '没有渲染刷新时间');
});

console.log('删除后不能被自动登记回来');

check('removeRepo 之后走 afterRepoRemoved，且不重扫远端', () => {
  assert.match(UI, /afterRepoRemoved/, '缺少统一的后处理');
  const start = UI.indexOf('async function afterRepoRemoved');
  assert.ok(start >= 0, '找不到 afterRepoRemoved');
  const fn = UI.slice(start, start + 900);
  assert.match(fn, /refreshRepos\(\{\s*remote:\s*false\s*\}\)/, '删除后不该再扫远端（会把仓库自动加回来）');
  assert.ok(!/refreshRemote\(/.test(fn), 'afterRepoRemoved 里不该调用 refreshRemote');
});

check('云端已删时清掉远端缓存，避免卡片残留', () => {
  const start = UI.indexOf('async function afterRepoRemoved');
  const fn = UI.slice(start, start + 900);
  assert.match(fn, /state\.remote\s*=\s*null/, '没有作废远端扫描结果');
});

check('removeRepo 的所有分支都走 afterRepoRemoved', () => {
  const start = UI.indexOf('async function removeRepo');
  const end = UI.indexOf('async function afterRepoRemoved');
  const fn = UI.slice(start, end);
  const calls = (fn.match(/afterRepoRemoved\(/g) ?? []).length;
  assert.equal(calls, 3, `三个分支（云端失败/云端成功/只删本机）都要调用，实际 ${calls} 次`);
});

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
