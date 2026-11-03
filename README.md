# 跨电脑同步 · 桌面客户端

在两台电脑之间接续 **DeepSeek Harness** 与 **WorkBuddy** 的工作。
逐项勾选工作区 / 对话，传到你自己的私有 GitHub 仓库。

绿色版免安装，不写注册表；配置存在 `%USERPROFILE%\.dshwb-sync`。

> 同一套引擎还有 [DSH 插件](https://github.com/lingrenjie7-star/dsh-sync)
> 和 [WorkBuddy 扩展](https://github.com/lingrenjie7-star/wb-sync)。

## 和插件版的区别

| | 插件版 | 桌面版 |
|---|---|---|
| 令牌存储 | 明文（普通 Node 进程，没有 `safeStorage`） | **系统加密**（Electron `safeStorage`） |
| 入口 | DSH 左侧边栏 / WorkBuddy 面板 | 独立窗口 |
| 依赖 | 需要 DSH 或 WorkBuddy | 无 |

这台机器不是你独占的话，建议用桌面版 —— 令牌由 Windows 凭据保护。

## 源码结构

```
app/
  main.mjs          Electron 主进程（IPC、窗口、自检入口）
  preload.cjs       暴露给渲染层的白名单 API
  lib/
    core.mjs        哈希、原子写、zstd 会话编解码、git 调用
    engine.mjs      仓库管理 + 同步引擎
    github.mjs      GitHub API（建仓/改属性/删除/限流探测）
    discover.mjs    扫描账号下的仓库并按证据归类
    identity.mjs    仓库身份标识（dshwb-sync.json）
    browser.mjs     远端内容浏览、对比、删除
    storage.mjs     配置与令牌存取
    sources/        各软件适配器（DSH / WorkBuddy / 通用目录）
  ui/               界面（纯 HTML/CSS/JS，无框架）
plugins/            插件的共享实现（与插件版同源）
tools/              构建与测试脚本
```

## 自己打包

需要 Electron 打包工具：

```bash
npx @electron/packager app "跨电脑同步" --platform=win32 --arch=x64 --out=dist
```

打出来的目录就是绿色版：双击 exe 即可运行。

## 测试

```bash
# 需要 Electron 提供的 node（ELECTRON_RUN_AS_NODE=1）
node tools/test-e2e-crossmachine.mjs   # DSH 跨机同步
node tools/test-e2e-workbuddy.mjs      # WorkBuddy 跨机同步
node tools/test-browse.mjs             # 远端内容浏览/对比/删除
node tools/test-refresh.mjs            # 刷新行为
node tools/test-delete-remote.mjs      # 删除远端文件
node tools/test-auto-adopt.mjs         # 自动接入规则
```

## 自检入口

桌面版带三个环境变量入口，用于排查问题：

| 变量 | 作用 |
|---|---|
| `DSHWB_SHOT=<目录>` | 启动后自动截图各页面并导出状态 JSON |
| `DSHWB_LOGIN=<令牌>` | 非交互式登录（脚本化） |
| `DSHWB_PROBE=<文件>` | 诊断：令牌能不能读、建仓为什么失败，结果写进文件 |

`DSHWB_PROBE` 很有用 —— 403 这类错误的真正原因只写在 GitHub 的
响应头/响应体里，它会把这些原文打出来。

## 两个软件的左侧栏为什么能显示同步来的对话

机制不同，这是最容易混淆的地方：

| | DSH | WorkBuddy |
|---|---|---|
| 界面数据源 | `~/.dsh/storages/workspace.json` | `~/.workbuddy/workbuddy.db`（sqlite） |
| 只放文件够不够 | 不够，要写 json | **不够，要写 sqlite 表** |

DSH 侧还要注意：「勾了工作区就带上它的对话」需要一张「对话 → 工作区」索引，
这张索引**同时来自本机和远端仓库**。新机器本机是空的，只看本机会把
远端来的对话当成「未勾选」跳过 —— 表现为工作区同步过来了、但里面是空的。

## 已知限制

- 需要目标机器上配置过「工作区根目录」，否则路径映射会失败
  （对话照样同步，但点开会找不到原始目录 —— 不会凭空造目录）
- WorkBuddy 侧要求目标机器先运行过一次 WorkBuddy
- 不做后台自动同步，永远由你点按钮触发

## 许可证

[MIT](LICENSE)
