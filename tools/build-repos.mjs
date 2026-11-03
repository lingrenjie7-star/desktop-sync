/**
 * 重新组装三个发布仓库（规范版）。
 *
 * 与之前的区别：
 *   1. 从零构建，不复用任何旧产物
 *   2. README 用规范的仓库名
 *   3. 桌面端把「已打包的绿色版 zip」作为 Release 附件（不是仓库内文件）
 *   4. 排除所有含令牌、含解包产物的文件
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUTBASE = path.join(ROOT, 'publish-out');
const SRC = path.join(ROOT, 'publish');

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

function fresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  fs.mkdirSync(dir, { recursive: true });
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/** 扫描目录，确保没有任何真实令牌。 */
function assertNoSecrets(dir) {
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ps1|mjs|js|cjs|json|md|txt|yml)$/i.test(e.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      // 只抓长得像真令牌的（ghp_ 后面至少 30 位）
      if (/ghp_[A-Za-z0-9]{30,}/.test(text)) bad.push(path.relative(dir, full));
    }
  };
  walk(dir);
  if (bad.length > 0) throw new Error(`发现疑似令牌：${bad.join(', ')}`);
}

// ─────────────────────────────────── 1. DSH 插件
function buildDsh() {
  const out = path.join(OUTBASE, 'dsh-sync');
  const plugin = path.join(ROOT, 'dist', 'dsh', 'dsh-dntb');
  if (!fs.existsSync(plugin)) throw new Error('缺少 DSH 插件产物');

  fresh(out);
  fs.copyFileSync(path.join(SRC, 'package.json'), path.join(out, 'package.json'));
  fs.copyFileSync(path.join(plugin, 'cordis.patch.yml'), path.join(out, 'cordis.patch.yml'));
  fs.copyFileSync(path.join(SRC, 'DSH-README.md'), path.join(out, 'README.md'));
  fs.copyFileSync(path.join(SRC, 'LICENSE'), path.join(out, 'LICENSE'));
  copyDir(path.join(plugin, 'lib'), path.join(out, 'lib'));
  copyDir(path.join(ROOT, 'plugins'), path.join(out, 'plugin-src'));

  fs.mkdirSync(path.join(out, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'verify-package.mjs'), path.join(out, 'scripts', 'verify-package.mjs'));

  write(path.join(out, '.gitignore'), 'node_modules/\n*.log\n.DS_Store\nThumbs.db\n');
  write(path.join(out, '.npmignore'), 'plugin-src/\nscripts/\n.github/\n.gitignore\n.npmignore\n');

  // 三处 id 自检
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
  if (pkg.name !== 'dsh-dntb') throw new Error(`包名错误: ${pkg.name}`);
  const patch = fs.readFileSync(path.join(out, 'cordis.patch.yml'), 'utf8');
  const idLine = patch.split('\n').find((l) => !l.trim().startsWith('#') && /^\s*-\s*id:\s*\S/.test(l));
  const id = idLine?.replace(/^\s*-\s*id:\s*/, '').trim();
  if (id !== 'dsh-dntb') throw new Error(`patch id 错误: ${id}`);

  return out;
}

// ─────────────────────────────────── 2. WorkBuddy 扩展
function buildWb() {
  const out = path.join(OUTBASE, 'wb-sync');
  const ext = path.join(ROOT, 'dist', 'workbuddy', 'dshwb-sync');
  if (!fs.existsSync(ext)) throw new Error('缺少 WorkBuddy 产物');

  fresh(out);
  copyDir(ext, out);
  copyDir(path.join(ROOT, 'plugins', 'workbuddy'), path.join(out, 'src'));

  fs.copyFileSync(path.join(SRC, 'WB-README.md'), path.join(out, 'README.md'));
  fs.copyFileSync(path.join(SRC, 'LICENSE'), path.join(out, 'LICENSE'));
  write(path.join(out, '.gitignore'), 'node_modules/\n*.log\n.DS_Store\nThumbs.db\n');

  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'extension.json'), 'utf8'));
  if (!manifest.ui?.entry?.url) throw new Error('extension.json 缺少 ui.entry.url');
  if (!fs.existsSync(path.join(out, 'server', 'index.cjs'))) throw new Error('缺少 server/index.cjs');

  return out;
}

// ─────────────────────────────────── 3. 桌面端
function buildDesktop() {
  const out = path.join(OUTBASE, 'desktop-sync');
  if (!fs.existsSync(path.join(ROOT, 'app', 'main.mjs'))) throw new Error('缺少 app/main.mjs');

  fresh(out);
  copyDir(path.join(ROOT, 'app'), path.join(out, 'app'));
  copyDir(path.join(ROOT, 'plugins'), path.join(out, 'plugins'));

  // tools：只挑项目自己的脚本，排除解包产物和含令牌的文件
  const SKIP_DIRS = new Set([
    'asar-dump', 'diag-403-electron', 'verify-openurl',
    'wb-ext', 'wb-ipc', 'wb-main', 'wb-main2', 'wb-mount', 'wb-pl', 'wb-svc',
    'wb-extract', 'browse-test', 'dntb-workflow',
  ]);
  const SKIP_FILES = new Set([
    'push-three.ps1', 'assemble-three.mjs', 'assemble-repo.mjs',
    'sessions-list.json', 'list-sessions.mjs', 'delete-sessions.mjs',
    'debug-apply.mjs', 'debug-wb-index.mjs', 'debug-wb-apply.mjs', 'debug-wb-rows.mjs',
    'chk.mjs', 'chk2.mjs', 'test-token-state.mjs',
  ]);
  fs.mkdirSync(path.join(out, 'tools'), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, 'tools'), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (!e.isDirectory() && SKIP_FILES.has(e.name)) continue;
    const s = path.join(ROOT, 'tools', e.name);
    const d = path.join(out, 'tools', e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }

  fs.copyFileSync(path.join(SRC, 'DESKTOP-README.md'), path.join(out, 'README.md'));
  fs.copyFileSync(path.join(SRC, 'LICENSE'), path.join(out, 'LICENSE'));
  write(path.join(out, '.gitignore'), 'node_modules/\ndist/\npublish-out/\nshots-*/\n*.log\n.DS_Store\nThumbs.db\n');

  if (!fs.existsSync(path.join(out, 'app', 'preload.cjs'))) throw new Error('缺少 preload.cjs');
  return out;
}

// ─────────────────────────────────── 执行
function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

console.log('从零重建三个仓库\n');

const d = buildDsh();
assertNoSecrets(d);
console.log(`1. dsh-sync           ${String(countFiles(d)).padStart(4)} 个文件`);

const w = buildWb();
assertNoSecrets(w);
console.log(`2. wb-sync            ${String(countFiles(w)).padStart(4)} 个文件`);

const k = buildDesktop();
assertNoSecrets(k);
console.log(`3. desktop-sync       ${String(countFiles(k)).padStart(4)} 个文件`);

console.log('\n全部无令牌泄漏。');
