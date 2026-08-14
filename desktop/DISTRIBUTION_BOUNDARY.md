# Desktop Distribution Boundary

This notice applies to the installers for **Unofficial DeepSeek Harness Desktop**.

## Project status and attribution

- This application is an unofficial derivative. DeepSeek did not publish, sponsor, or endorse it.
- The application contains code from DeepSeek Harness under the upstream `LICENSE`, which is included with every installer.
- `THIRD_PARTY_NOTICES.md` is also included with every installer. Each dependency remains subject to its own terms.
- After target-native pruning, the build submits the exact physical npm package name/version set to npm's bulk advisory service. Network, HTTP, malformed-response, unexpected-package, and duplicate-record faults stop the build. High and critical advisories stop the build; the workspace lockfile is not used as a proxy for the distributed closure.
- `THIRD_PARTY_LICENSES/` is generated from that post-prune npm tree, the target-filtered `Cargo.lock` closure, the embedded Node.js runtime, and `@yao-pkg/pkg`. It records package identities, SPDX expressions, attribution, original license/notice text, source provenance, and SHA-256 hashes. It also contains fixed source archives, build recipes, and patches for retained native payloads, including complete source and original terms for all 29 components listed by the bundled sharp/libvips build and the exact Cargo source closure for ripgrep. Missing text, mismatched payloads or source archives, and unknown or forbidden licenses stop the build.
- The directory covers the installed application payload and the material compiler/runtime provenance used for the SEA. A DMG and a deb add no application runtime. The Windows target records the NSIS 3.11 zlib bootstrap and `nsis-tauri-utils` 0.5.3 as installer runtime components. Tauri CLI 2.11.4 and `tauri-bundler` 2.9.4 are identified as build tools, not application dependencies.
- The Linux Release publishes only the deb package. It does not publish an AppImage or redistribute the AppImage runtime and bootstrap.
- macOS frameworks, Windows WebView2 and system libraries, and Linux GTK/WebKit/system libraries supplied by the operating system or distribution are not copied into this application license directory. Linux package metadata declares its dynamic system-library dependencies separately.
- The derivative uses its own `DSH` terminal application icon rather than DeepSeek's whale mark.
- The MIT license does not grant rights to the DeepSeek name, logo, or other trademarks. No DeepSeek trademark license is claimed.

## Anthropic software

- The source tree retains the upstream integration with `@anthropic-ai/claude-agent-sdk`. That SDK and the Claude Code CLI remain subject to Anthropic's applicable terms; this notice grants no rights to either product.
- The upstream `THIRD_PARTY_NOTICES.md` records an identity-scoped authorization held by the upstream project owner. That authorization does not transfer to this derivative distributor.
- The installers therefore exclude the `@anthropic-ai/claude-agent-sdk` package, all `@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*` platform packages, and every bundled `claude` or `claude.exe` executable.
- The default closed Web-profile runtime does not enable the Claude Code subagent plugin. A future build that enables it must still require users to install Claude Code separately under Anthropic's terms and expose its native executable on `PATH`.

## Codex reference

- OpenAI Codex supplied stability ideas only: bounded startup checks, native-platform builds, fail-closed validation, and checksums.
- This desktop shell does not copy Codex code or user-interface assets.
- No rights to the OpenAI or Codex names, logos, or other trademarks are granted or claimed. OpenAI did not sponsor or endorse this application.

## Windows x64 limitation

The Windows x64 package does not support persistent Bash sessions or persistent shell sessions. Use ordinary, non-persistent PowerShell command execution. Shell state is not preserved between commands, so the Windows package does not have complete feature parity with the macOS and Linux packages.

---

# 桌面分发边界

本说明适用于 **Unofficial DeepSeek Harness Desktop** 安装包。

## 项目身份与署名

- 此应用是非官方衍生版本。DeepSeek 未发布、赞助或认可此应用。
- 此应用包含依据上游 `LICENSE` 使用的 DeepSeek Harness 代码。每个安装包均包含该许可证。
- 每个安装包也包含 `THIRD_PARTY_NOTICES.md`。各依赖仍受各自条款约束。
- 完成目标平台原生载荷裁剪后，构建会把实际存在的 npm 包名和版本集合提交给 npm bulk advisory 服务。网络、HTTP、响应格式、意外包名或重复记录异常都会终止构建。high 和 critical 漏洞会终止构建；工作区 lockfile 不会代替实际分发闭包接受审计。
- `THIRD_PARTY_LICENSES/` 从裁剪后的 npm 树、按目标平台筛选的 `Cargo.lock` 闭包、内嵌 Node.js 运行时和 `@yao-pkg/pkg` 生成。目录记录包身份、SPDX 表达式、署名、原始许可证/NOTICE 文本、源码来源和 SHA-256 哈希。目录还包含保留原生载荷的固定源码归档、构建 recipe 和补丁，包括随附 sharp/libvips 构建列出的全部 29 个组件的完整源码与原始条款，以及 ripgrep 的准确 Cargo 源码闭包。缺少文本、载荷或源码摘要不符、出现未知或禁用许可证时，构建会失败。
- 该目录覆盖安装后的应用载荷，以及生成 SEA 所用的重要编译器和运行时来源。DMG 与 deb 不增加应用运行时。Windows 目标把 NSIS 3.11 zlib 启动程序和 `nsis-tauri-utils` 0.5.3 记录为安装器运行时组件。Tauri CLI 2.11.4 和 `tauri-bundler` 2.9.4 只记录为构建工具，不列为应用依赖。
- Linux Release 只发布 deb，不发布 AppImage，也不再分发 AppImage 运行时或启动程序。
- 操作系统或发行版提供的 macOS 框架、Windows WebView2 与系统库、Linux GTK/WebKit 与系统库不会复制到此应用许可证目录。Linux 包元数据另行声明动态系统库依赖。
- 此衍生版本使用自有的 `DSH` 终端应用图标，不使用 DeepSeek 的鲸鱼标志。
- MIT 许可证不授予 DeepSeek 名称、标志或其他商标的权利。本项目不主张获得 DeepSeek 商标许可。

## Anthropic 软件

- 源码树保留上游与 `@anthropic-ai/claude-agent-sdk` 的集成。该 SDK 和 Claude Code CLI 仍受 Anthropic 适用条款约束。本说明不授予这两项产品的任何权利。
- 上游 `THIRD_PARTY_NOTICES.md` 记载的授权仅属于上游项目所有者的身份。该授权不会转移给此衍生版本的分发者。
- 因此，安装包排除 `@anthropic-ai/claude-agent-sdk` 主包、所有 `@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*` 平台包，以及任何随附的 `claude` 或 `claude.exe` 可执行文件。
- 默认封闭式 Web profile 运行时没有启用 Claude Code 子智能体插件。今后的构建如启用该插件，仍必须要求用户按 Anthropic 条款单独安装 Claude Code，并确保能从 `PATH` 找到其原生可执行文件。

## Codex 参考边界

- OpenAI Codex 仅提供稳定性思路：有界启动检查、原生平台构建、失败即终止的校验和 SHA-256 清单。
- 此桌面壳不复制 Codex 代码或用户界面资源。
- 本项目不获得或主张 OpenAI、Codex 名称、标志或其他商标的权利。OpenAI 未赞助或认可此应用。

## Windows x64 限制

Windows x64 安装包不支持持久 Bash 会话或持久 Shell 会话。请使用普通的非持久 PowerShell 命令执行。命令之间不会保留 Shell 状态，因此 Windows 安装包与 macOS、Linux 安装包并非功能完全一致。
