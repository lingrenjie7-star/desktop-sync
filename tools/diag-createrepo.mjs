// 直接测 core.createRepo 的返回形状（绕开 host 的 wrap）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSyncCore } from '../plugins/shared/core.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
fs.writeFileSync(
  path.join(home, 'credentials.json'),
  JSON.stringify({ mode: 'safeStorage', encrypted: 'AAAA' }),
  'utf8',
);

const c = createSyncCore({ home, platform: 't' });
const r = await c.createRepo({ name: 'x', source: 'dsh' });
console.log('createRepo ->', JSON.stringify(r, null, 2));

fs.rmSync(home, { recursive: true, force: true });
