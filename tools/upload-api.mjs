/**
 * 用 GitHub REST API 逐个上传文件建仓库内容（不依赖 git push 的网络通道）。
 *
 * 为什么不用 git push：本机到 github.com 的 git 通道反复被 reset，
 * 但 HTTPS API 一直可用。API 上传对小仓库完全够用。
 */

import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.DSHWB_TOKEN;
const USER = 'lingrenjie7-star';
const BASE = process.env.DSHWB_BASE;
if (!TOKEN) throw new Error('DSHWB_TOKEN not set');
if (!BASE) throw new Error('DSHWB_BASE not set');

const API = 'https://api.github.com';

async function api(p, opts = {}) {
  const res = await fetch(API + p, {
    ...opts,
    headers: {
      Authorization: `token ${TOKEN}`,
      'User-Agent': 'publish',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push({ abs: full, rel: path.relative(dir, full).split(path.sep).join('/') });
    }
  };
  walk(dir);
  return out;
}

async function putFile(repo, rel, buffer, message) {
  const body = JSON.stringify({
    message,
    content: buffer.toString('base64'),
  });
  // 先看文件是否已存在（拿到 sha 才能更新）
  let sha;
  const head = await api(`/repos/${USER}/${repo}/contents/${encodeURI(rel)}`);
  if (head.ok && head.json?.sha) sha = head.json.sha;

  const payload = sha ? JSON.parse(body) : JSON.parse(body);
  if (sha) payload.sha = sha;

  const res = await api(`/repos/${USER}/${repo}/contents/${encodeURI(rel)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
  });
  return res;
}

const REPOS = [
  { name: 'dsh-sync', dir: path.join(BASE, 'dsh-sync') },
  { name: 'wb-sync', dir: path.join(BASE, 'wb-sync') },
  { name: 'desktop-sync', dir: path.join(BASE, 'desktop-sync') },
];

for (const repo of REPOS) {
  console.log(`\n===== ${repo.name} =====`);

  const files = walkFiles(repo.dir);
  console.log(`  ${files.length} 个文件`);

  // 逐个上传（大文件放后面，先传轻的以便快速失败）
  files.sort((a, b) => fs.statSync(a.abs).size - fs.statSync(b.abs).size);

  let ok = 0;
  const failed = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    let done = false;
    for (let attempt = 1; attempt <= 4 && !done; attempt++) {
      const res = await putFile(repo.name, f.rel, buf, `${repo.name}: upload ${f.rel}`);
      if (res.ok) { done = true; ok++; }
      else if (res.status === 422 || res.status === 409) {
        // 可能是并发/已存在，等一下重试
        await new Promise((r) => setTimeout(r, 800));
      } else if (res.status === 401 || res.status === 403) {
        failed.push(`${f.rel}: ${res.status} ${JSON.stringify(res.json).slice(0, 120)}`);
        break;
      } else {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    if (!done && !failed.some((x) => x.startsWith(f.rel))) {
      failed.push(`${f.rel}: 重试耗尽`);
    }
    if (ok % 15 === 0) process.stdout.write(`  ...${ok}/${files.length}\r`);
  }

  console.log(`  上传成功 ${ok}/${files.length}`);
  if (failed.length > 0) {
    console.log(`  失败 ${failed.length} 个：`);
    for (const x of failed.slice(0, 5)) console.log(`    ${x}`);
  }
}

console.log('\n完成');
