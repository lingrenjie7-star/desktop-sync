/**
 * 删除远端文件的回归测试。
 *
 * 真实故障：界面显示「这些文件在远端已经不存在了」，但远端明明有。
 * 根因：界面列的是 origin/<branch> 的内容，删除时却用
 *       fs.existsSync(工作区路径) 判断 —— 当本地 HEAD 落后于 origin
 *       （或工作区没检出那个文件）时，就把「远端有」误判成「远端没有」。
 *
 * 这里用真实的 git 仓库复现这个场景，验证修复后能正确删除。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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

const { runGit } = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'core.mjs')).href);

/** 建一个最小的「远端 + 克隆」环境。 */
async function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwb-del-'));
  const remoteDir = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  const clone = path.join(base, 'clone');

  fs.mkdirSync(remoteDir, { recursive: true });
  await runGit(['init', '--bare', '-b', 'main', remoteDir]);

  // 在 work 里造初始内容并推到 remote
  fs.mkdirSync(work, { recursive: true });
  await runGit(['init', '-b', 'main'], { cwd: work });
  await runGit(['config', 'user.email', 't@t.local'], { cwd: work });
  await runGit(['config', 'user.name', 'test'], { cwd: work });

  fs.mkdirSync(path.join(work, 'dsh', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(work, 'dsh', 'sessions', 'a.jsonl'), 'session-a\n', 'utf8');
  fs.writeFileSync(path.join(work, 'README.md'), 'readme\n', 'utf8');

  await runGit(['add', '-A'], { cwd: work });
  await runGit(['commit', '-m', 'init'], { cwd: work });
  await runGit(['remote', 'add', 'origin', remoteDir], { cwd: work });
  await runGit(['push', '-u', 'origin', 'main'], { cwd: work });

  // clone：先拿到旧状态
  await runGit(['clone', remoteDir, clone]);

  return { base, remoteDir, work, clone };
}

async function cleanup(base) {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {}
}

console.log('复现故障场景');

await check('HEAD 落后于 origin 时，工作区里没有新文件（故障前提）', async () => {
  const fx = await makeFixture();
  try {
    // 远端再加一个文件
    fs.mkdirSync(path.join(fx.work, 'dsh', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(fx.work, 'dsh', 'sessions', 'b.jsonl'), 'session-b\n', 'utf8');
    await runGit(['add', '-A'], { cwd: fx.work });
    await runGit(['commit', '-m', 'add b'], { cwd: fx.work });
    await runGit(['push', 'origin', 'main'], { cwd: fx.work });

    // clone 只 fetch，不 reset —— 复现界面列表 vs 工作区不一致
    await runGit(['fetch', 'origin', 'main'], { cwd: fx.clone });

    const headFile = path.join(fx.clone, 'dsh', 'sessions', 'b.jsonl');
    assert.equal(fs.existsSync(headFile), false, '工作区不该有 b.jsonl（HEAD 落后）');

    // 但 git 里（origin/main）有
    const inGit = await runGit(['cat-file', '-e', 'origin/main:dsh/sessions/b.jsonl'], { cwd: fx.clone });
    assert.equal(inGit.ok, true, 'origin/main 里应该有 b.jsonl');
  } finally {
    await cleanup(fx.base);
  }
});

await check('修复方案：先 reset 到 origin，文件就出现了', async () => {
  const fx = await makeFixture();
  try {
    fs.writeFileSync(path.join(fx.work, 'dsh', 'sessions', 'b.jsonl'), 'session-b\n', 'utf8');
    await runGit(['add', '-A'], { cwd: fx.work });
    await runGit(['commit', '-m', 'add b'], { cwd: fx.work });
    await runGit(['push', 'origin', 'main'], { cwd: fx.work });

    await runGit(['fetch', 'origin', 'main'], { cwd: fx.clone });
    const before = fs.existsSync(path.join(fx.clone, 'dsh', 'sessions', 'b.jsonl'));
    assert.equal(before, false);

    // 修复里做的第一件事
    const reset = await runGit(['reset', '--hard', 'origin/main'], { cwd: fx.clone });
    assert.equal(reset.ok, true, `reset 失败: ${reset.stderr}`);

    const after = fs.existsSync(path.join(fx.clone, 'dsh', 'sessions', 'b.jsonl'));
    assert.equal(after, true, 'reset 之后文件应该出现在工作区');
  } finally {
    await cleanup(fx.base);
  }
});

await check('reset 后删除文件 → 能产生 git 变更并提交', async () => {
  const fx = await makeFixture();
  try {
    fs.writeFileSync(path.join(fx.work, 'dsh', 'sessions', 'b.jsonl'), 'session-b\n', 'utf8');
    await runGit(['add', '-A'], { cwd: fx.work });
    await runGit(['commit', '-m', 'add b'], { cwd: fx.work });
    await runGit(['push', 'origin', 'main'], { cwd: fx.work });

    await runGit(['fetch', 'origin', 'main'], { cwd: fx.clone });
    await runGit(['reset', '--hard', 'origin/main'], { cwd: fx.clone });
    await runGit(['config', 'user.email', 't@t.local'], { cwd: fx.clone });
    await runGit(['config', 'user.name', 'test'], { cwd: fx.clone });

    fs.rmSync(path.join(fx.clone, 'dsh', 'sessions', 'b.jsonl'), { force: true });
    await runGit(['add', '-A'], { cwd: fx.clone });
    const staged = await runGit(['diff', '--cached', '--name-only'], { cwd: fx.clone });
    assert.match(staged.stdout, /b\.jsonl/, `应该有一个删除待提交：${staged.stdout}`);

    const commit = await runGit(['commit', '-m', 'remove b'], { cwd: fx.clone });
    assert.equal(commit.ok, true, `commit 失败: ${commit.stderr}`);

    const push = await runGit(['push', 'origin', 'main'], { cwd: fx.clone });
    assert.equal(push.ok, true, `push 失败: ${push.stderr}`);

    // 验证远端真的没了
    const stillThere = await runGit(['cat-file', '-e', 'origin/main:dsh/sessions/b.jsonl'], { cwd: fx.clone });
    assert.equal(stillThere.ok, false, '推送后远端不该还有 b.jsonl');
  } finally {
    await cleanup(fx.base);
  }
});

console.log('源码契约');

const src = fs.readFileSync(path.join(ROOT, 'app', 'lib', 'browser.mjs'), 'utf8');
const delFn = src.slice(src.indexOf('export async function deleteRemoteFiles'));
const body = delFn.slice(0, delFn.indexOf('\n}\n') + 3);

await check('删除前必须先 reset 到 origin（保证工作区与远端一致）', () => {
  assert.match(body, /reset', '--hard'|reset["'],\s*["']--hard/, '缺少 reset --hard 对齐步骤');
});

await check('是否存在的判断必须用 git cat-file，而不是只看 fs.existsSync', () => {
  assert.match(body, /cat-file/, '没有用 git cat-file 判断文件是否在远端');
});

await check('不能再出现「只用 exists(target) 就判 missing」的写法', () => {
  // 旧 bug 的核心：if (!exists(target)) { missing.push(...) }
  const bad = /if\s*\(\s*!\s*exists\(\s*target\s*\)\s*\)\s*\{\s*missing\.push/;
  assert.ok(!bad.test(body), '仍存在「工作区没文件就判定远端没有」的旧逻辑');
});

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
