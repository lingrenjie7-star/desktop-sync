const { listAsar } = require('E:/AITools/wbpro/跨电脑同步/tools/asar-read.cjs');
const fs = require('node:fs');

const asar = process.argv[2];
const outFile = process.argv[3];
const { entries } = listAsar(asar);
fs.writeFileSync(outFile, entries.map((e) => `${e.size}\t${e.path}`).join('\n'));
console.log('entries:', entries.length);
console.log(entries.slice(0, 15).map((e) => e.path).join('\n'));
