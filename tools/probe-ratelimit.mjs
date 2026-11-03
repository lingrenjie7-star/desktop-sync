// 查 GitHub 限流状态，确认 403 的真因。
import https from 'node:https';

function get(path, token) {
  return new Promise((resolve) => {
    const headers = {
      'User-Agent': 'dshwb-probe',
      Accept: 'application/vnd.github+json',
    };
    if (token) headers.Authorization = `token ${token}`;
    const req = https.request(
      { host: 'api.github.com', path, method: 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text.slice(0, 500) }));
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end();
  });
}

const r = await get('/rate_limit');
console.log('anonymous /rate_limit status =', r.status);
if (r.headers) {
  console.log('  limit     :', r.headers['x-ratelimit-limit']);
  console.log('  remaining :', r.headers['x-ratelimit-remaining']);
  const reset = Number(r.headers['x-ratelimit-reset'] ?? 0);
  if (reset) console.log('  reset at  :', new Date(reset * 1000).toLocaleString());
}
console.log('  body      :', r.body ?? r.error);
