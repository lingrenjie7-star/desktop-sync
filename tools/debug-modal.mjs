// 调试：点「新建仓库」后，看弹窗到底有没有进 DOM、按钮是否真的触发。
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/Admin/.dsh/profiles/desktop/package.json');
const puppeteer = require('puppeteer-core');

const port = 19500;
const token = 'nohfrbJgGbQQJXCx_ZgBSHWNnaRMfviMWNlqbgZ1Pis';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text()); });

await page.goto(`http://127.0.0.1:${port}/?token=${token}`, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3500));
await page.evaluate(() => {
  for (const b of document.querySelectorAll('button')) {
    if (['继续', '知道了'].includes((b.textContent ?? '').trim())) b.click();
  }
});
await new Promise((r) => setTimeout(r, 600));
await page.evaluate(() => {
  [...document.querySelectorAll('button,a,li,div,span')]
    .find((x) => (x.textContent ?? '').trim() === '跨电脑同步' && x.children.length <= 2)?.click();
});
await new Promise((r) => setTimeout(r, 2200));
await page.evaluate(() => {
  [...document.querySelectorAll('.dshwb-tab')].find((t) => t.textContent.trim().startsWith('仓库'))?.click();
});
await new Promise((r) => setTimeout(r, 1200));

const before = await page.evaluate(() => ({
  buttons: [...document.querySelectorAll('.dshwb-btn')].map((b) => b.textContent.trim()),
  modalMasks: document.querySelectorAll('.dshwb-modal-mask').length,
}));
console.log('before click:', JSON.stringify(before, null, 2));

const clicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.dshwb-btn')];
  const btn = btns.find((b) => b.textContent.includes('新建仓库'));
  if (!btn) return { ok: false, why: 'not found', all: btns.map((b) => b.textContent.trim()) };
  btn.click();
  return { ok: true };
});
console.log('click:', JSON.stringify(clicked));

await new Promise((r) => setTimeout(r, 1500));

const after = await page.evaluate(() => ({
  modalMasks: document.querySelectorAll('.dshwb-modal-mask').length,
  modals: document.querySelectorAll('.dshwb-modal').length,
  anyModalLike: document.querySelectorAll('[class*="modal"]').length,
  bodyTail: document.body.innerHTML.slice(-1200),
}));
console.log('after click:', JSON.stringify(after, null, 2).slice(0, 2500));

await browser.close();
