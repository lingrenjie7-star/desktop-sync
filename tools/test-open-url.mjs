/**
 * 打开链接行为的回归测试。
 *
 * 真实故障：仓库卡片点「打开」没反应。
 * 根因有两层：
 *   1. 本机登记的仓库对象里**没有 `fullName` 字段**（normalizeRepo 不产出它），
 *      于是 `repo.htmlUrl || \`https://github.com/${repo.fullName}\`` 拼出
 *      `https://github.com/undefined` —— shell.openExternal 打不开这种地址；
 *   2. 主进程 `openUrl` 永远返回 `{ ok: true }`，前端也不看返回值，
 *      所以失败时界面上一点提示都没有，表现为「点了没反应」。
 *
 * 这个测试用纯逻辑校验「给定各种仓库对象，应该拼出什么 URL」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const UI = path.join(ROOT, 'app', 'ui', 'app.js');
const MAIN = path.join(ROOT, 'app', 'main.mjs');

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

/** 前端应该用来得到 URL 的唯一正确写法。 */
function repoUrl(repo) {
  if (repo?.htmlUrl) return repo.htmlUrl;
  if (repo?.owner && repo?.repoName) return `https://github.com/${repo.owner}/${repo.repoName}`;
  // 远端卡片用的是 name（GitHub 的仓库名），不是 repoName
  if (repo?.owner && repo?.name) return `https://github.com/${repo.owner}/${repo.name}`;
  if (repo?.fullName) return `https://github.com/${repo.fullName}`;
  return '';
}

console.log('URL 拼装');

check('本机仓库（有 htmlUrl）→ 用 htmlUrl', () => {
  assert.equal(
    repoUrl({ htmlUrl: 'https://github.com/me/x', owner: 'me', repoName: 'x' }),
    'https://github.com/me/x',
  );
});

check('本机仓库（无 htmlUrl）→ 用 owner/repoName', () => {
  assert.equal(repoUrl({ owner: 'me', repoName: 'x' }), 'https://github.com/me/x');
});

check('远端卡片（只有 name，没有 repoName）→ 用 owner/name', () => {
  assert.equal(repoUrl({ owner: 'me', name: 'x', fullName: 'me/x' }), 'https://github.com/me/x');
});

check('只有 fullName → 也能拼出来', () => {
  assert.equal(repoUrl({ fullName: 'me/x' }), 'https://github.com/me/x');
});

check('什么都没有 → 返回空，由界面提示而不是打开一个坏地址', () => {
  assert.equal(repoUrl({}), '');
});

check('绝不产出 https://github.com/undefined', () => {
  const shapes = [
    { owner: 'me', repoName: 'x' },
    { owner: 'me', name: 'x' },
    { fullName: 'me/x' },
    {},
    { htmlUrl: '' },
  ];
  for (const shape of shapes) {
    const url = repoUrl(shape);
    assert.ok(!/undefined|null|\[object/.test(url), `拼出了坏地址：${url}`);
  }
});

console.log('源码约束（防止回退）');

const uiSource = fs.readFileSync(UI, 'utf8');
const mainSource = fs.readFileSync(MAIN, 'utf8');

check('UI 里不能再出现 fullName 作为唯一兜底', () => {
  // 旧写法：repo.htmlUrl || `https://github.com/${repo.fullName}`
  const bad = /\|\|\s*`https:\/\/github\.com\/\$\{repo\.fullName\}`/;
  assert.ok(!bad.test(uiSource), 'app.js 里仍有「只用 fullName 兜底」的写法');
});

check('UI 里必须有一处统一的 repoUrl 帮助函数', () => {
  assert.match(uiSource, /function\n?\s*repoUrl\(|const repoUrl\s*=/, 'app.js 缺少统一的 repoUrl()');
});

check('主进程 openUrl 必须校验 url 并回报失败', () => {
  const start = mainSource.indexOf("ipcMain.handle('github:openUrl'");
  assert.ok(start >= 0, '找不到 openUrl 处理函数');
  const handler = mainSource.slice(start, start + 1200);

  assert.match(handler, /try\s*\{/, 'openUrl 没有 try，失败会静默');
  assert.match(handler, /catch/, 'openUrl 没有 catch');
  assert.match(handler, /ok:\s*false/, 'openUrl 从不上报失败，前端无法提示用户');
  assert.match(handler, /\^https\?:/, 'openUrl 没有校验协议，非网页地址也会被交给系统');
  assert.match(handler, /openExternal/, 'openUrl 没有调用 openExternal');
});

check('UI 打开链接失败时要给用户提示', () => {
  const start = uiSource.indexOf('async function openRepoUrl');
  assert.ok(start >= 0, 'app.js 缺少 openRepoUrl()');
  const fn = uiSource.slice(start, start + 700);
  assert.match(fn, /result\.ok === false|!result\.ok/, 'openRepoUrl 没有检查返回值');
  assert.match(fn, /toast\(/, 'openRepoUrl 失败时没有提示用户');
});

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
