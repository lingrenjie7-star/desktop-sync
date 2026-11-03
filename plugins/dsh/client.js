/**
 * DSH 插件的浏览器半边。
 *
 * 这是一个 **模块加载器工厂**，不是普通 ESM 模块 —— DSH 的客户端模块系统
 * 只执行 `window.__ModuleLoader__.load({ id, factory })`，由 factory 返回 exports。
 * 详见 plugins/NOTES.md。
 *
 * 界面本体在 plugins/shared/panel.js（构建时内联到本文件的占位符位置），
 * 这里只负责两件事：
 *   1. 侧边栏标签 + 主面板的 slot 注册；
 *   2. 提供 call() —— 通过 HTTP 调宿主半边的 /api/dshwb-sync。
 */

const DSHWB_PANEL_ID = 'dsh-dntb';
const DSHWB_ROUTE = '/api/dsh-dntb';

window.__ModuleLoader__.load({
  id: 'dsh-dntb',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');

    // ───────────────────────────────────── 宿主通信

    /** 进程内口令，bootstrap 时拿到。 */
    let callToken = '';

    async function call(method, args) {
      const headers = { 'Content-Type': 'application/json' };
      if (callToken) headers['x-dshwb-token'] = callToken;

      const response = await fetch(DSHWB_ROUTE, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method, args }),
      });

      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.json())?.error ?? '';
        } catch {}
        return { ok: false, error: detail || `宿主返回 ${response.status}` };
      }
      const json = await response.json();
      // bootstrap 会带回会话口令，之后每个请求都带上
      if (method === 'bootstrap' && json?.token) callToken = json.token;
      return json;
    }

    // ───────────────────── 共享面板（构建时把 plugins/shared/panel.js 内联到这里）
    /* __DSHWB_SHARED_PANEL__ */

    /** 侧边栏图标：跟随宿主要求的尺寸与选中态。 */
    function PanelIcon({ size }) {
      return jsxRuntime.jsx('svg', {
        width: size ?? 18,
        height: size ?? 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        children: [
          jsxRuntime.jsx('path', { d: 'M4 7h9' }),
          jsxRuntime.jsx('path', { d: 'M4 12h6' }),
          jsxRuntime.jsx('path', { d: 'M4 17h9' }),
          jsxRuntime.jsx('path', { d: 'M16 5.5l3 2.5-3 2.5' }),
          jsxRuntime.jsx('path', { d: 'M20 13.5l-3 2.5 3 2.5' }),
        ],
      });
    }

    const inject = ['slots', 'layout', 'locale'];

    function apply(ctx) {
      const Panel = dshwbCreatePanel({ React: react, call });
      dshwbEnsureStyles(document);

      // 主面板：key 必须与侧边栏的 id 相同
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register(
          { name: 'main', key: DSHWB_PANEL_ID },
          Panel,
        );
      });

      // 侧边栏标签：这里用的是 id（不是 key）
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: DSHWB_PANEL_ID,
            order: 40,
            label: () => '跨电脑同步',
          },
          PanelIcon,
        ),
      );
    }

    module.exports = {
      name: 'dsh-dntb',
      inject,
      apply,
    };
    return module.exports;
  },
});
