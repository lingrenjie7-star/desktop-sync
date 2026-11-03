/**
 * DSH 插件包自检：在真实 Node 环境里 import 产物，确认：
 *   1. 所有相对导入都能解析（自包含）；
 *   2. 宿主半边能拿到 apply / inject / name；
 *   3. core 能真正跑起来（bootstrap 不炸）；
 *   4. 浏览器半边是合法的模块加载器工厂。
 *
 * 跑法：<electron-as-node> tools/test-dsh-plugin.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PKG = path.join(ROOT, 'dist', 'dsh', 'dsh-dntb');

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

const url = (rel) => pathToFileURL(path.join(PKG, rel)).href;

console.log('产物结构');

await check('package.json 可解析，入口指向 lib/index.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
});

await check('cordis.patch.yml 的 id 与包名一致、且无行尾注释', () => {
  const text = fs.readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8');
  // 只找真正生效的行：YAML 列表项形如 `    - id: dsh-dntb`，跳过注释
  const line = text
    .split('\n')
    .find((l) => !l.trim().startsWith('#') && /^\s*(?:-\s*)?id:\s*\S/.test(l));
  assert.ok(line, '找不到生效的 id 行');
  // 商城预检用正则抓这一行，行尾注释会导致抓不到
  assert.match(line.trim(), /^-\s*id:\s*dsh-dntb$/, `id 行不合规：${JSON.stringify(line)}`);
});

await check('lib/client.js 是模块加载器工厂，不是普通 ESM', () => {
  const text = fs.readFileSync(path.join(PKG, 'lib', 'client.js'), 'utf8');
  assert.ok(text.includes('__ModuleLoader__.load'), '缺少 __ModuleLoader__.load');
  assert.ok(text.includes("id: 'dsh-dntb'"), 'loader id 必须等于包名');
  assert.ok(!/^\s*export\s/m.test(text), '浏览器半边不能有顶层 export');
});

console.log('宿主半边可加载');

const host = await import(url('lib/index.js'));

await check('导出 name / inject / apply', () => {
  assert.equal(host.name, 'dsh-dntb');
  assert.ok(typeof host.apply === 'function');
  assert.ok(host.inject, '缺少 inject 声明');
});

await check('inject 必须是字符串数组（写成对象会让插件永远 pending）', () => {
  // 这是实测踩过的坑：Cordis 的 inject 是 string[]，
  // 写成 { required: [...], optional: [...] } 时 Loader 会判为
  // 「waiting for services: required, optional」，插件静默不激活。
  assert.ok(Array.isArray(host.inject), `inject 不是数组，而是 ${typeof host.inject}`);
  assert.ok(host.inject.every((s) => typeof s === 'string'), 'inject 里有非字符串元素');
  assert.ok(host.inject.includes('webServer'), 'inject 里没有 webServer');
});

await check('没有 webServer 时 apply 不崩，只告警', () => {
  const warnings = [];
  const fakeCtx = {
    get: () => undefined,
    effect: () => () => {},
  };
  // apply 应该优雅退出而不是抛错
  const result = host.apply(fakeCtx, {});
  assert.ok(result === undefined || typeof result === 'function');
});

console.log('核心真的能跑');

await check('在临时目录里 bootstrap（不碰用户的真实配置）', async () => {
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwb-plugin-test-'));
  try {
    const core = await import(url('lib/plugin-core.mjs'));
    const instance = core.createSyncCore({ home: tmp, platform: 'test' });
    const info = instance.bootstrap();
    assert.equal(info.ok, true);
    assert.equal(info.hasToken, false, '全新目录不该有令牌');
    assert.equal(info.encryptionAvailable, false, '没有 crypto 后端时必须如实报告');
    // 全新目录应该生成了 config.json
    assert.ok(fs.existsSync(path.join(tmp, 'config.json')), '没有生成配置文件');
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
    assert.deepEqual(saved.repos, [], '新配置不该有仓库');
    assert.equal(saved.github.login, '', '新配置不该有登录信息');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check('诊断信息报告 plain 令牌模式', async () => {
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwb-plugin-test-'));
  try {
    const core = await import(url('lib/plugin-core.mjs'));
    const instance = core.createSyncCore({ home: tmp, platform: 'test' });
    const diag = instance.diagnostics();
    assert.equal(diag.platform, 'test');
    assert.equal(diag.encryptionAvailable, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check('引擎模块全部可 import（内联没有漏文件）', async () => {
  for (const rel of [
    'lib/vendor/core.mjs',
    'lib/vendor/engine.mjs',
    'lib/vendor/github.mjs',
    'lib/vendor/discover.mjs',
    'lib/vendor/identity.mjs',
    'lib/vendor/browser.mjs',
    'lib/vendor/storage.mjs',
    'lib/vendor/sources/index.mjs',
  ]) {
    await import(url(rel));
  }
});

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
