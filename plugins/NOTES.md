# DSH / WorkBuddy 插件机制调研（实测结论）

> 这份文件记录的是从本机实际安装的程序里读出来的契约，不是猜测。
> 来源：`E:\AITools\DSH\resources\app.asar`、`E:\AITools\WorkBuddy\resources\app.asar(.unpacked)`

---

## 一、DSH 插件（Cordis 插件）

### 包的形状

```jsonc
{
  "name": "dsh-xxx",
  "type": "module",
  "main": "lib/index.js",          // 宿主半边
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",  // 浏览器半边
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [ /* 需要的客户端服务，如 @deepseek-ai/dsh-client-ui-slots */ ],
      "platform": "web"
    }
  }
}
```

### cordis.patch.yml

```yaml
- insert:
    - id: dsh-xxx           # 必须全局唯一，且与包名一致
      name: 'dsh-xxx'       # 解析到 lib/index.js
```

**坑**：`id:` 那一行后面绝不能写行尾注释，商城预检用正则抓值，带注释会判 SUBMISSION_ENTRY_MISSING。

### 侧边栏标签（这才是用户要的「左侧边栏标签」）

侧边栏由 `@deepseek-ai/dsh-client-ui-sidebar` 提供，它有两个关键 seat：

| slot | 作用 |
|---|---|
| `sidebar.panellist` | 导航区的**全局面板入口列表**（图标 + 标签） |
| `main` (keyed by panel id) | 点开后在主内容区渲染的面板 |

`sidebar.panellist` 注册的 `id` 与 `main` 注册的 `key` **必须相同**，
选中一个不存在的 main key 会抛错且不改变当前选择。

真实注册代码（来自 `dsh-client-ui-plugin-manager`，已实测）：

```js
ctx.slots.inject('main', function* () {
  yield ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    store,                                  // 可选：面板内部状态
    inject: () => face,                     // 传给组件的 props
    children: { /* 可选：子 slot 声明 */ }
  }, PluginManagerPage);
});

ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: PANEL_ID,
  order: 0,
  label: () => t('panel'),                  // 可见文字 + 无障碍名 + 折叠时 tooltip
  locale: NS
}, PluginsPanelIcon));
```

- `main` 用 **`key`**；`sidebar.panellist` 用 **`id`**。两者写混会静默失效。
- `label` 是函数（支持随语言变化）；纯字符串也可以。
- 布局侧用 `ctx.layout.selectPanel(id)` 切换面板；`null` 回到对话。

### 浏览器半边的入口协议

`lib/client.js` 必须自己调用模块加载器注册工厂：

```js
window.__ModuleLoader__.load({
  id: 'dsh-xxx',            // 必须等于包名
  factory: makeFactory(),
});

function makeFactory() {
  return (require) => {
    const module = { exports: {} };
    // addEventListener 等全局在工厂执行时可用
    const inject = ['slots', 'layout', 'locale'];   // 声明的服务
    function apply(ctx) {
      ctx.slots.inject(/* ... */);
    }
    module.exports = { apply, inject, name: 'dsh-xxx' };
    return module.exports;
  };
}
```

- 包在一个 IIFE 里；**不要在顶层做副作用**，工厂被调用时才物化。
- `require` 只能解析平台种子模块表 + 本包 chunk，普通 npm 包解析不到。
- React 通过 `require('react')` 拿（在 `dsh.client.external` 或种子表里）。

### 可用服务（客户端）

`ctx.slots`、`ctx.layout`（`selectPanel`）、`ctx.locale`、`ctx.modules`、
`ctx.remote`（宿主 RPC）、`ctx.get(name)` 取任意已注册服务。

宿主半边拿到的是 Node 能力（fs/path/child_process 等），
与浏览器半边通过 `ctx.remote` / Remote 命名空间通信。

### 三个会让插件「静默失效」的坑（实测踩过）

1. **`inject` 必须是字符串数组**

   ```js
   export const inject = ['webServer'];                                       // ✅
   export const inject = { required: ['webServer'], optional: ['logger'] };   // ❌
   ```

   写成对象时 Loader 把它当成永远无法满足的依赖，插件停在 pending，
   日志只给一句 `<id>: pending (waiting for services: required, optional)`。
   **看起来像「服务没起来」，实际是自己声明错了。**

2. **`sidebar.panellist` 用 `id`，`main` 用 `key`** —— 写混会静默不显示。

3. **客户端 bundle 的 URL 是组合形式**

   `/plugins/dshwb-sync/client.js` **不**直接存在；
   真实地址是 `/plugins/??a/client.js,b/client.js&rev=...`（多包合并）。
   验证下发成不成功，要看首页 HTML 有没有把你这个包列进那个 combo，
   而不是直接请求自己那个路径（会 404，误导性很强）。

   验证方法：抓 `GET /`，在其中搜索包名，应看到
   `plugins/??...,dshwb-sync/client.js,...&rev=...`。

   另外：DSH 的 webserver 对 `/` 需要登录态（无 cookie 是 401），
   所以验证要带 `?token=<启动时打印的进程令牌>` 换一次 cookie。


---

## 二、WorkBuddy 扩展（Module Federation）

### 目录结构

```
resources/extensions/<id>/
  extension.json          # 清单
  distribution.json       # 分发信息（可选）
  assets/icon.svg
  ui/
    index.html            # 独立窗口时用（可选）
    assets/remoteEntry.js # 模块联邦入口（必须叫 remoteEntry.js）
  server/index.cjs        # 可选的后台服务
```

### extension.json

```jsonc
{
  "id": "my-ext",
  "name": "跨电脑同步",
  "version": "0.0.1",
  "description": "...",
  "ui": {
    "entry": {
      "title": "跨电脑同步",          // 侧边栏显示的名字
      "icon": "./assets/icon.svg",
      "url": "./ui/assets/remoteEntry.js",
      "keepAlive": true              // 可选：切走不卸载
    }
  },
  "service": {                       // 可选：后台进程
    "entry": "./server/index.cjs",
    "process": "fork"
  }
}
```

### 联邦契约（从 `extension-mount-*.js` 实测）

```js
// 宿主侧逻辑等价于：
const { remoteName, remoteEntry, exposedModule } = deriveFederationTuple(id, url, defaultUrl);
// exposedModule 固定是 './Main'
// remoteName = id，或 `id__<base36 hash>`（url 与默认值不同时）

await loadRemote(`${remoteName}/Main`);   // 取 default
```

所以扩展的 `remoteEntry.js` 必须 **expose `./Main`**，且默认导出是 React 组件：

```js
// remoteEntry.js（构建产物）
// 需要以模块联邦 remote 的形式暴露 './Main'
```

宿主把 `react` / `react-dom` / `react-dom/client` / `react-router-dom` /
`@genie/wb-components` / `@genie/cb-chat-ui` 作为 **singleton** 共享，
扩展必须把它们标记为 shared（singleton）并**不打包进自己的 bundle**，
否则会出现两份 React。

### 安装位置

- 内置：`resources/extensions/`（且被 `app.asar.unpacked` 解包）
- 用户级：`%USERPROFILE%\.workbuddy\plugins\cache\<marketplace>\<name>\<version>\`
  清单在 `<version>/.workbuddy-plugin/plugin.json`
- 注册表：`%USERPROFILE%\.workbuddy\plugins\installed_plugins.json`

**注意**：`~/.workbuddy/plugins/` 下的插件清单字段（`name/version/description/author/category/keywords/agents/workbuddy`）
与 `resources/extensions/<id>/extension.json` **不是同一套**。
前者是「技能/提示片段」插件，后者才是带 UI 的扩展。

---

## 三、两边必须共享的能力

同步引擎（`app/lib/`）原本是给 Electron 客户端写的，两处都能复用：

| 模块 | 依赖 | 能否直接在插件里用 |
|---|---|---|
| `core.mjs` | node:fs / zlib / child_process | DSH 宿主半边 ✅；WB service 半边 ✅ |
| `engine.mjs` | 同上 | ✅ |
| `github.mjs` | node:https | ✅ |
| `storage.mjs` | `os.homedir()` + `safeStorage` | ⚠️ 需替换加解密后端 |
| `discover/identity` | node:https | ✅ |

`storage.mjs` 用了 Electron 的 `safeStorage`，插件里没有这个能力，
需要抽象出一个 `CryptoBackend`（有 safeStorage 用它，没有就退回文件权限保护 + 明确警告）。

界面侧不能复用 `app/ui/*`（那是完整 HTML 应用），但**业务逻辑**要复用：
所以插件前端只做「调 host API + 渲染」，所有同步动作走 host。
