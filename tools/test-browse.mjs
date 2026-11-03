/**
 * 用本地 bare 仓库验证「远端内容」的完整链路（不依赖 GitHub）。
 *
 * 覆盖：browseRemote 读层级、compareFile 对比、deleteRemoteFiles 删除。
 * 这些都跑真实的 git，不是 mock。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const { Engine } = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'engine.mjs')).href);
const { browseRemote, compareFile, deleteRemoteFiles } = await import(
  pathToFileURL(path.join(ROOT, 'app', 'lib', 'browser.mjs')).href
);
const { runGit } = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'core.mjs')).href);
const { normalizeConfig, defaultConfig } = await import(
  pathToFileURL(path.join(ROOT, 'app', 'lib', 'engine.mjs')).href
);

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

/** 建一个 bare 远端 + 一份带内容的初始提交。 */
async function makeRemote() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwb-browse-'));
  const remote = path.join(base, 'remote.git');
  const work = path.join(base, 'work');

  await runGit(['init', '--bare', '-b', 'main', remote]);
  fs.mkdirSync(path.join(work, 'dsh', 'storages'), { recursive: true });
  fs.mkdirSync(path.join(work, 'dsh', 'sessions'), { recursive: true });
  await runGit(['init', '-b', 'main'], { cwd: work });
  await runGit(['config', 'user.email', 't@t.local'], { cwd: work });
  await runGit(['config', 'user.name', 'test'], { cwd: work });

  fs.writeFileSync(
    path.join(work, 'dsh', 'storages', 'workspace.json'),
    JSON.stringify({ tables: { workspaces: { ws1: { title: '演示工作区', path: '@ws/demo', sessionIds: ['a'] } } } }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(work, 'dsh', 'sessions', 'a.jsonl'),
    JSON.stringify({ id: 'a', cwd: '@ws/demo' }) + '\n' + JSON.stringify({ type: 'user/message', seq: 1, data: { text: '你好' } }) + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(work, 'dshwb-sync.json'), JSON.stringify({ repo: { source: 'dsh' } }), 'utf8');

  await runGit(['add', '-A'], { cwd: work });
  await runGit(['commit', '-m', 'init'], { cwd: work });
  await runGit(['remote', 'add', 'origin', remote], { cwd: work });
  await runGit(['push', '-u', 'origin', 'main'], { cwd: work });

  return { base, remote, work };
}

function makeEngine(base, repo) {
  const config = normalizeConfig(defaultConfig());
  config.repos = [repo];
  // 代理留空：本地 bare 仓库不需要网络
  config.proxy = '';
  return new Engine({ config, token: '', stateDir: base, onProgress: () => {} });
}

console.log('读取远端内容');

const fx = await makeRemote();
const cacheDir = path.join(fx.base, 'cache');
const repo = {
  id: 'test-repo',
  name: '测试仓库',
  owner: 'local',
  repoName: 'remote',
  branch: 'main',
  private: true,
  source: 'dsh',
  cacheDir,
  htmlUrl: '',
  // 夹具用本地 bare 仓库；normalizeRepo 会保留这个字段
  remoteUrl: fx.remote,
};
const engine = makeEngine(fx.base, repo);

let listed;
await check('能克隆并读出层级（工作区 → 对话）', async () => {
  listed = await browseRemote({ engine, repo, query: '' });
  assert.equal(listed.ok, true, `读取失败：${listed.error}`);
  assert.ok(listed.containers.length > 0, '没有任何分组');
  const demo = listed.containers.find((c) => c.label === '演示工作区');
  assert.ok(demo, `找不到「演示工作区」，实际：${listed.containers.map((c) => c.label).join(', ')}`);
  assert.equal(demo.items.length, 1, '工作区里应该有 1 个对话');
});

await check('对比：本机没有这个文件时标为「仅远端」', async () => {
  const found = listed.containers.flatMap((c) => c.items).find((i) => i.path.includes('a.jsonl'));
  assert.ok(found, '找不到会话文件');
  assert.equal(found.state, 'remote-only', `状态不对：${found.state}`);
});

await check('删除远端文件能成功', async () => {
  const target = listed.containers.flatMap((c) => c.items).find((i) => i.path.includes('a.jsonl'));
  const r = await deleteRemoteFiles({ engine, repo, relPaths: [target.path] });
  assert.equal(r.ok, true, `删除失败：${r.error}`);
  assert.equal(r.removed, 1);
  assert.equal(r.pushed, true, '应该推送成功');

  // 远端真的没了吗
  const after = await runGit(['cat-file', '-e', `main:${target.path}`], { cwd: fx.remote });
  assert.equal(after.ok, false, '删除后远端不该还有这个文件');
});

await check('删除后重新读取，内容确实少了', async () => {
  const again = await browseRemote({ engine, repo, query: '' });
  assert.equal(again.ok, true, `读取失败：${again.error}`);
  const paths = again.containers.flatMap((c) => c.items).map((i) => i.path);
  assert.ok(!paths.some((p) => p.includes('a.jsonl')), '删除后不该还能读到 a.jsonl');
});

console.log('缓存自愈');

await check('残缺的 .git 会被识别为「不健康」并重建', async () => {
  // 故意破坏缓存：删掉 HEAD（这是 .git 里最关键的指针）
  const headFile = path.join(cacheDir, '.git', 'HEAD');
  assert.ok(fs.existsSync(headFile), '前置条件：应该有 HEAD');
  fs.rmSync(headFile, { force: true });

  const session = engine.repoSession(repo);
  const healthy = await session.gitHealthy();
  assert.equal(healthy, false, '缺少 HEAD 应该被判为不健康');

  // ensure 应该重建它
  const prepared = await session.ensure();
  assert.equal(prepared.ok, true, `重建失败：${prepared.error}`);
  assert.equal(await session.gitHealthy(), true, '重建后应该是健康的');
});

await check('重建后还能正常读远端内容', async () => {
  const again = await browseRemote({ engine, repo, query: '' });
  assert.equal(again.ok, true, `读取失败：${again.error}`);
  // 注意：前面的删除测试已经把会话文件删了，所以这里只要求「能读通」，
  // 不要求还有会话条目（工作区登记表还在，分组应该还在）
  assert.ok(Array.isArray(again.containers), '返回值不是数组');
});

try {
  fs.rmSync(fx.base, { recursive: true, force: true });
} catch {}

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
