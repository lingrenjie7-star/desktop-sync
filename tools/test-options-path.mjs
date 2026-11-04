/**
 * 回归测试：软件数据目录不在默认位置时，仍然能配置。
 *
 * 真实故障：DSH 数据目录不是 ~/.dsh 时，detect() 判定「没安装」，
 * 插件选项页只遍历 installed → 那一行不显示 → 用户哪里都改不了路径 →
 * DSH 功能永久不可用。
 *
 * 这里用真实的引擎 + 假配置复现这个场景，验证：
 *   1. detect 确实判为「没安装」
 *   2. options 页遍历的是全部 sources，不是 installed
 *   3. 把路径改对之后，重新检测能恢复
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const { Engine, normalizeConfig, defaultConfig } = await import(
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwb-opt-'));

/** 造一个可用的 DSH 主目录（有 sessions + storages）。 */
function makeDshHome(root) {
  fs.mkdirSync(path.join(root, 'storages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'storages', 'workspace.json'),
    JSON.stringify({ unit: {}, global: { workspaceIds: [] }, tables: { workspaces: {} } }, null, 2),
    'utf8',
  );
  return root;
}

const realDsh = makeDshHome(path.join(base, 'real-dsh'));
const bogusDsh = path.join(base, 'not-here', 'dsh');

function engineWith(homePath) {
  const config = normalizeConfig(defaultConfig());
  config.softwareHome.dsh = homePath;
  config.workspaceRoot.dsh = path.join(base, 'workspaces');
  config.repos = [];
  config.proxy = '';
  return new Engine({ config, token: '', stateDir: path.join(base, 'state'), onProgress: () => {} });
}

console.log('场景：数据目录指到不存在的位置');

await check('detect 把错误路径判为「没安装」，并给出原因', async () => {
  const sources = await engineWith(bogusDsh).inspect();
  const dsh = sources.find((s) => s.id === 'dsh');
  assert.ok(dsh, '找不到 dsh 源');
  assert.equal(dsh.installed, false, '错误路径不该被判为已安装');
  assert.ok(dsh.detail, '应该有一个 detail 说明原因');
  console.log(`       detail = ${dsh.detail}`);
});

await check('inspect 仍然返回 dsh（不会因为没安装就把它丢掉）', async () => {
  const sources = await engineWith(bogusDsh).inspect();
  const ids = sources.map((s) => s.id);
  assert.ok(ids.includes('dsh'), `inspect 结果里没有 dsh：${ids.join(', ')}`);
});

await check('路径改对之后，重新检测能恢复正常', async () => {
  const sources = await engineWith(realDsh).inspect();
  const dsh = sources.find((s) => s.id === 'dsh');
  assert.equal(dsh.installed, true, `改对路径后应该能检测到：${dsh.detail}`);
});

console.log('源码契约：选项页必须遍历全部 sources');

const panel = fs.readFileSync(path.join(ROOT, 'plugins', 'shared', 'panel.js'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'app.js'), 'utf8');

await check('插件选项页用的是 sources，不是 installed', () => {
  const start = panel.indexOf('function renderOptions');
  assert.ok(start >= 0, '找不到 renderOptions');
  const fn = panel.slice(start, start + 4000);
  assert.match(fn, /\.\.\.sources\.map\(/, 'renderOptions 应该遍历 sources');
  assert.ok(
    !/\.\.\.installed\.map\(/.test(fn),
    'renderOptions 不能只遍历 installed —— 未检测到的软件会消失，路径就改不了',
  );
});

await check('插件选项页给未检测到的软件标了提示', () => {
  const start = panel.indexOf('function renderOptions');
  const fn = panel.slice(start, start + 4000);
  assert.match(fn, /未检测到/, '缺少「未检测到」标记');
  assert.match(fn, /softwareHome/, '缺少数据目录入口');
});

await check('桌面端选项页也遍历全部 sources，并有未检测到标记', () => {
  const start = appJs.indexOf('function renderPaths()');
  assert.ok(start >= 0, '找不到 renderPaths');
  const fn = appJs.slice(start, start + 3000);
  assert.match(fn, /for \(const source of state\.sources\)/, '应该遍历 state.sources');
  assert.match(fn, /未检测到/, '缺少「未检测到」标记');
});

try {
  fs.rmSync(base, { recursive: true, force: true });
} catch {}

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
