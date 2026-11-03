// 试试能不能在插件侧解开 desktop 写的 safeStorage 令牌。
// 能解开的话就不需要用户重登了。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const credPath = path.join(os.homedir(), '.dshwb-sync', 'credentials.json');
const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));

console.log('mode =', raw.mode, '| encrypted len =', String(raw.encrypted ?? '').length);

let electron;
try {
  electron = (await import('electron')).default ?? (await import('electron'));
} catch (e) {
  console.log('无法 import electron:', e.message);
}

const safeStorage = electron?.safeStorage;
console.log('safeStorage available =', Boolean(safeStorage));

if (safeStorage) {
  try {
    console.log('isEncryptionAvailable =', safeStorage.isEncryptionAvailable());
  } catch (e) {
    console.log('isEncryptionAvailable threw:', e.message);
  }
  try {
    const token = safeStorage.decryptString(Buffer.from(raw.encrypted, 'base64'));
    console.log('解密成功，长度 =', token.length, '前缀 =', token.slice(0, 4) + '…');
  } catch (e) {
    console.log('解密失败:', e.message);
  }
}

console.log('\nprocess.type =', process.type ?? '(none, 说明是纯 node 环境)');
