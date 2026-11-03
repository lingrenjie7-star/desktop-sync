# 跨电脑同步 · 插件版

给 DSH（DeepSeek Harness）和 WorkBuddy 各做一个插件，入口挂在各自应用的**左侧边栏**。
功能和桌面客户端一致：同步 / 仓库 / 账号 / 选项。

---

## 目录

```
plugins/
  shared/core.mjs      两个平台共用的宿主核心（包装同步引擎）
  dsh/                 DSH 插件的源码（host.mjs + client.js + 清单）
  workbuddy/           WorkBuddy 扩展的源码（service.mjs + remoteEntry.js + 清单）
  NOTES.md             两个平台的插件机制调研结论（实测，别凭印象改）
dist/
  dsh/dshwb-sync/      DSH 插件构建产物
  workbuddy/dshwb-sync/ WorkBuddy 扩展构建产物
tools/
  build-dsh-plugin.mjs
  build-workbuddy-extension.mjs
  test-dsh-plugin.mjs / test-dsh-endpoint.mjs / test-dsh-installed.mjs
  test-workbuddy-extension.mjs
```

构建：

```powershell
# 用任意 Node（>=20）执行
node tools/build-dsh-plugin.mjs
node tools/build-workbuddy-extension.mjs
```

自检（不需要真的启动两个应用）：

```powershell
node tools/test-dsh-plugin.mjs
node tools/test-dsh-endpoint.mjs
node tools/test-workbuddy-extension.mjs
```

---

## 一、DSH 插件

### 它长什么样

左侧边栏多一个「跨电脑同步」图标，点开是主面板：

| 页 | 内容 |
|---|---|
| 同步 | 按「工作区 → 对话」勾选，上传 / 下载 |
| 仓库 | 本机仓库、GitHub 上可加入的仓库、「未识别」仓库认领、补写标识 |
| 账号 | 连接 / 断开 GitHub，网络通道检测 |
| 选项 | 目录概览、诊断信息 |

### 安装

产物在 `dist/dsh/dshwb-sync/`。装到一个 profile 里：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$dest    = "$profile\node_modules\dshwb-sync"

# 1. 复制插件
Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item .\dist\dsh\dshwb-sync $dest -Recurse

# 2. 让 profile 认得它（改 package.json 的 dsh.profile.bundles 和 dependencies）
#    "bundles": [ ..., "dshwb-sync" ]
#    "dependencies": { ..., "dshwb-sync": "file:./node_modules/dshwb-sync" }

# 3. 让配置树挂上它（cordis.patch.yml 末尾追加）
#    - id: dshwb-sync
#      name: dshwb-sync
```

改完**重启 DSH**。侧边栏出现图标即成功。

### 架构（为什么这么写）

- **宿主半边**跑在 DSH 的 Node 进程里，负责所有真实操作（git、文件、GitHub API）。
- **浏览器半边**只做渲染和调用。
- 两者用 **HTTP 路由**通信（`POST /api/dshwb-sync`），不是 `ctx.remote`：
  `ctx.remote` 需要 Typert 代码生成，对第三方插件是过重的构建链；
  而 `dsh-host-webserver` 只需要 `register({ kind, path, handler })`。

### 安全

- 路由挂在 DSH 自己的 webserver 上，默认只监听 loopback，且由 DSH 的连接层鉴权。
- 额外加了一道进程内随机口令（`x-dshwb-token`），挡住同机其它网页的 CSRF 调用。
  `bootstrap` 是唯一不需要口令的方法——它就是下发口令的那一步。
- **令牌以明文保存**：DSH 宿主进程没有 Electron 的 `safeStorage`。
  界面会明确提示这一点，不会假装已加密。

---

## 二、WorkBuddy 扩展

### 它长什么样

`extension.json` 的 `ui.entry.title = "跨电脑同步"`，WorkBuddy 会给它一个入口；
点开是同样的四个页签。

### 安装

产物在 `dist/workbuddy/dshwb-sync/`，是一个标准扩展目录：

```
dshwb-sync/
  extension.json
  assets/icon.svg
  ui/assets/remoteEntry.js     ← 模块联邦容器，expose './Main'
  server/index.cjs             ← 后台服务，export activate(wb)
```

把整个目录放进 WorkBuddy 的扩展位置之一：

- 内置：`<WorkBuddy 安装目录>\resources\app.asar.unpacked\resources\extensions\`
- 用户级：`%USERPROFILE%\.workbuddy\plugins\cache\<marketplace>\dshwb-sync\<version>\`
  （目录里带 `.workbuddy-plugin/plugin.json`，并登记到 `installed_plugins.json`）

**推荐内置位置**：它已经有 `app.asar.unpacked` 目录，直接放进去不需要改注册表。

### 架构（关键：两半如何通信）

WorkBuddy 的扩展分两半，且**渲染层没有 Node 权限**：

| 半边 | 能力 | 职责 |
|---|---|---|
| `server/index.cjs`（`activate(wb)`） | 完整 Node | 跑同步引擎 |
| `ui/assets/remoteEntry.js` | 只有浏览器 API | 渲染 + 调后台 |

所以后台服务启动时监听 `127.0.0.1:<随机端口>`，并把
`{ port, secret }` 写到用户数据目录的 `dshwb-sync-endpoint.json`；
UI 半边通过 `window.__wbInvoke` 读这个文件，拿到端口和口令后开始对话。

读不到文件时，界面会显示「手填端口 + 口令」的降级表单，而不是白屏。

### 构建上的两个坑（已修，写下来免得再踩）

1. **文件名冲突**：引擎自己有 `core.mjs`（路径/哈希工具），
   插件核心也叫 `core`。两者都输出成 `lib/core.cjs` 会互相覆盖，
   症状是运行期莫名其妙的 `expandHome is not a function`。
   现在插件核心叫 `lib/plugin-core.cjs`。

2. **ESM → CJS 的 export**：`export function foo` 去掉 `export` 之后，
   CJS 里就再也拿不到 `foo` 了。构建脚本现在会收集所有导出名并生成
   `module.exports`；如果源码里出现构建脚本不认识的 import，会**直接构建失败**
   而不是生成一份坏产物。

### 运行时踩过的坑（更隐蔽，务必看）

1. **`inject` 必须是字符串数组**

   ```js
   export const inject = ['webServer'];                                     // ✅
   export const inject = { required: ['webServer'], optional: ['logger'] }; // ❌
   ```

   写成对象时，Loader 会把 `required` / `optional` 当成**服务名**去找，
   永远找不到，插件停在 pending：
   `dshwb-sync: pending (waiting for services: required, optional)`。
   看着像「服务没起来」，其实是声明格式错了。已有回归测试守住这一条。

2. **客户端 bundle 没有独立 URL**

   `/plugins/dshwb-sync/client.js` 是 404 —— 真实地址是合并后的
   `/plugins/??a/client.js,b/client.js&rev=...`。
   判断插件有没有被下发，要看首页 HTML 里有没有你的包名：

   ```
   plugins/??...,dshwb-sync/client.js,...&rev=...
   ```

   直接请求自己的路径会得到 404，很容易误判成「插件没装上」。

3. **`/` 需要登录态**：不带 cookie 抓首页是 401。
   验证时先 `GET /?token=<启动时打印的令牌>` 换一次 cookie。


---

## 三、与桌面客户端的关系

- **配置完全共用**：都读写 `%USERPROFILE%\.dshwb-sync\config.json`。
  在客户端里登录过，插件里就是已登录状态（令牌文件同一个）。
- **引擎是同一份代码**：构建时从 `app/lib/` 内联，修 bug 只需重新构建。
- **差异只在加解密**：客户端用 `safeStorage`，插件没有，所以 `tokenMode` 会显示 `plain`。

---

## 四、已知限制

- **DSH 插件要求 Web 组合**：宿主半边需要 `webServer` 服务。
  在 headless 组合下 apply 会告警并退出，不会崩。
- **WorkBuddy 扩展的 endpoint 自动发现是「尽力而为」**：
  `__wbInvoke` 的可用通道随版本变化，读不到就退回手填。这不会影响功能，只是多一步。
- **两种插件都不做后台常驻同步**：同步仍是用户点按钮触发，
  和桌面客户端行为一致（刻意不做双向自动同步）。
