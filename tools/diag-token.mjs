// 复现：插件侧 core 到底能不能拿到令牌（这决定 403 是否由它引起）。
import { createSyncCore } from '../plugins/shared/core.mjs';

const core = createSyncCore({ platform: 'probe' });
const info = core.bootstrap();
console.log('hasToken            =', info.hasToken);
console.log('tokenMode           =', info.tokenMode);
console.log('encryptionAvailable =', info.encryptionAvailable);
console.log('credentials path    =', info.paths.credentials);

const r = await core.availableRepos();
console.log('availableRepos      ->', r.ok ? `ok (${r.repos?.length} repos)` : `FAIL: ${r.error}`);

const d = core.diagnostics();
console.log('diagnostics.tokenMode =', d.tokenMode);
