# 非官方桌面应用

[English](README.md) | 中文

此桌面应用是非官方衍生版本，并非 DeepSeek 发布版本。它把现有 DeepSeek Harness Web profile 封装在轻量 Tauri 壳中；桌面专属代码加入 Session selection 持久化和下载完成反馈，但不重新实现界面，也不复制 Codex UI。Tauri 使用操作系统 WebView，原生 sidecar 提供后端，因此最终用户不需要安装 Node.js、pnpm 或 Rust。

## 支持的目标

| 目标映射 | 构建宿主要求 | Tauri 安装包 | 自动发布目标 |
| --- | --- | --- | --- |
| macOS 15.0+ arm64 | macOS arm64 | app、DMG | arm64 DMG |
| Windows x64 | Windows x64 | NSIS | x64 NSIS |
| Linux x64 GNU | Linux x64 GNU | deb | x64 deb |

所有映射仅支持原生宿主构建。脚本根据当前 Node.js 进程确定 `pkg`、Rust 和 `node-pty` 目标名称，不接受跨目标覆盖参数。

## Windows x64 功能限制

Windows x64 发布包不支持持久 Bash 会话或持久 Shell 会话。请使用普通的非持久 PowerShell 命令执行。命令之间不会保留工作目录、环境变更、别名等 Shell 状态。因此，Windows 安装包与 macOS、Linux 安装包并非功能完全一致。

## 前置条件

- 在所有平台上安装 Node.js 24.19.0、pnpm 11.7.0 和仓库锁定的依赖。
- 安装 Rust 1.94.0。在 macOS 15.0 或更高版本上还需安装 Xcode Command Line Tools。在 Windows 上安装 Microsoft C++ Build Tools、包含 `signtool.exe` 的 Windows SDK 和 WebView2 构建前置组件。
- 在 Debian 或 Ubuntu Linux 上安装 Tauri 所需的 WebKit、AppIndicator、SVG、OpenSSL、XDO 和打包依赖：

```sh
sudo apt-get install build-essential file libayatana-appindicator3-dev librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev patchelf
```

## 构建

使用以下命令构建生产 Web 应用、封闭式 Node SEA sidecar 和当前平台的默认原生安装包：

```sh
pnpm run desktop:build
```

需要时可以选择当前平台的安装包格式。Linux Release 使用：

```sh
pnpm run desktop:build -- --bundles deb
```

发布工作流先用 `--prepare-only` 构建真实原生 sidecar 并执行冒烟测试，再用该 sidecar 运行 Rust 测试，最后用 `--skip-prepare` 执行 Tauri 打包。这两个参数只拆分一次原生构建，均不能选择其他目标。

产物写入 `src-tauri/target/release/bundle/`。如需启动未打包的开发窗口，请使用 `pnpm run desktop:dev`。

## 发布

[桌面发布工作流](../.github/workflows/desktop-release.yml)由 `desktop-v*` 标签或手动调度触发。手动发布必须选择准确的 `desktop-v<version>` 标签；未选择标签的手动运行只能构建和验证。因此，版本 `0.1.0-rc.8` 从 `desktop-v0.1.0-rc.8` 发布。

工作流在匹配的 GitHub 托管运行器上构建 macOS arm64、Windows x64 和 Linux x64。每个任务都会核对原生宿主、执行 sidecar 运行时冒烟测试、运行 Rust 测试、检查安装包架构与签名状态，并在上传工作流产物前生成 SHA-256 清单。

只有最终任务拥有 `contents: write` 权限。该任务使用名为 `desktop-release` 的 environment，只下载 3 个成功构建产物，要求 3 个安装包全部存在，并重新校验每个 SHA-256 摘要。任务拒绝既有 Release 或任何意外远端文件；只有远端资产名称集合与已验证的 4 个文件完全一致时，才会公开草稿。

| Release 产物 | 签名状态 |
| --- | --- |
| `Unofficial-DeepSeek-Harness-Desktop_0.1.0-rc.8_macos-arm64_app-adhoc_dmg-unsigned.dmg` | DMG 未签名；其中 app 使用 ad-hoc 签名，没有 Developer ID 签名或公证 |
| `Unofficial-DeepSeek-Harness-Desktop_0.1.0-rc.8_windows-x64_unsigned-setup.exe` | 未签名 |
| `Unofficial-DeepSeek-Harness-Desktop_0.1.0-rc.8_linux-x64_unsigned.deb` | 未签名 |

`SHA256SUMS.txt` 覆盖 Release 中的全部 3 个安装包。

## 运行时模型

Tauri 窗口先打开本地启动页。Rust 生成新的 256 位 API 凭据，只通过 sidecar 启动环境传入凭据，再在操作系统分配的 `127.0.0.1` 端口启动已打包的 `dsh web`。CLI 会在保存启动环境快照或导入动态 profile 插件前读取并删除该环境变量；Connection Host 只能得到冻结的布尔校验器，不能得到凭据。Rust 严格校验 loopback 就绪 URL 后，再让系统 WebView 导航至现有 Harness 界面。启动页不具备任何 Tauri JavaScript capability 或原生命令接口。

不可变的顶层 frame 初始化脚本只为同源 `/api` HTTP 请求加入 `Authorization: Bearer <凭据>`。两条事件 WebSocket 使用严格按顺序排列的 `dsh-v1` 与 `dsh-auth-<凭据>` 双 subprotocol。只有同源且已认证的 `/api` 请求成功后，桌面壳才会判定启动完成。

在 macOS 上，loopback 端口会随每次启动变化。客户端会在常规启动前通过 WebView 主机级存储恢复经校验且有大小限制的当前 Session selection，并同步后续选择。首次迁移还没有持久 selection 时，会打开最近更新、未归档的非空白 Session，而不会创建只在启动时出现的空白草稿。Session Log 下载仍由 WebView 下载管理器负责。由于 anchor 下载不能携带 bearer header，认证成功的 `HEAD /api/session.export` 预检会返回新的 256 位票据。浏览器只能在 30 秒内使用该票据一次；GET 的路径和其余 query 必须完全匹配。一个最终原生事件会把已完成下载及其实际保存文件名反馈给现有 Web 弹窗；完成事件缺失或格式不正确时，两分钟后判定失败。

非官方应用使用 `io.github.ucas-liumk.deepseek-harness-desktop` 标识符，使其操作系统应用数据目录与官方应用隔离。关闭主窗口或退出应用时，会先终止 sidecar，再结束桌面进程。

## 本地 API 边界

bearer 与 WebSocket 凭据会阻止盲扫端口和不知道本次启动 secret 的普通本机客户端。原有的 loopback `Host`、同源和跨站请求检查仍会执行。此机制无法隔离当前操作系统账户；该账户下的其他进程仍可能通过进程内存、环境检查或调试取得 secret。不要把 loopback 服务暴露到网络。

普通 `dsh web` 启动没有桌面 authorizer，仍保持上游未认证的 Web 行为。它不会签发或要求桌面下载票据。

## Anthropic 再分发边界

源码树保留上游 `@anthropic-ai/claude-agent-sdk` 集成，但安装包排除 `@anthropic-ai/claude-agent-sdk` 主包和所有可选的 `@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*` 平台包。编译 SEA 前，扫描只要发现任何残留 SDK 主包、平台包或 `claude`／`claude.exe` 可执行文件，便会终止构建。

默认封闭式 Web profile 运行时没有启用 Claude Code 子智能体插件。今后的构建如启用该插件，必须要求用户按 Anthropic 条款单独安装 Claude Code，并确保可以从 `PATH` 找到原生 `claude` 可执行文件。桌面安装包不分发、安装或认证该可执行文件。

封闭式可执行文件包含其他随附插件。此桌面构建不支持额外安装仓库外 Node 插件；请先在仓库中加入并验证插件，再生成新的桌面包。

每个安装包均包含上游 `LICENSE`、`THIRD_PARTY_NOTICES.md`、生成的 `THIRD_PARTY_LICENSES` 闭包和双语 [`DISTRIBUTION_BOUNDARY.md`](DISTRIBUTION_BOUNDARY.md)。许可证生成器读取实际 staging npm 闭包、按目标平台筛选的 Cargo lock 闭包、内嵌 Node 运行时声明、SEA 编译器来源，以及 Release 资产中明确列入清单的安装程序启动或运行时字节。生成器不声称完整覆盖纯打包工具闭包，因为这些工具不作为应用依赖随包分发。已声明清单中的许可证数据缺失或不受支持时，构建会终止。分发说明明确：上游所有者针对 Anthropic SDK 和平台载荷获得的身份限定授权，不会转移给此衍生项目。说明也记录 DeepSeek、OpenAI 和 Codex 的商标边界。Codex 仅提供稳定性思路；此桌面壳不复制 Codex 代码或 UI 资源。

## 分发限制

- 产品名称和 Release 标题均标明“非官方”；应用使用衍生项目自有的 `DSH` 终端图标和应用标识符。
- DMG 容器未签名；其中 app 只使用 Tauri 配置的 ad-hoc 身份。工作流先移除 Windows SEA 中已经失效的 Node.js 签名，再要求所有 Windows 二进制文件报告 `NotSigned`；流程不会暗示或使用签名 secret。
- 当前不包含自动更新。
