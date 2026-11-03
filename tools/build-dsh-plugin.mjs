/**
 * 构建 DSH 插件包。
 *
 * 为什么需要「构建」而不是直接把源文件拷过去：
 *   插件要装进 ~/.dsh/profiles/<profile>/node_modules/dshwb-sync/，
 *   而它依赖的同步引擎在仓库的 app/lib/ 里。DSH 的模块解析不会往仓库目录跳，
 *   所以必须把引擎**内联**进插件包（lib/vendor/），做成自包含的。
 *
 * 产物结构：
 *   dist/dsh/dshwb-sync/
 *     package.json
 *     cordis.patch.yml
 *     lib/index.js          ← 宿主半边（plugins/dsh/host.mjs）
 *     lib/client.js         ← 浏览器半边（plugins/dsh/client.js）
 *     lib/vendor/*.mjs      ← 内联的同步引擎
 *
 * 跑法：node tools/build-dsh-plugin.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC_APP = path.join(ROOT, 'app', 'lib');
const SRC_PLUGIN = path.join(ROOT, 'plugins', 'dsh');
const SRC_SHARED = path.join(ROOT, 'plugins', 'shared');
const OUT = path.join(ROOT, 'dist', 'dsh', 'dsh-dntb');

function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      // 目录先按名字过一遍白名单，再由内部的文件过滤逐个判断
      copyDir(src, dest, filter);
      continue;
    }
    if (!filter(entry.name)) continue;
    fs.copyFileSync(src, dest);
  }
}

/**
 * 把 core.mjs 里 `../../app/lib/...` 的导入改写成 `./vendor/...`。
 *
 * 只改导入路径，不改逻辑——保证插件里跑的引擎和桌面客户端**是同一份代码**，
 * 以后修 bug 只要重新构建，不会出现「客户端修了、插件没修」。
 */
function rewriteCore(source) {
  return source
    .replace(/from '\.\.\/\.\.\/app\/lib\/([^']+)'/g, (_, rest) => `from './vendor/${rest.replace(/^sources\//, 'sources/')}'`)
    .replace(/from '\.\.\/\.\.\/app\/lib\/sources\/index\.mjs'/g, "from './vendor/sources/index.mjs'");
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ── 清单与 patch
  fs.copyFileSync(path.join(SRC_PLUGIN, 'package.json'), path.join(OUT, 'package.json'));
  fs.copyFileSync(path.join(SRC_PLUGIN, 'cordis.patch.yml'), path.join(OUT, 'cordis.patch.yml'));

  // ── 入口
  const libDir = path.join(OUT, 'lib');
  fs.mkdirSync(libDir, { recursive: true });

  // 宿主：host.mjs → lib/index.js，并把 import 指到插件核心
  const hostSource = fs.readFileSync(path.join(SRC_PLUGIN, 'host.mjs'), 'utf8');
  fs.writeFileSync(
    path.join(libDir, 'index.js'),
    hostSource.replace(/from '\.\.\/shared\/core\.mjs'/, "from './plugin-core.mjs'"),
    'utf8',
  );

  // 浏览器半边：把共享面板内联进占位符。
  // 两个插件共用同一份 panel.js，界面不会一边改一边忘。
  const clientSource = fs.readFileSync(path.join(SRC_PLUGIN, 'client.js'), 'utf8');
  const panelSource = fs.readFileSync(path.join(SRC_SHARED, 'panel.js'), 'utf8');
  const PLACEHOLDER = '/* __DSHWB_SHARED_PANEL__ */';
  if (!clientSource.includes(PLACEHOLDER)) {
    throw new Error(`client.js 里找不到占位符 ${PLACEHOLDER}，无法内联共享面板`);
  }
  const clientOut = clientSource.replace(
    PLACEHOLDER,
    `// ── 以下内联自 plugins/shared/panel.js（两个插件共用）\n${panelSource}`,
  );
  fs.writeFileSync(path.join(libDir, 'client.js'), clientOut, 'utf8');

  // ── 内联引擎
  const vendor = path.join(libDir, 'vendor');
  copyDir(SRC_APP, vendor, (name) => name.endsWith('.mjs'));

  // ── 插件核心：命名成 plugin-core.mjs。
  //    不能叫 core.mjs —— 引擎自己也有一个 core.mjs（在 vendor/ 下），
  //    两个都叫 core 会让人误以为它们是同一个东西（WB 构建里甚至真的撞了名）。
  const coreSource = fs.readFileSync(path.join(SRC_SHARED, 'core.mjs'), 'utf8');
  fs.writeFileSync(path.join(libDir, 'plugin-core.mjs'), rewriteCore(coreSource), 'utf8');

  // ── 自检：产物里不能残留指向仓库的导入
  const problems = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const resolved = path.resolve(path.dirname(full), spec);
          if (!fs.existsSync(resolved)) {
            problems.push(`${path.relative(OUT, full)} → ${spec}（找不到文件）`);
          }
          continue;
        }
        // 裸模块名：只允许 Cordis 这类宿主提供的
        if (!spec.startsWith('@deepseek-ai/')) {
          problems.push(`${path.relative(OUT, full)} → ${spec}（未内联的外部依赖）`);
        }
      }
    }
  };
  walk(OUT);

  if (problems.length > 0) {
    console.error('构建失败，产物不自包含：');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  const files = [];
  const count = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) count(full);
      else files.push(full);
    }
  };
  count(OUT);

  console.log(`构建完成：${path.relative(ROOT, OUT)}`);
  console.log(`共 ${files.length} 个文件：`);
  for (const file of files) console.log(`  ${path.relative(OUT, file)}`);
}

main();
