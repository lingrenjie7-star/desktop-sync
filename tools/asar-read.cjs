// 极简 asar 读取器：绕过 Electron 的 asar fs 钩子，直接按字节格式读。
// 格式：u32 pickleSize + u32 headerSize(含 4) | pickle: u32 payloadSize + u32 jsonLen + json
const fs = require('node:fs');

process.noAsar = true;

function loadAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // head: [0..3]=pickle size, [4..7]=headerSize, [8..11]=payload, [12..15]=jsonLen
  const headerSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const baseOffset = 8 + headerSize;
  fs.closeSync(fd);
  return { root: JSON.parse(jsonBuf.toString('utf8')), baseOffset, file };
}

function collect(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) collect(entry, p, out);
    else out.push({ path: p, offset: Number(entry.offset), size: entry.size, unpacked: Boolean(entry.unpacked) });
  }
}

function listAsar(file) {
  const { root, baseOffset } = loadAsar(file);
  const out = [];
  collect(root, '', out);
  return { entries: out, baseOffset };
}

function readAsarFile(file, innerPath) {
  const { baseOffset } = loadAsar(file);
  const { entries } = listAsar(file);
  const hit = entries.find((e) => e.path === innerPath);
  if (!hit) return undefined;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(hit.size);
  fs.readSync(fd, buf, 0, hit.size, baseOffset + hit.offset);
  fs.closeSync(fd);
  return buf;
}

module.exports = { listAsar, readAsarFile };
