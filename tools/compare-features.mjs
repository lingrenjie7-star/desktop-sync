/**
 * 对照桌面端与插件端的功能差异。
 *
 * 目的：不凭感觉「改成一样」，而是列出两边各自有什么、缺什么。
 * 只看结构性差异（按钮/字段/分区），不看像素样式。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/AITools/wbpro/跨电脑同步';
const desktopJs = fs.readFileSync(path.join(ROOT, 'app/ui/app.js'), 'utf8');
const desktopHtml = fs.readFileSync(path.join(ROOT, 'app/ui/index.html'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, 'plugins/shared/panel.js'), 'utf8');

const has = (src, needle) => src.includes(needle);

const items = [
  // 同步页
  ['同步页：全选', desktopHtml.includes('全选'), has(panel, "'全选'")],
  ['同步页：全不选', desktopHtml.includes('全不选'), has(panel, '全不选')],
  ['同步页：重新扫描', desktopJs.includes('重新扫描'), has(panel, '重新扫描')],
  ['同步页：吸底操作条', has(desktopHtml, 'class="actions"'), has(panel, 'dshwb-actions')],
  ['同步页：传到下拉', has(desktopHtml, 'repo-target'), has(panel, 'dshwb-select')],
  ['同步页：结果面板', has(desktopHtml, 'id="result"'), has(panel, 'dshwb-result')],

  // 仓库页
  ['仓库页：刷新按钮', has(desktopHtml, '>刷新<'), has(panel, "'刷新'")],
  ['仓库页：补写标识', has(desktopHtml, 'stamp-all'), has(panel, 'stampAll')],
  ['仓库页：加入已有仓库', has(desktopHtml, 'adopt-repo'), has(panel, 'openAdoptModal')],
  ['仓库页：新建仓库', has(desktopHtml, 'add-repo-tab'), has(panel, 'openCreateModal')],
  ['仓库页：刷新时间戳', has(desktopHtml, 'repo-freshness'), has(panel, '已刷新')],
  ['仓库页：未识别标签页', desktopJs.includes('UNKNOWN_TAB'), has(panel, 'renderUnknown')],
  ['仓库页：认领未识别', desktopJs.includes('claimUnknownRepo'), has(panel, 'claim')],
  ['仓库页：远端卡片带证据标签', desktopJs.includes('confidence'), has(panel, 'confidencePill')],

  // 本机仓库卡片
  ['本机卡片：远端内容', desktopJs.includes("'远端内容'"), has(panel, '远端内容')],
  ['本机卡片：编辑', /el\('button', 'btn ghost xs', '编辑'\)/.test(desktopJs), has(panel, "'编辑'")],
  ['本机卡片：移除', desktopJs.includes("'移除'"), has(panel, '移除')],
  ['本机卡片：已克隆标记', desktopJs.includes("'已克隆'"), has(panel, '已克隆')],
  ['本机卡片：本地大小', desktopJs.includes('sizeOnDisk'), has(panel, 'sizeOnDisk')],

  // 账号页
  ['账号页：网络通道', has(desktopHtml, 'probe-network'), has(panel, 'probe')],
  ['账号页：帮助链接', has(desktopJs, 'token-help'), has(panel, '打开 GitHub 创建令牌')],

  // 选项页
  ['选项页：目录选择', has(desktopJs, 'setWorkspaceRoot'), has(panel, 'setPath')],
  ['选项页：追加软件', has(desktopJs, 'addCustomSource'), has(panel, 'addCustomSource')],
  ['选项页：诊断复制', has(desktopJs, 'copy-diag'), has(panel, '已复制')],
];

console.log('功能对照（桌面端 / 插件端）\n');
let onlyDesktop = [];
for (const [name, d, p] of items) {
  const dMark = d ? '有' : '无';
  const pMark = p ? '有' : '无';
  const flag = d && !p ? '  ← 插件缺' : (!d && p ? '  ← 桌面缺' : '');
  console.log(`  ${name.padEnd(26)} 桌面:${dMark}  插件:${pMark}${flag}`);
  if (d && !p) onlyDesktop.push(name);
}
console.log('\n插件端缺失的功能：');
if (onlyDesktop.length === 0) console.log('  （无）');
else for (const n of onlyDesktop) console.log('  - ' + n);
