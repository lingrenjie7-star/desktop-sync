// 用已保存的令牌复现建仓 403，把 GitHub 的原始响应打出来。
// 只做只读探测（GET /user），不会真的建仓库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

const credPath = path.join(os.homedir(), '.dshwb-sync', 'credentials.json');
const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
console.log('credential mode =', raw.mode);

function api({ path: p, method = 'GET', token, body }) {
  return new Promise((resolve) => {
    const headers = {
      'User-Agent': 'dshwb-sync',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `token ${token}`;
    let payload;
    if (body) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = https.request({ host: 'api.github.com', path: p, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: text.slice(0, 600) }),
      );
    });
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

let token;
if (raw.encrypted) {
  console.log('令牌是加密存的（safeStorage），插件进程解不开 —— 这本身就是一个问题。');
  console.log('加密块长度 =', String(raw.encrypted).length);
} else {
  token = raw.plain;
}

if (!token) {
  console.log('\n无法用已保存令牌测试（加密存储）。改用匿名请求验证 403 的另一种常见原因：');
  const r = await api({ path: '/user/repos', method: 'POST', body: { name: 'dshwb-probe-xyz', private: true } });
  console.log('  匿名 POST /user/repos ->', r.status);
  console.log('  body:', r.body ?? r.error);
  process.exit(0);
}

console.log('\n--- GET /user ---');
const me = await api({ path: '/user', token });
console.log('  status =', me.status);
if (me.status === 401) {
  console.log('  令牌无效/过期 —— 这会让所有写操作都失败');
}
if (me.headers) {
  console.log('  scopes =', me.headers['x-oauth-scopes'] ?? '(未返回)');
  console.log('  ratelimit remaining =', me.headers['x-ratelimit-remaining']);
  console.log('  ratelimit limit     =', me.headers['x-ratelimit-limit']);
}

console.log('\n--- GET /user/repos?per_page=1 ---');
const list = await api({ path: '/user/repos?per_page=1', token });
console.log('  status =', list.status, '| remaining =', list.headers?.['x-ratelimit-remaining']);
if (list.status !== 200) console.log('  body:', list.body);

console.log('\n--- POST /user/repos （真正的建仓请求，用无效名避免真建） ---');
// 用一个必然 422 的名字，区分「权限问题」和「同名冲突」
const create = await api({
  path: '/user/repos',
  method: 'POST',
  token,
  body: { name: '', private: true },
});
console.log('  status =', create.status);
console.log('  body:', create.body ?? create.error);
