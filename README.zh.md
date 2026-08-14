# 非官方 DeepSeek Harness Desktop

[English](README.md) | 中文

此仓库把现有 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面和运行时封装为原生桌面应用。用户看到的是上游 Web profile，不是重新实现的相似界面。桌面壳使用 Tauri、操作系统 WebView 和随应用提供的 Node SEA sidecar。

这是非官方衍生版本。DeepSeek 未发布、赞助或认可此应用。桌面基础来自 [GTC2080/deepseek-harness-desktop](https://github.com/GTC2080/deepseek-harness-desktop)；此分支新增 Linux 安装包、统一的原生发布矩阵、再分发防护和运行时加固。

## 下载

只有全部原生构建和安装包检查通过后，发布工作流才会把 `desktop-v0.1.0-rc.8` 发布到 [GitHub Releases](https://github.com/ucas-liumk/deepseek-harness-desktop/releases)。

| 平台 | Release 安装包 | 签名状态 |
| --- | --- | --- |
| macOS 15.0+ arm64 | DMG | DMG 未签名；其中 app 使用 ad-hoc 签名且未公证 |
| Windows x64 | NSIS 安装程序 | 未签名 |
| Linux x64 | deb | 未签名 |

`SHA256SUMS.txt` 覆盖全部 3 个安装包。三个原生宿主任务全部通过后，Release 才会公开。

## 桌面层新增内容

- 桌面层在操作系统分配的 `127.0.0.1` 端口启动打包运行时，并且只允许主 WebView 访问本次启动的准确 origin。
- 桌面应用每次启动都会生成新的 256 位 API 凭据。同源 `/api` HTTP 请求使用 `Authorization: Bearer <凭据>`；两条事件 WebSocket 使用准确的双 subprotocol 凭据。
- 每次构建都会真实启动 sidecar，获取全部已发现的浏览器插件 bundle，并校验智能体预设列表及默认项。
- 启动时间有上限。用户可见错误不包含原始 stderr。关闭窗口或应用时会清理 sidecar。
- 应用使用衍生项目自有的 `DSH` 终端图标，不使用 DeepSeek 的鲸鱼标志。
- macOS、Windows、Linux 均在原生 runner 上构建。流程检查可执行文件架构、签名状态和每个安装包摘要。
- 安装包排除 Anthropic Agent SDK 主包、平台包和随附的 `claude` 可执行文件。每个安装包都包含上游许可证、生成的完整第三方许可证文本和双语再分发说明。

这些稳定性模式参考了开源 [OpenAI Codex](https://github.com/openai/codex) 仓库。本项目不复制 Codex 界面或产品素材。

## 已知限制

- DeepSeek Harness 0.1 是开发者预览版，因此此桌面版本也标记为 prerelease。
- Windows x64 不支持持久 Bash 或持久 Shell 会话。请使用非持久 PowerShell 命令；Windows 与 macOS、Linux 并非功能完全一致。
- macOS arm64 包要求 macOS 15.0 或更高版本，且没有 Developer ID 签名或公证。Windows 和 Linux 包未签名。当前没有自动更新。
- Linux x64 deb 在 Ubuntu 22.04 上构建，需要兼容的 Debian 系 GNU/Linux 系统和 WebKitGTK 4.1。
- 默认封闭式 Web profile 没有启用 Claude Code 子智能体插件。安装包不分发或安装 Claude Code。
- 桌面 API 认证会阻止盲扫端口和不知道本次启动凭据的普通本机请求，但它不是沙箱。同一操作系统账户下的进程仍可能通过进程内存、环境检查或调试取得凭据。不要把 loopback 服务暴露到网络。
- 普通 `dsh web` 启动仍保持上游未认证的 Web 行为。只有原生壳启动打包运行时，才会启用桌面专属凭据和一次性下载票据。

准确说明见[桌面构建与发布文档](desktop/README.md)和[分发边界](desktop/DISTRIBUTION_BOUNDARY.md)。

<a id="run"></a><a id="run-from-source"></a>

## 从源码构建

先安装 Node.js、pnpm、Rust 和目标操作系统所需的 Tauri 原生依赖，然后运行：

```sh
pnpm install --frozen-lockfile
pnpm run desktop:build
```

只支持原生宿主构建。产物写入 `src-tauri/target/release/bundle/`。

## 许可证与署名

DeepSeek Harness 代码依据上游 [MIT License](LICENSE) 使用。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 汇总直接依赖条款；每次桌面构建还会生成完整许可证文本并放入安装包。MIT 许可证不授予 DeepSeek 商标权。
