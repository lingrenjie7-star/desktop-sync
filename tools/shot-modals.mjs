/**
 * 验证弹窗：点「＋ 给这个软件新建仓库」应该弹出与桌面端一致的对话框。
 * 跑法：<node> tools/shot-modals.mjs <port> <token> <outDir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/Admin/.dsh/profiles/desktop/package.json');
const puppeteer = require('puppeteer-core');

const [, , portArg, tokenArg, outDirArg] = process.argv;
const port = Number(portArg ?? 19500);
const token = tokenArg ?? '';
const outDir = outDirArg ?? 'E:/AITools/wbpro/跨电脑同步/shots-modal';
fs.mkdirSync(outDir, { recursive: true });

function findBrowser() {
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => fs.existsSync(p));
}

const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, {
  waitUntil: 'domcontentloaded', timeout: 60000,
});
await new Promise((r) => setTimeout(r, 3500));

// 关掉欢迎弹窗
await page.evaluate(() => {
  for (const b of document.querySelectorAll('button')) {
    if (['继续', '知道了', '关闭'].includes((b.textContent ?? '').trim())) b.click();
  }
});
await new Promise((r) => setTimeout(r, 600));

// 进「跨电脑同步」
await page.evaluate(() => {
  const n = [...document.querySelectorAll('button,a,li,div,span')]
    .find((x) => (x.textContent ?? '').trim() === '跨电脑同步' && x.children.length <= 2);
  n?.click();
});
await new Promise((r) => setTimeout(r, 2200));

// 切到仓库页
await page.evaluate(() => {
  [...document.querySelectorAll('.dshwb-tab')].find((t) => t.textContent.trim().startsWith('仓库'))?.click();
});
await new Promise((r) => setTimeout(r, 1000));

const results = {};

// 1) 新建仓库弹窗
results.createOpened = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.dshwb-btn')].find((b) => b.textContent.includes('新建仓库'));
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
});
await new Promise((r) => setTimeout(r, 900));
results.createModal = await page.evaluate(() => {
  const m = document.querySelector('.dshwb-modal');
  if (!m) return { found: false };
  return {
    found: true,
    title: m.querySelector('h2')?.textContent ?? '',
    fields: [...m.querySelectorAll('label')].map((l) => l.textContent.trim()),
    segItems: [...m.querySelectorAll('.dshwb-seg-item')].map((s) => s.textContent.trim()),
    inputs: m.querySelectorAll('input').length,
  };
});
await page.screenshot({ path: path.join(outDir, 'modal-create.png') });

// 关掉
await page.evaluate(() => {
  const m = document.querySelector('.dshwb-modal-head .dshwb-btn');
  m?.click();
});
await new Promise((r) => setTimeout(r, 600));

// 2) 加入已有仓库弹窗
results.adoptOpened = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.dshwb-btn')].find((b) => b.textContent.trim() === '加入已有仓库');
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
});
await new Promise((r) => setTimeout(r, 1200));
results.adoptModal = await page.evaluate(() => {
  const m = document.querySelector('.dshwb-modal');
  if (!m) return { found: false };
  return {
    found: true,
    title: m.querySelector('h2')?.textContent ?? '',
    fields: [...m.querySelectorAll('label')].map((l) => l.textContent.trim()),
  };
});
await page.screenshot({ path: path.join(outDir, 'modal-adopt.png') });
await page.evaluate(() => document.querySelector('.dshwb-modal-head .dshwb-btn')?.click());
await new Promise((r) => setTimeout(r, 500));

// 3) 选项页的目录选择器
await page.evaluate(() => {
  [...document.querySelectorAll('.dshwb-tab')].find((t) => t.textContent.trim() === '选项')?.click();
});
await new Promise((r) => setTimeout(r, 1000));
results.browseOpened = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.dshwb-path-entry .dshwb-btn')][0];
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
});
await new Promise((r) => setTimeout(r, 1500));
results.browseModal = await page.evaluate(() => {
  const m = document.querySelector('.dshwb-modal');
  if (!m) return { found: false };
  return {
    found: true,
    title: m.querySelector('h2')?.textContent ?? '',
    hasBrowser: Boolean(m.querySelector('.dshwb-browser')),
    currentPath: m.querySelector('.dshwb-browser-path')?.textContent ?? '',
    dirCount: m.querySelectorAll('.dshwb-browser-row').length,
  };
});
await page.screenshot({ path: path.join(outDir, 'modal-browse.png') });

fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify({ results, errors }, null, 2));
console.log(JSON.stringify({ results, errors }, null, 2));

await browser.close();
