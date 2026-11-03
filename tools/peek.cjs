// 在 dump 出来的文件里按关键词截取上下文，方便看注册代码。
const fs = require('node:fs');

const [file, needle, beforeStr, afterStr] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const before = Number(beforeStr ?? 800);
const after = Number(afterStr ?? 1600);

let idx = text.indexOf(needle);
if (idx < 0) {
  console.log('NOT FOUND:', needle);
  process.exit(1);
}
const start = Math.max(0, idx - before);
const end = Math.min(text.length, idx + after);
console.log(`// @${idx} (len=${text.length})`);
console.log(text.slice(start, end));
