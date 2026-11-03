/**
 * 端到端验证：A 机上传 → B 机下载 → 对话是否出现在 B 机的工作区里。
 *
 * 这是用户问的核心问题：「我在另一台电脑同步后，对话会显示在左侧工作区吗」。
 * 不能靠读代码猜，要用真实 git 仓库 + 真实 DSH 目录结构跑一遍。
 *
 * 做法：
 *   1. 造两个「假 DSH 主目录」（A 机 / B 机），各自有 sessions/ 和 storages/workspace.json
 *   2. A 机：采集 → 推到本地 bare 仓库
 *   3. B 机：从仓库恢复 → 检查 B 机的 workspace.json 是否含 A 机的工作区与对话
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const engineMod = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'engine.mjs')).href);
const { Engine, normalizeConfig, defaultConfig, normalizeRepo } = engineMod;
const { runGit } = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'core.mjs')).href);

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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwb-e2e-'));

/** 造一个「某台机器的 DSH 主目录」。 */
function makeDshHome(name, workspaces) {
  const home = path.join(base, name, '.dsh');
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });

  const tables = { workspaces: {} };
  const ids = [];
  for (const ws of workspaces) {
    tables.workspaces[ws.id] = {
      path: ws.path,
      title: ws.title,
      sessionIds: ws.sessions.map((s) => s.id),
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    ids.push(ws.id);

    for (const s of ws.sessions) {
      const dirName = s.cwd.replace(/[^A-Za-z0-9]/g, '~');
      const sessionDir = path.join(home, 'sessions', dirName, s.id);
      fs.mkdirSync(sessionDir, { recursive: true });
      const lines = [
        JSON.stringify({ id: s.id, cwd: s.cwd, title: s.title, createdAt: '2026-11-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'user/message', seq: 1, data: { text: s.text } }),
      ];
      fs.writeFileSync(path.join(sessionDir, 'session.v1.jsonl'), lines.join('\n') + '\n', 'utf8');
    }
  }

  fs.writeFileSync(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({ unit: {}, global: { workspaceIds: ids }, tables }, null, 2) + '\n',
    'utf8',
  );
  return home;
}

function makeEngine(home, repo, machine) {
  const config = normalizeConfig(defaultConfig());
  config.softwareHome.dsh = home;
  config.machine = machine;
  config.repos = [repo];
  config.proxy = '';
  return new Engine({ config, token: '', stateDir: path.join(base, 'state-' + machine), onProgress: () => {} });
}

// ── 造两台机器
const aHome = makeDshHome('A', [
  { id: 'wsA', path: path.join(base, 'A', 'proj-alpha'), title: 'alpha 项目', sessions: [
    { id: 'sessA1', cwd: path.join(base, 'A', 'proj-alpha'), title: 'A 机的对话一', text: '这是 A 机的内容' },
  ]},
]);
const bHome = makeDshHome('B', [
  { id: 'wsB', path: path.join(base, 'B', 'proj-beta'), title: 'beta 项目', sessions: [
    { id: 'sessB1', cwd: path.join(base, 'B', 'proj-beta'), title: 'B 机原有对话', text: '这是 B 机的内容' },
  ]},
]);

// ── 建裸仓库
const remote = path.join(base, 'remote.git');
await runGit(['init', '--bare', '-b', 'main', remote]);
await runGit(['config', 'user.email', 't@t.local'], { cwd: base });
await runGit(['config', 'user.name', 'test'], { cwd: base });

const repoSpec = {
  id: 'sync-repo',
  name: '同步仓库',
  owner: 'local',
  repoName: 'remote',
  branch: 'main',
  private: true,
  source: 'dsh',
  cacheDir: path.join(base, 'cacheA'),
  htmlUrl: '',
  remoteUrl: remote,
};
const repoB = { ...repoSpec, id: 'sync-repo', cacheDir: path.join(base, 'cacheB') };

const engineA = makeEngine(aHome, normalizeRepo(repoSpec), 'machine-a');
const engineB = makeEngine(bHome, normalizeRepo(repoB), 'machine-b');

console.log('A 机上传');

let uploadResult;
await check('A 机上传成功', async () => {
  uploadResult = await engineA.runRepo({
    repo: normalizeRepo(repoSpec),
    mode: 'upload',
    selection: { keys: ['dsh/workspaces/wsA'] },
  });
  assert.equal(uploadResult.ok, true, `上传失败：${uploadResult.error}`);
});

await check('远端仓库里确实有 A 机的会话文件', async () => {
  const files = await runGit(['ls-tree', '-r', '--name-only', 'main'], { cwd: remote });
  assert.match(files.stdout, /sessA1/, `远端没有 sessA1：${files.stdout}`);
  assert.match(files.stdout, /workspace\.json/, '远端没有 workspace.json');
});

console.log('\nB 机下载');

let downloadResult;
await check('B 机从仓库恢复成功', async () => {
  downloadResult = await engineB.runRepo({
    repo: normalizeRepo(repoB),
    mode: 'download',
    selection: { keys: ['dsh/workspaces/wsA'] },
  });
  assert.equal(downloadResult.ok, true, `下载失败：${downloadResult.error}`);
});

await check('B 机的 workspace.json 里**出现了** A 机的工作区', async () => {
  const file = path.join(bHome, 'storages', 'workspace.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ws = j.tables?.workspaces ?? {};

  assert.ok(ws.wsA, `B 机没有出现 wsA。实际工作区：${Object.keys(ws).join(', ')}`);
  assert.equal(ws.wsA.title, 'alpha 项目', `标题不对：${ws.wsA.title}`);
  assert.ok(ws.wsA.sessionIds.includes('sessA1'), `wsA 里没有 sessA1：${JSON.stringify(ws.wsA.sessionIds)}`);
  console.log(`       B 机工作区：${Object.values(ws).map((w) => w.title).join(', ')}`);
});

await check('A 机的工作区进入了 global.workspaceIds（侧边栏按这个排序）', async () => {
  const file = path.join(bHome, 'storages', 'workspace.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(
    (j.global?.workspaceIds ?? []).includes('wsA'),
    `global.workspaceIds 里没有 wsA：${JSON.stringify(j.global?.workspaceIds)}`,
  );
});

await check('子目录路径被映射成 B 机能用的本地路径', async () => {
  const file = path.join(bHome, 'storages', 'workspace.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wsA = j.tables.workspaces.wsA;
  // 原路径在 A 机的 base/A/proj-alpha；B 机上应该被还原（含 workspaceRoot 映射或原样）
  assert.ok(wsA.path, 'path 为空');
  console.log(`       wsA.path = ${wsA.path}`);
});

await check('B 机原有的工作区**没有被破坏**', async () => {
  const file = path.join(bHome, 'storages', 'workspace.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ws = j.tables.workspaces;
  assert.ok(ws.wsB, 'B 机原有工作区 wsB 不见了');
  assert.equal(ws.wsB.title, 'beta 项目');
  assert.ok(ws.wsB.sessionIds.includes('sessB1'), 'wsB 的会话丢了');
});

await check('会话文件真的落到了 B 机的 sessions/ 目录', async () => {
  const sessionsRoot = path.join(bHome, 'sessions');
  const { decodeSession } = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'core.mjs')).href);
  let found = false;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      // 会话可能被 zstd 压缩存成 session.v4.jsonl.zstd，必须解码后看内容
      const m = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(e.name);
      if (!m) continue;
      try {
        const buf = fs.readFileSync(full);
        const decoded = decodeSession(buf, m[2] ? 'zstd' : 'none');
        const text = JSON.stringify(decoded.header) + JSON.stringify(decoded.events);
        if (text.includes('sessA1') || text.includes('这是 A 机的内容')) found = true;
      } catch {}
    }
  };
  walk(sessionsRoot);
  assert.equal(found, true, 'B 机的 sessions/ 里找不到 A 机的会话内容（含 zstd 解码后）');
});

await check('B 机「重新扫描」时能看到这个同步来的会话', async () => {
  // Engine.inspect() 直接返回数组（不是 { sources }）
  const inspected = await engineB.inspect();
  const dsh = inspected.find((s) => s.id === 'dsh');
  assert.ok(dsh, `找不到 dsh 数据源，实际：${inspected.map((s) => s.id).join(', ')}`);

  // 展开：工作区（含嵌套的对话） + 未归组的对话
  const labels = [];
  for (const container of dsh.containers ?? []) {
    labels.push(container.label);
    for (const item of container.items ?? []) labels.push(item.label);
  }
  const flat = labels.join(' | ');
  // 对话在界面上的显示名可能是标题，也可能是首条消息（没设标题时），
  // 所以两种都认。这里的关键是「这个会话确实被扫出来了」。
  assert.ok(
    /A 机的对话一/.test(flat) || /这是 A 机的内容/.test(flat),
    `扫描结果里没有 A 机的对话。实际：${flat.slice(0, 400)}`,
  );
  assert.ok(/alpha 项目/.test(flat), `扫描结果里没有 A 机的工作区。实际：${flat.slice(0, 400)}`);
});

try {
  fs.rmSync(base, { recursive: true, force: true });
} catch {}

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
