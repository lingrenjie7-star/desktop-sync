/**
 * 给插件面板截图（会先关掉 DSH 自己的「预览版说明」弹窗）。
 * 跑法：<node> tools/shot-panel.mjs <port> <token> <outDir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/Admin/.dsh/profiles/desktop/package.json');
const puppeteer = require('puppeteer-core');

const [, , portArg, tokenArg, outDirArg] = process.argv;
const port = Number(portArg ?? 19300);
const token = tokenArg ?? '';
const outDir = outDirArg ?? 'E:/AITools/wbpro/跨电脑同步/shots-panel';
fs.mkdirSync(outDir, { recursive: true });

function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 4000));

// 关掉可能出现的弹窗（预览版说明等）
await page.evaluate(() => {
  for (const btn of document.querySelectorAll('button')) {
    const t = (btn.textContent ?? '').trim();
    if (['继续', '知道了', '关闭', '确定', '好'].includes(t)) btn.click();
  }
});
await new Promise((r) => setTimeout(r, 800));

// 点侧边栏「跨电脑同步」
await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('button, a, li, div, span')];
  const hit = nodes.find((n) => (n.textContent ?? '').trim() === '跨电脑同步' && n.children.length <= 2);
  hit?.click();
});
await new Promise((r) => setTimeout(r, 2500));

// 同步页
await page.screenshot({ path: path.join(outDir, '01-sync.png') });

const summarize = async () => page.evaluate(() => {
  const root = document.querySelector('.dshwb-root');
  if (!root) return { found: false };
  const actions = root.querySelector('.dshwb-actions');
  const rect = actions?.getBoundingClientRect();
  const tabs = [...root.querySelectorAll('.dshwb-tab.active')].map((t) => ({
    text: t.textContent.trim(),
    color: getComputedStyle(t).color,
    border: getComputedStyle(t).borderColor,
    weight: getComputedStyle(t).fontWeight,
  }));
  return {
    found: true,
    activeTabs: tabs,
    toolbar: [...(root.querySelector('.dshwb-toolbar')?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
    actionsSticky: actions ? getComputedStyle(actions).position : '',
    actionsVisibleY: rect ? Math.round(rect.top) : null,
    viewportH: window.innerHeight,
    containers: root.querySelectorAll('.dshwb-container').length,
    checkedBoxes: root.querySelectorAll('.dshwb-check:checked').length,
  };
});

const syncState = await summarize();

// 仓库页
await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.dshwb-tab')];
  tabs.find((t) => t.textContent.trim().startsWith('仓库'))?.click();
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: path.join(outDir, '02-repos.png') });

// 账号页
await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.dshwb-tab')];
  tabs.find((t) => t.textContent.trim() === '账号')?.click();
});
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: path.join(outDir, '03-account.png') });

// 选项页
await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.dshwb-tab')];
  tabs.find((t) => t.textContent.trim() === '选项')?.click();
});
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: path.join(outDir, '04-options.png') });

// 回到同步页，滚到底确认操作条仍可见（吸底验证）
await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.dshwb-tab')];
  tabs.find((t) => t.textContent.trim() === '同步')?.click();
});
await new Promise((r) => setTimeout(r, 900));
await page.evaluate(() => {
  const root = document.querySelector('.dshwb-root');
  if (root) root.scrollTop = root.scrollHeight;
});
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: path.join(outDir, '05-scrolled.png') });
const scrolledState = await summarize();

fs.writeFileSync(
  path.join(outDir, 'state.json'),
  JSON.stringify({ syncState, scrolledState, errors }, null, 2),
);
console.log(JSON.stringify({ syncState, scrolledState, errors }, null, 2));

await browser.close();
