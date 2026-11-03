/**
 * 测宿主半边的 HTTP 端点：用一个假的 ctx/webServer 起真实的 node:http 服务，
 * 然后像浏览器那样发请求，确认鉴权、路由、错误处理都对。
 *
 * 这是「插件真的能用」的关键一环 —— 前面只验证了模块能加载。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', 'dist', 'dsh', 'dsh-dntb');

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

const host = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href);

// 临时配置目录：绝不碰用户真实的 ~/.dsh-dntb
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwb-endpoint-'));

// ── 假 ctx：捕获 register 进来的路由
let captured;
const fakeCtx = {
  get: (name) => {
    if (name === 'webServer') return { register: (route) => { captured = route; return () => {}; } };
    if (name === 'logger') return { info() {}, warn() {} };
    return undefined;
  },
  effect: () => () => {},
};

host.apply(fakeCtx, { syncHome: tmpHome });

await check('apply 注册了 exact 路由', () => {
  assert.ok(captured, '没有捕获到路由注册');
  assert.equal(captured.kind, 'exact');
  assert.equal(captured.path, '/api/dsh-dntb');
  assert.equal(typeof captured.handler, 'function');
});

// 用真实 http server 承载这个 handler
const server = http.createServer((req, res) => {
  captured.handler(req, res).catch((error) => {
    res.writeHead(500);
    res.end(String(error));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function request({ method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/dsh-dntb',
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

console.log('鉴权');

await check('GET 被拒绝（只接受 POST）', async () => {
  const r = await request({ method: 'GET' });
  assert.equal(r.status, 405);
});

await check('没有 JSON Content-Type 被拒绝', async () => {
  const r = await request({ body: {}, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
});

await check('错误口令被拒绝', async () => {
  // 注意：必须用一个需要口令的方法来测；bootstrap 是引导请求，本来就不要求口令
  const r = await request({ body: { method: 'listRepos' }, headers: { 'x-dshwb-token': 'wrong' } });
  assert.equal(r.status, 403);
});

await check('bootstrap 带错口令也能成功（它就是发口令的那一步）', async () => {
  const r = await request({ body: { method: 'bootstrap' }, headers: { 'x-dshwb-token': 'wrong' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

console.log('bootstrap 引导');

let sessionToken = '';
await check('bootstrap 无需口令即可调用，并下发会话口令', async () => {
  const r = await request({ body: { method: 'bootstrap' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, `bootstrap 失败：${r.text}`);
  assert.ok(typeof r.json.token === 'string' && r.json.token.length > 20, '没有下发 token');
  sessionToken = r.json.token;
});

await check('bootstrap 报告「没有加密后端」而不是假装安全', async () => {
  const r = await request({ body: { method: 'bootstrap' } });
  assert.equal(r.json.encryptionAvailable, false);
  assert.equal(r.json.hasToken, false);
});

console.log('正常调用');

await check('带正确口令可以调 listRepos', async () => {
  const r = await request({
    body: { method: 'listRepos', args: {} },
    headers: { 'x-dshwb-token': sessionToken },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, `调用失败：${r.text}`);
  assert.deepEqual(r.json.repos, [], '全新目录不该有仓库');
});

await check('不带口令调业务方法被拒', async () => {
  const r = await request({ body: { method: 'listRepos', args: {} } });
  assert.equal(r.status, 403);
});

await check('不存在的方法返回 404 且不崩', async () => {
  const r = await request({
    body: { method: 'noSuchMethod', args: {} },
    headers: { 'x-dshwb-token': sessionToken },
  });
  assert.equal(r.status, 404);
  assert.equal(r.json.ok, false);
});

await check('非法 JSON 返回 400 且不崩', async () => {
  // 明确发一段坏 JSON（带正确 Content-Type 和口令）
  const r = await new Promise((resolve, reject) => {
    const bad = '{not json';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/dsh-dntb',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bad),
          'x-dshwb-token': sessionToken,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.write(bad);
    req.end();
  });
  assert.equal(r.status, 400, `期望 400，实际 ${r.status}：${r.text}`);
});

await check('未登录时业务方法返回人话错误而不是抛异常', async () => {
  const r = await request({
    body: { method: 'discover', args: {} },
    headers: { 'x-dshwb-token': sessionToken },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.match(String(r.json.error), /登录/, `错误不够清楚：${r.json.error}`);
});

await check('diagnostics 能报告平台与路径', async () => {
  const r = await request({
    body: { method: 'diagnostics', args: {} },
    headers: { 'x-dshwb-token': sessionToken },
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.platform, 'dsh-plugin');
  assert.ok(r.json.paths.home.includes('dshwb-endpoint-'));
});

await new Promise((resolve) => server.close(resolve));
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
