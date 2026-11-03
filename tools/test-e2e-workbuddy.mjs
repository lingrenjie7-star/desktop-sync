/**
 * WorkBuddy 跨机同步验证：A 机上传 → B 机下载 → 会话是否进入 B 机的 workbuddy.db。
 *
 * 为什么单独测：WorkBuddy 的左侧栏读的是 sqlite（workbuddy.db），
 * 而不是文件目录。对话只把 .jsonl 文件放对位置是不够的 ——
 * 索引表里没有记录，界面上就是不显示。
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

const { Engine, normalizeConfig, defaultConfig, normalizeRepo } = await import(
  pathToFileURL(path.join(ROOT, 'app', 'lib', 'engine.mjs')).href
);
const { runGit } = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'core.mjs')).href);
const { readWorkbuddyIndex, sqliteAvailable } = await import(
  pathToFileURL(path.join(ROOT, 'app', 'lib', 'sources', 'workbuddy.mjs')).href
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

if (!sqliteAvailable()) {
  console.log('当前 node 没有 node:sqlite，无法测试 WorkBuddy 索引落地');
  process.exit(0);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwb-wb-'));

/** 造一个 WorkBuddy 主目录：workbuddy.db + projects/<slug>/<session>.jsonl */
function makeWbHome(name, projects) {
  const home = path.join(base, name, '.workbuddy');
  fs.mkdirSync(home, { recursive: true });

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'workbuddy.db'));
  // 用真实 WorkBuddy 的 sessions 列（mergeWorkbuddyIndex 会写 is_playground/unread/transport，
  // 少了这几列 insert 就会失败，而且异常会被上层吞掉，表现为「同步成功但没生效」）
  db.exec(`
    create table if not exists sessions (
      id text primary key, cwd text, user_id text, title text, custom_title text,
      status text, created_at integer, updated_at integer, last_activity_at integer,
      deleted_at integer, is_playground integer, source_mode text, mode text, model text,
      permission_mode text, thought_level text, transport text, unread integer
    );
    create table if not exists workspaces (
      path text primary key, last_opened_at integer
    );
  `);

  for (const p of projects) {
    db.prepare('insert or replace into workspaces (path, last_opened_at) values (?, ?)').run(p.cwd, Date.now());
    const slug = p.cwd.replace(/[^A-Za-z0-9]/g, '-');
    const dir = path.join(home, 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of p.sessions) {
      db.prepare(
        `insert or replace into sessions
         (id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at,
          deleted_at, is_playground, source_mode, mode, model, permission_mode, thought_level, transport, unread)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(s.id, p.cwd, 'u1', s.title, null, 'active', Date.now(), Date.now(), Date.now(),
        null, 0, 'chat', 'chat', 'test', 'default', 'high', 'local', 0);

      fs.writeFileSync(
        path.join(dir, `${s.id}.jsonl`),
        JSON.stringify({ type: 'user', message: { content: s.text } }) + '\n',
        'utf8',
      );
    }
  }
  db.close();
  return home;
}


function makeEngine(home, repo, machine) {
  const config = normalizeConfig(defaultConfig());
  config.softwareHome.workbuddy = home;
  config.machine = machine;
  config.repos = [repo];
  config.proxy = '';
  return new Engine({ config, token: '', stateDir: path.join(base, 'st-' + machine), onProgress: () => {} });
}

console.log('准备两台「电脑」');

const aHome = makeWbHome('A', [
  {
    cwd: path.join(base, 'A', 'proj-one'),
    sessions: [{ id: 'wb-sess-a1', title: 'WB 的对话一', text: '这是 A 机 WB 的内容' }],
  },
]);
const bHome = makeWbHome('B', [
  {
    cwd: path.join(base, 'B', 'proj-two'),
    sessions: [{ id: 'wb-sess-b1', title: 'B 机原有', text: 'B 机自己的内容' }],
  },
]);

const remote = path.join(base, 'remote.git');
await runGit(['init', '--bare', '-b', 'main', remote]);
await runGit(['config', 'user.email', 't@t.local'], { cwd: base });
await runGit(['config', 'user.name', 'test'], { cwd: base });

const repoA = normalizeRepo({
  id: 'wb', name: 'wb', owner: 'local', repoName: 'remote', branch: 'main',
  private: true, source: 'workbuddy', cacheDir: path.join(base, 'cacheA'), remoteUrl: remote,
});
const repoB = { ...repoA, cacheDir: path.join(base, 'cacheB') };

const engineA = makeEngine(aHome, repoA, 'machine-a');
const engineB = makeEngine(bHome, normalizeRepo(repoB), 'machine-b');

console.log('\nA 机上传');

await check('A 机扫描能看到自己的 WB 对话', async () => {
  const inspected = await engineA.inspect();
  const wb = inspected.find((s) => s.id === 'workbuddy');
  assert.ok(wb, '找不到 workbuddy 数据源');
  const flat = (wb.containers ?? []).flatMap((c) => [c.label, ...(c.items ?? []).map((i) => i.label)]).join(' | ');
  assert.match(flat, /WB 的对话一/, `扫描不到 A 机对话：${flat.slice(0, 300)}`);
});

let up;
await check('A 机上传成功', async () => {
  up = await engineA.runRepo({ repo: repoA, mode: 'upload', selection: { keys: null } });
  assert.equal(up.ok, true, `上传失败：${up.error}`);
});

await check('远端有 WB 的会话文件和索引', async () => {
  const files = await runGit(['ls-tree', '-r', '--name-only', 'main'], { cwd: remote });
  const list = files.stdout;
  assert.match(list, /workbuddy\/sessions\//, `远端没有 sessions：${list}`);
  assert.match(list, /workbuddy\/index\.json/, `远端没有 index.json：${list}`);
});

console.log('\nB 机下载');

let down;
await check('B 机下载成功', async () => {
  down = await engineB.runRepo({ repo: normalizeRepo(repoB), mode: 'download', selection: { keys: null } });
  assert.equal(down.ok, true, `下载失败：${down.error}`);
  console.log(`       applied: ${JSON.stringify(down.applied ?? down.steps ?? [])}`);
});

await check('A 机的会话进了 B 机的 workbuddy.db（左侧栏读的就是这个）', async () => {
  const idx = readWorkbuddyIndex(bHome);
  assert.ok(idx, '读不到 B 机的 workbuddy.db');
  const ids = idx.sessions.map((s) => s.id);
  assert.ok(ids.includes('wb-sess-a1'), `B 机 db 里没有 A 机的会话。实际：${ids.join(', ')}`);
});

await check('B 机原有的会话没被破坏', async () => {
  const idx = readWorkbuddyIndex(bHome);
  const ids = idx.sessions.map((s) => s.id);
  assert.ok(ids.includes('wb-sess-b1'), `B 机原有会话丢了。实际：${ids.join(', ')}`);
});

await check('B 机的 workspaces 表里出现了 A 机的项目目录', async () => {
  const idx = readWorkbuddyIndex(bHome);
  const paths = idx.workspaces.map((w) => w.path);
  const hit = paths.some((p) => /proj-one/.test(p));
  assert.ok(hit, `B 机 workspaces 里没有 A 机的项目。实际：${paths.join(', ')}`);
});

await check('B 机重新扫描能看到 A 机的对话', async () => {
  const inspected = await engineB.inspect();
  const wb = inspected.find((s) => s.id === 'workbuddy');
  const flat = (wb.containers ?? []).flatMap((c) => [c.label, ...(c.items ?? []).map((i) => i.label)]).join(' | ');
  assert.match(flat, /WB 的对话一|这是 A 机 WB 的内容/, `B 机扫描不到 A 机对话：${flat.slice(0, 400)}`);
});

try {
  fs.rmSync(base, { recursive: true, force: true });
} catch {}

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
