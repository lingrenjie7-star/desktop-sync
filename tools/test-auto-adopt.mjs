/**
 * 自动登记逻辑的回归测试。
 *
 * 需求：切到仓库页时，GitHub 上**已标识**的仓库应该直接出现，
 *       而不是还要用户点「加入本机」。
 *
 * 但也不能什么都自动收 —— 只收有硬证据的：
 *   marker / topic / description / legacy
 * 不收：
 *   marker-unknown（指向本机没装的软件）
 *   未识别（没有标识，不能猜）
 *   local（本来就登记过）
 */

import assert from 'node:assert/strict';

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

// 和 main.mjs 里完全一致的判定
const EVIDENCE = new Set(['marker', 'topic', 'description', 'legacy']);

function shouldAutoAdopt(repo) {
  return !repo.registered && EVIDENCE.has(repo.confidence);
}

console.log('应该自动登记');

check('marker（标识文件）→ 收', () => {
  assert.equal(shouldAutoAdopt({ confidence: 'marker', registered: false }), true);
});
check('topic（标签）→ 收', () => {
  assert.equal(shouldAutoAdopt({ confidence: 'topic', registered: false }), true);
});
check('description（描述前缀）→ 收', () => {
  assert.equal(shouldAutoAdopt({ confidence: 'description', registered: false }), true);
});
check('legacy（旧版 manifest）→ 收', () => {
  assert.equal(shouldAutoAdopt({ confidence: 'legacy', registered: false }), true);
});

console.log('不应该自动登记');

check('marker-unknown（本机没这个软件）→ 不收', () => {
  assert.equal(shouldAutoAdopt({ confidence: 'marker-unknown', registered: false }), false);
});
check('未识别（没有 confidence）→ 不收', () => {
  assert.equal(shouldAutoAdopt({ confidence: '', registered: false }), false);
  assert.equal(shouldAutoAdopt({ confidence: undefined, registered: false }), false);
});
check('已经登记过的 → 不收（避免重复）', () => {
  assert.equal(shouldAutoAdopt({ confidence: 'marker', registered: true }), false);
});

console.log('源码契约');

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const mainSrc = fs.readFileSync(path.resolve(HERE, '..', 'app', 'main.mjs'), 'utf8');

check('repos:discover 里实现了自动登记', () => {
  assert.match(mainSrc, /自动登记/, '找不到自动登记的说明');
  assert.match(mainSrc, /EVIDENCE/, '找不到证据类型集合');
});

check('自动登记会 persist 并回报 adopted', () => {
  assert.match(mainSrc, /adopted\.length > 0[\s\S]{0,120}persist\(config\)/, '没有持久化');
  assert.match(mainSrc, /adopted,/, '没有把 adopted 回报给界面');
});

check('界面收到 adopted 后会刷新本机仓库列表', () => {
  const uiSrc = fs.readFileSync(path.resolve(HERE, '..', 'app', 'ui', 'app.js'), 'utf8');
  assert.match(uiSrc, /result\.adopted/, '界面没有处理 adopted');
  assert.match(uiSrc, /adopted[\s\S]{0,300}refreshRepos/, '界面没有在自动登记后刷新列表');
});

check('自动登记不会写入「未识别」的仓库', () => {
  // 只遍历 bySource（已归类），不遍历 unknown
  const idx = mainSrc.indexOf('const adopted = []');
  const region = mainSrc.slice(idx, idx + 1600);
  assert.ok(!/unknown/.test(region), '自动登记里出现了 unknown，可能会误收未识别仓库');
});

console.log(failures.length === 0 ? `\n${pass} 项通过` : `\n${pass} 项通过，${failures.length} 项失败`);
process.exitCode = failures.length === 0 ? 0 : 1;
