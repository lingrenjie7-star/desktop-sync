/**
 * 构建 WorkBuddy 扩展包。
 *
 * 产物结构（必须和内置扩展一致，见 plugins/NOTES.md）：
 *   dist/workbuddy/dshwb-sync/
 *     extension.json
 *     assets/icon.svg
 *     ui/assets/remoteEntry.js     ← 模块联邦容器
 *     server/index.cjs             ← activate(wb) 入口，内联同步引擎
 *
 * 关键点：WorkBuddy 扩展跑在自己的 fork 进程里，**没有 node_modules 解析**，
 * 所以同步引擎必须内联进 server/index.cjs。这里用手写的极简打包：
 * 把 .mjs 转成 .cjs（ESM → CJS）并顺序拼进一个文件。
 *
 * 为什么要转 CJS：
 *   extension.json 的 service.entry 是 .cjs，扩展进程用 require 加载。
 *
 * 跑法：node tools/build-workbuddy-extension.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC_APP = path.join(ROOT, 'app', 'lib');
const SRC_PLUGIN = path.join(ROOT, 'plugins', 'workbuddy');
const SRC_SHARED = path.join(ROOT, 'plugins', 'shared');
const OUT = path.join(ROOT, 'dist', 'workbuddy', 'dshwb-sync');

/**
 * ESM → CJS 的最小转换。
 *
 * 只处理本项目实际用到的语法：import / export。
 * 这不是通用转译器，但对「自己写的、风格统一的源码」足够，
 * 而且比引入 esbuild 之类的依赖更适合这里（零外部依赖）。
 *
 * 返回 { code, imports }，其中 imports 是需要在文件顶部补 require 的清单。
 * 已经被调用方手动改成 require() 的依赖不会出现在这个清单里。
 */
function esmToCjs(source, filePath) {
  const imports = [];

  // 第一步：把所有 import 语句抽出来，替换成占位符。
  // 用占位符而不是直接替换成 const…=…，是为了避免
  // 「刚生成的代码又被后续正则匹配一次」这类重入问题。
  const importSlots = [];
  let out = source.replace(/^import\s+([^;'"]+?)\s+from\s+'([^']+)';?[ \t]*$/gm, (_, clause, spec) => {
    const index = importSlots.length;
    importSlots.push({ clause: clause.trim(), spec: spec.trim() });
    return `\u0000IMP${index}\u0000`;
  });

  // 第二步：export 去掉（CJS 用 module.exports）。
  // 同时把每个导出的名字记下来，最后生成 module.exports，
  // 否则 CJS 里这些函数定义了却拿不到（之前就踩了这个坑）。
  const exported = new Set();

  out = out.replace(/^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, (_, asyncKw, name) => {
    exported.add(name);
    return `${asyncKw ?? ''}function ${name}`;
  });
  out = out.replace(/^export\s+(const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kw, name) => {
    exported.add(name);
    return `${kw} ${name}`;
  });
  out = out.replace(/^export\s*\{([^}]*)\};?[ \t]*$/gm, (_, names) => {
    for (const part of names.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asParts = trimmed.split(/\s+as\s+/);
      exported.add((asParts[1] ?? asParts[0]).trim());
    }
    return '';
  });
  out = out.replace(/^export\s+default\s+/gm, 'module.exports.default = ');

  // 第三步：把 import 占位符换成顶部 require 声明
  const header = [];
  out = out.replace(/\u0000IMP(\d+)\u0000/g, (_, rawIndex) => {
    const { clause, spec } = importSlots[Number(rawIndex)];
    const id = `__imp${imports.length}`;
    imports.push({ id, spec });

    if (clause.startsWith('*')) {
      const name = clause.replace(/^\*\s*as\s*/, '').trim();
      header.push(`const ${name} = ${id};`);
      return '';
    }
    if (clause.startsWith('{')) {
      const names = clause
        .replace(/^\{|\}$/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const parts = s.split(/\s+as\s+/);
          return parts.length === 2 ? `${parts[0].trim()}: ${parts[1].trim()}` : s;
        });
      header.push(`const { ${names.join(', ')} } = ${id};`);
      return '';
    }
    header.push(`const ${clause} = ${id};`);
    return '';
  });

  return { code: `${header.join('\n')}\n${out}`, imports, exported: [...exported] };
}

/**
 * 改写相对导入的扩展名，**保留目录层级**。
 *
 * 之前把所有相对路径都压成 ./<basename>，结果 engine.mjs 里的
 * './sources/index.mjs' 变成了 './index.cjs'，指到了别的文件上。
 */
/**
 * 生成 module.exports 的最后一段。
 *
 * 关键：用 getter 而不是一次性赋值。
 * 模块之间存在真实循环（engine → sources/index → sources/dsh → core），
 * 一次性赋值会在环里把还没求值的函数永久固定成 undefined；
 * getter 让每个访问点都重新取值，行为等价于 ESM 的活绑定。
 */
function buildExports(names) {
  if (!names || names.length === 0) return '';
  const list = JSON.stringify(names);
  return (
    `\nfor (const __name of ${list}) {\n` +
    `  Object.defineProperty(module.exports, __name, {\n` +
    `    enumerable: true, configurable: true,\n` +
    `    get() { return eval(__name); },\n` +
    `  });\n` +
    `}\n`
  );
}

function rewriteSpec(spec, fromFile) {
  if (spec.startsWith('node:')) return spec;
  if (!spec.startsWith('.')) return spec;
  return spec.replace(/\.mjs$/, '.cjs');
}

function buildServer() {
  const libDir = path.join(OUT, 'server', 'lib');
  fs.mkdirSync(libDir, { recursive: true });

  // 1. 同步引擎：每个 .mjs 单独转成一个 .cjs
  const engineFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.mjs')) engineFiles.push(full);
    }
  };
  walk(SRC_APP);

  for (const file of engineFiles) {
    const rel = path.relative(SRC_APP, file).replace(/\.mjs$/, '.cjs');
    const dest = path.join(libDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const source = fs.readFileSync(file, 'utf8');
    const { code, imports, exported } = esmToCjs(source, file);

    // ESM → CJS 之后，`require` 已经是 CJS 自带的全局函数。
    // workbuddy.mjs 里那句 `const require = createRequire(import.meta.url);`
    // 在 CJS 里会变成「重复声明 require」并直接报错，所以整段拿掉 ——
    // 包括它引入的 createRequire 绑定行（否则会留下未定义的 __impN）。
    const usesCreateRequire = /createRequire/.test(source);
    const cleaned = code
      .replace(/^\s*const\s+require\s*=\s*createRequire\([^)]*\);?\s*$/gm, '')
      .replace(/^\s*const\s*\{\s*createRequire\s*\}\s*=\s*__imp\d+;?\s*$/gm, '')
      .replace(/^\s*const\s+__filename\s*=\s*fileURLToPath\([^)]*\);?\s*$/gm, '');

    // 把每个 __impN 绑到真正的 require 调用上
    const binding = imports
      .filter(({ spec }) => !(usesCreateRequire && spec === 'node:module'))
      .map(({ id, spec }) => `const ${id} = require('${rewriteSpec(spec, file)}');`)
      .join('\n');

    // 补上 exports：CJS 没有 export 语句，必须显式挂到 module.exports。
    // 用 getter 实现「活绑定」：ESM 的 import 是活绑定，模块一求值完就能用；
    // 而 CJS 的 require 在循环依赖时会拿到半成品对象。真实存在这个环：
    //   engine → sources/index → sources/dsh → core
    // 普通 { a } = require() 在环里会拿到 undefined（实测 expandHome is not a function）。
    const exportLine = buildExports(exported);

    fs.writeFileSync(dest, `${binding}\n${cleaned}${exportLine}`, 'utf8');
  }

  // 2. 共享核心：放到 lib/plugin-core.cjs。
  //    不能叫 core.cjs —— 引擎自己也有一个 core.mjs（路径/哈希/zstd 工具），
  //    两者同名会把引擎的 core.cjs 覆盖掉，症状是运行期
  //    「expandHome is not a function」这类看似莫名其妙的错误。
  const coreSource = fs.readFileSync(path.join(SRC_SHARED, 'core.mjs'), 'utf8');
  const rewrittenCore = coreSource.replace(
    /from '(?:\.\.\/)+app\/lib\/([^']+)'/g,
    (_, rest) => `from './${rest.replace(/\.mjs$/, '.cjs')}'`,
  );
  const { code: coreCode, imports: coreImports, exported: coreExports } = esmToCjs(rewrittenCore, 'core.mjs');
  const coreBinding = coreImports
    .map(({ id, spec }) => `const ${id} = require('${spec.replace(/^\.\//, './').replace(/\.mjs$/, '.cjs')}');`)
    .join('\n');
  fs.writeFileSync(path.join(libDir, 'plugin-core.cjs'), `${coreBinding}\n${coreCode}${buildExports(coreExports)}`, 'utf8');

  // 3. 服务入口：包装成 CommonJS 的 activate(wb)
  let serviceSource = fs.readFileSync(path.join(SRC_PLUGIN, 'service.mjs'), 'utf8');

  // 先把本文件用到的相对导入换成 require —— 必须在转译之前做，
  // 否则转译器会把它换成 __impN 占位符但不会生成对应的 require。
  serviceSource = serviceSource.replace(
    /import \{ createSyncCore \} from '(?:\.\.\/)+shared\/core\.mjs';/,
    "const { createSyncCore } = require('./lib/plugin-core.cjs');",
  );
  serviceSource = serviceSource
    .replace(/import fs from 'node:fs';/, "const fs = require('node:fs');")
    .replace(/import http from 'node:http';/, "const http = require('node:http');")
    .replace(/import path from 'node:path';/, "const path = require('node:path');")
    .replace(/import \{ randomBytes \} from 'node:crypto';/, "const { randomBytes } = require('node:crypto');");

  const { code: serviceCode, imports: leftover } = esmToCjs(serviceSource, 'service.mjs');
  if (leftover.length > 0) {
    // 有没被显式改写的 import：说明源码加了新依赖，这里必须补上而不是静默生成坏代码
    throw new Error(
      `service.mjs 里有未处理的 import：${leftover.map((i) => i.spec).join(', ')}；` +
        '请在 build-workbuddy-extension.mjs 里补一条 require 改写',
    );
  }
  fs.writeFileSync(
    path.join(OUT, 'server', 'index.cjs'),
    `// WorkBuddy 扩展后台服务：入口 activate(wb)\n${serviceCode}\nmodule.exports = { activate: typeof activate === 'function' ? activate : undefined };\n`,
    'utf8',
  );
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // 清单 + 图标
  fs.copyFileSync(path.join(SRC_PLUGIN, 'extension.json'), path.join(OUT, 'extension.json'));
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(SRC_PLUGIN, 'icon.svg'), path.join(OUT, 'assets', 'icon.svg'));

  /**
   * distribution.json —— WorkBuddy 内置扩展目录里 8 个扩展全部带这个文件。
   * 它声明扩展的权限、进程策略和启用状态。
   * 放内置目录（resources/app.asar.unpacked/resources/extensions/）时需要有它。
   */
  const manifestForDist = JSON.parse(fs.readFileSync(path.join(SRC_PLUGIN, 'extension.json'), 'utf8'));
  const distribution = {
    extensionId: manifestForDist.id,
    version: manifestForDist.version,
    kind: 'user',
    grantedPermissions: ['*'],
    processPolicy: {
      server: 'fork',
      renderer: 'mf',
    },
    status: 'active',
    resident: true,
  };
  fs.writeFileSync(
    path.join(OUT, 'distribution.json'),
    JSON.stringify(distribution, null, 2) + '\n',
    'utf8',
  );

  // UI 半边：把共享面板内联进占位符（与 DSH 插件同一份）
  const remoteSource = fs.readFileSync(path.join(SRC_PLUGIN, 'remoteEntry.js'), 'utf8');
  const panelSource = fs.readFileSync(path.join(SRC_SHARED, 'panel.js'), 'utf8');
  const PLACEHOLDER = '/* __DSHWB_SHARED_PANEL__ */';
  if (!remoteSource.includes(PLACEHOLDER)) {
    throw new Error(`remoteEntry.js 里找不到占位符 ${PLACEHOLDER}，无法内联共享面板`);
  }
  const remoteOut = remoteSource.replace(
    PLACEHOLDER,
    `// ── 以下内联自 plugins/shared/panel.js（两个插件共用）\n${panelSource}`,
  );
  fs.mkdirSync(path.join(OUT, 'ui', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'ui', 'assets', 'remoteEntry.js'), remoteOut, 'utf8');

  // 后台服务
  buildServer();

  // ── 自检
  const problems = [];

  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'extension.json'), 'utf8'));
  if (manifest.id !== 'dshwb-sync') problems.push('extension.json 的 id 不对');
  if (!manifest.ui?.entry?.url?.endsWith('remoteEntry.js')) problems.push('ui.entry.url 必须指向 remoteEntry.js');
  if (manifest.service?.entry !== './server/index.cjs') problems.push('service.entry 必须是 ./server/index.cjs');

  // 入口文件必须真的导出 activate
  const serverCode = fs.readFileSync(path.join(OUT, 'server', 'index.cjs'), 'utf8');
  if (!/function\s+activate\s*\(/.test(serverCode)) problems.push('server/index.cjs 里找不到 activate 函数');
  if (!/module\.exports\s*=/.test(serverCode)) problems.push('server/index.cjs 没有 module.exports');

  // 不能残留 ESM 语法
  for (const [label, code] of [
    ['server/index.cjs', serverCode],
    ['server/lib/plugin-core.cjs', fs.readFileSync(path.join(OUT, 'server', 'lib', 'plugin-core.cjs'), 'utf8')],
  ]) {
    if (/^\s*import\s.+from\s.+;?$/m.test(code)) problems.push(`${label} 里还残留 import 语句`);
    if (/^\s*export\s/m.test(code)) problems.push(`${label} 里还残留 export 语句`);
  }

  if (problems.length > 0) {
    console.error('构建失败：');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  const files = [];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else files.push(full);
    }
  };
  collect(OUT);

  console.log(`构建完成：${path.relative(ROOT, OUT)}`);
  console.log(`共 ${files.length} 个文件：`);
  for (const file of files) console.log(`  ${path.relative(OUT, file)}`);
}

main();
