/**
 * WorkBuddy 扩展包自检：在真实 Node 里 require 产物，跑一遍 activate(wb)，
 * 然后像 UI 那样通过 HTTP 对话，最后 dispose。
 *
 * 这一关最重要 —— 前面的「构建成功」只说明文件拼对了，
 * 这里才验证扩展真的能被 WorkBuddy 加载并工作。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', 'dist', 'workbuddy', 'dshwb-sync');

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

console.log('产物结构');

await check('extension.json 符合 WorkBuddy 契约', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'extension.json'), 'utf8'));
  assert.equal(manifest.id, 'dshwb-sync');
  assert.ok(manifest.ui.entry.title, 'ui.entry 缺少 title（侧边栏显示名）');
  assert.ok(fs.existsSync(path.join(PKG, manifest.ui.entry.icon)), '图标文件不存在');
  assert.ok(manifest.ui.entry.url.endsWith('remoteEntry.js'), 'ui.entry.url 必须指向 remoteEntry.js');
  assert.equal(manifest.service.process, 'fork');
});

await check('UI 半边暴露的是联邦容器而不是普通脚本', () => {
  const code = fs.readFileSync(path.join(PKG, 'ui', 'assets', 'remoteEntry.js'), 'utf8');
  assert.ok(code.includes('get('), '没有暴露 get()');
  assert.ok(code.includes('init('), '没有暴露 init()');
  assert.ok(code.includes('./Main') || code.includes("'Main'") || code.includes('Main'), '没有处理 ./Main 请求');
});

console.log('后台服务可以真正启动');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ext-'));

const mod = require(path.join(PKG, 'server', 'index.cjs'));

await check('server/index.cjs 导出 activate', () => {
  assert.equal(typeof mod.activate, 'function', '没有导出 activate');
});

// 假的 wb 宿主对象，只提供扩展真正用到的那部分
const fakeWb = {
  paths: {
    userData: async () => userData,
  },
  invoke: async (channel) => {
    throw new Error(`未实现的通道：${channel}`);
  },
};

let handle;
await check('activate(wb) 能启动并返回 dispose', async () => {
  handle = await mod.activate(fakeWb);
  assert.ok(handle && typeof handle.dispose === 'function', '没有返回 dispose');
});

const endpointFile = path.join(userData, 'dshwb-sync-endpoint.json');

await check('写下了 endpoint 文件（端口 + 口令）', () => {
  assert.ok(fs.existsSync(endpointFile), '没有生成 endpoint 文件');
  const data = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  assert.ok(Number.isInteger(data.port) && data.port > 0, `端口不对：${data.port}`);
  assert.ok(typeof data.secret === 'string' && data.secret.length >= 20, '口令太短');
});

const endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));

function request({ method = 'POST', headers = {}, body, path: reqPath = '/api' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: endpoint.port,
        path: reqPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

console.log('UI ⇄ 后台对话');

await check('只监听 loopback（外部打不到）', async () => {
  // 用一个非 loopback 的本地地址去连，应该连不上
  const os = await import('node:os');
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && i.family === 'IPv4');
  if (!external) return; // 没有外网卡就跳过
  const result = await new Promise((resolve) => {
    const req = http.request({ host: external.address, port: endpoint.port, path: '/', method: 'POST', timeout: 1200 }, () => resolve('connected'));
    req.on('error', () => resolve('refused'));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.end();
  });
  assert.notEqual(result, 'connected', '服务监听了外部地址，不安全');
});

await check('bootstrap 下发口令', async () => {
  const r = await request({ body: { method: 'bootstrap' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, `bootstrap 失败：${r.text}`);
  assert.ok(r.json.token, '没有下发 token');
});

await check('无口令调业务方法被拒', async () => {
  const r = await request({ body: { method: 'listRepos' } });
  assert.equal(r.status, 403);
});

await check('带口令能调 listRepos', async () => {
  const r = await request({
    body: { method: 'listRepos', args: {} },
    headers: { 'x-dshwb-token': endpoint.secret },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, `调用失败：${r.text}`);
});

await check('diagnostics 报告 workbuddy-extension 平台', async () => {
  const r = await request({
    body: { method: 'diagnostics', args: {} },
    headers: { 'x-dshwb-token': endpoint.secret },
  });
  assert.equal(r.json.platform, 'workbuddy-extension');
});

await check('GET 被拒（只接受 POST）', async () => {
  const r = await request({ method: 'GET' });
  assert.equal(r.status, 405);
});

await check('dispose 后服务关闭、endpoint 文件被清理', async () => {
  await handle.dispose();
  assert.equal(fs.existsSync(endpointFile), false, 'endpoint 文件没删掉');
  const alive = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: endpoint.port, path: '/', method: 'POST', timeout: 800 }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
  assert.equal(alive, false, '服务还在监听');
});

fs.rmSync(userData, { recursive: true, force: true });

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
