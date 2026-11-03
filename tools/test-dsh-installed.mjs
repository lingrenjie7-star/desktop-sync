/**
 * DSH 插件「装机后能否被 DSH 加载」的真实检查。
 *
 * 前面测的是「构建产物自身是否健康」；这里测的是
 * 「装进 profile 之后，按 DSH 的模块解析规则还能不能 require 到」。
 *
 * 检查点：
 *   1. profile/package.json 里声明了 bundle 和依赖；
 *   2. profile/cordis.patch.yml 里有这个插件的行；
 *   3. host 入口能 require 通（相对路径全部可解析）；
 *   4. client 入口能被模块加载器识别（有 __ModuleLoader__.load）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const PKG = path.join(PROFILE, 'node_modules', 'dsh-dntb');

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

console.log('安装位置');

await check('插件已复制到 profile 的 node_modules', () => {
  assert.ok(fs.existsSync(PKG), '插件目录不存在');
});

await check('profile/package.json 声明了 bundle', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  assert.ok(bundles.includes('dsh-dntb'), `bundles 里没有 dsh-dntb：${bundles.join(', ')}`);
  assert.ok(pkg.dependencies?.['dsh-dntb'], 'dependencies 里没有声明');
});

await check('profile/cordis.patch.yml 里有插件行', () => {
  const patch = fs.readFileSync(path.join(PROFILE, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /-\s*id:\s*dsh-dntb/, 'patch 里没有 dsh-dntb 行');
  assert.match(patch, /name:\s*dsh-dntb/, 'patch 里没有 name: dsh-dntb');
});

console.log('模块解析');

await check('经过 profile 的模块解析也能找到宿主入口', () => {
  const resolved = require.resolve(path.join(PKG, 'lib', 'index.js'));
  assert.ok(resolved);
});

await check('宿主入口 require 不报错（内联的引擎都能找到）', () => {
  // 用真实 require 走一遍：任何相对路径写错都会在这里炸
  const mod = require(path.join(PKG, 'lib', 'index.js'));
  assert.equal(mod.name, 'dsh-dntb');
  assert.equal(typeof mod.apply, 'function');
});

await check('浏览器半边有模块加载器注册', () => {
  const code = fs.readFileSync(path.join(PKG, 'lib', 'client.js'), 'utf8');
  assert.ok(code.includes('__ModuleLoader__.load'), '缺少 __ModuleLoader__.load');
  assert.ok(code.includes("id: 'dsh-dntb'"), 'loader id 与包名不一致');
});

await check('cordis.patch.yml 的 id 行不带行尾注释', () => {
  const patch = fs.readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8');
  const line = patch.split('\n').find((l) => !l.trim().startsWith('#') && /^\s*-\s*id:\s*\S/.test(l));
  assert.ok(line);
  assert.match(line.trim(), /^-\s*id:\s*dsh-dntb$/, `id 行不合规：${JSON.stringify(line)}`);
});

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
