// 截图插件面板的各个页面，检查渲染是否正常（尤其是新加的「远端内容」）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/Admin/.dsh/profiles/desktop/package.json');
const puppeteer = require('puppeteer-core');

const [, , portArg, tokenArg, outDirArg] = process.argv;
const port = Number(portArg);
const token = tokenArg;
const outDir = outDirArg ?? 'E:/AITools/wbpro/跨电脑同步/shots-plugin-final';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, {
  waitUntil: 'domcontentloaded', timeout: 60000,
});
await new Promise((r) => setTimeout(r, 4000));

await page.evaluate(() => {
  for (const b of document.querySelectorAll('button')) {
    if (['继续', '知道了', '关闭'].includes((b.textContent ?? '').trim())) b.click();
  }
});
await new Promise((r) => setTimeout(r, 800));

// 进插件
await page.evaluate(() => {
  [...document.querySelectorAll('button,a,li,div,span')]
    .find((x) => (x.textContent ?? '').trim() === '跨电脑同步' && x.children.length <= 2)?.click();
});
await new Promise((r) => setTimeout(r, 2500));

const out = {};

// 同步页
await page.screenshot({ path: path.join(outDir, '01-sync.png') });
out.sync = await page.evaluate(() => ({
  hasRoot: Boolean(document.querySelector('.dshwb-root')),
  tabs: [...document.querySelectorAll('.dshwb-tab')].map((t) => t.textContent.trim()),
  toolbar: [...(document.querySelector('.dshwb-toolbar')?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
}));

// 仓库页
await page.evaluate(() => {
  [...document.querySelectorAll('.dshwb-tab')].find((t) => t.textContent.trim().startsWith('仓库'))?.click();
});
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: path.join(outDir, '02-repos.png') });
out.repos = await page.evaluate(() => ({
  buttons: [...document.querySelectorAll('.dshwb-btn')].map((b) => b.textContent.trim()).filter(Boolean),
  cards: document.querySelectorAll('.dshwb-repo-card').length,
  cardActions: [...(document.querySelector('.dshwb-repo-card')?.querySelectorAll('.dshwb-btn') ?? [])].map((b) => b.textContent.trim()),
}));

// 点「远端内容」，看新页面
const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.dshwb-btn')].find((b) => b.textContent.trim() === '远端内容');
  if (!btn) return false;
  btn.click();
  return true;
});
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: path.join(outDir, '03-browser.png') });
out.browser = await page.evaluate(() => ({
  clicked: true,
  headTitle: document.querySelector('.dshwb-head h1')?.textContent ?? '',
  hasBackBtn: [...document.querySelectorAll('.dshwb-btn')].some((b) => b.textContent.includes('返回仓库')),
  containers: document.querySelectorAll('.dshwb-container').length,
  stats: [...document.querySelectorAll('.dshwb-hint')].map((s) => s.textContent.trim()).slice(0, 6),
}));
out.browserClicked = clicked;

// 账号页
await page.evaluate(() => {
  [...document.querySelectorAll('.dshwb-tab')].find((t) => t.textContent.trim() === '账号')?.click();
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: path.join(outDir, '04-account.png') });
out.account = await page.evaluate(() => ({
  buttons: [...document.querySelectorAll('.dshwb-btn')].map((b) => b.textContent.trim()).filter(Boolean),
}));

// 选项页
await page.evaluate(() => {
  [...document.querySelectorAll('.dshwb-tab')].find((t) => t.textContent.trim() === '选项')?.click();
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: path.join(outDir, '05-options.png') });

out.errors = errors.slice(0, 10);
fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

await browser.close();
