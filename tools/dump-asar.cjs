// 从 app.asar 里捞出 README / 类型定义，用于调研插件 API。
const { listAsar, readAsarFile } = require('E:/AITools/wbpro/跨电脑同步/tools/asar-read.cjs');
const fs = require('node:fs');
const path = require('node:path');

const asar = 'E:/AITools/DSH/resources/app.asar';
const outDir = 'E:/AITools/wbpro/跨电脑同步/tools/asar-dump';

const pattern = new RegExp(process.argv[2] || 'README\\.md$');
const { entries } = listAsar(asar);

let n = 0;
for (const e of entries) {
  if (!pattern.test(e.path)) continue;
  if (e.unpacked) continue;
  try {
    const buf = readAsarFile(asar, e.path);
    const dest = path.join(outDir, e.path.replace(/[<>:"|?*]/g, '_'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    n++;
    console.log(`${e.size}\t${e.path}`);
  } catch (err) {
    console.log(`ERR ${e.path} ${err.message}`);
  }
}
console.log('dumped', n);
