// 从任意 asar 里按正则捞文件到目录。
const { listAsar, readAsarFile } = require('E:/AITools/wbpro/跨电脑同步/tools/asar-read.cjs');
const fs = require('node:fs');
const path = require('node:path');

const [asar, patternStr, outDir] = process.argv.slice(2);
const pattern = new RegExp(patternStr, 'i');
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
