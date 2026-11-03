// 把 panel.js 里三个「在 render 函数里直接调 hooks」的弹窗，改成独立组件。
// React 错误 #310 就是 hooks 数量在两次渲染之间变化导致的。
import fs from 'node:fs';

const file = 'E:/AITools/wbpro/跨电脑同步/plugins/shared/panel.js';
let src = fs.readFileSync(file, 'utf8');

// 1) renderModal 改成渲染组件（而不是调用函数）
src = src.replace(
  `    function renderModal() {
      if (modal.kind === 'create') return renderCreateModal();
      if (modal.kind === 'adopt') return renderAdoptModal();
      if (modal.kind === 'browse') return renderBrowseModal();
      return null;
    }`,
  `    function renderModal() {
      // 注意：这里必须「渲染组件」而不是「调用函数」。
      // 直接把带 useState 的函数当普通函数调用，会让 hooks 挂在父组件上，
      // 弹窗一开一关就报 React error #310（hooks 数量变化）。
      if (modal.kind === 'create') {
        return h(CreateRepoModal, {
          source: currentSource,
          busy,
          onClose: () => setModal(null),
          onSubmit: createRepo,
          notify,
        });
      }
      if (modal.kind === 'adopt') {
        return h(AdoptRepoModal, {
          boot,
          repos,
          busy,
          call,
          onClose: () => setModal(null),
          onSubmit: adoptByAddress,
          notify,
        });
      }
      if (modal.kind === 'browse') {
        return h(BrowseDirModal, {
          target: modal.target,
          call,
          boot,
          onClose: () => setModal(null),
          onPicked: async () => {
            const info = await call('bootstrap');
            setBoot(info);
            await refreshSources();
          },
          notify,
        });
      }
      return null;
    }`,
);

// 2) 删掉原来的三个 renderXxxModal 函数（从注释开始到文件末尾前的最后两个花括号）
const marker = `    /** 新建仓库（对应桌面端的「＋ 给这个软件新建仓库」）。 */`;
const idx = src.indexOf(marker);
if (idx < 0) throw new Error('找不到弹窗函数起点');
// 截到 "  };\n}" 之前
const tailIdx = src.lastIndexOf(`  };\n}`);
if (tailIdx < 0) throw new Error('找不到组件结尾');
src = src.slice(0, idx) + src.slice(tailIdx);

fs.writeFileSync(file, src, 'utf8');
console.log('renderModal 已改为渲染组件，旧函数已移除');
