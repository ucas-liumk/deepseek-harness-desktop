# Agent Note: 基于 loopback Web 运行时的 Tauri 桌面壳

Status: implemented

[English](2026-08-13-tauri-desktop-shell.md) | 中文

## 问题

Windows、macOS 与 Linux 用户需要无需预先安装 Node.js 工具链即可使用的 DeepSeek Harness 安装包。Electron 壳能提供这种体验，但也会附带第二套浏览器引擎，并增加启动耗时、内存、包体积和安全更新成本。

构建后的 Web 文件不是独立应用。`dsh web` 会注入运行时启动 manifest，托管 API 与插件 bundle，并承载 WebSocket 流量。直接在 WebView 中加载 `apps/web/dist` 只会显示不完整的静态文件，同时绕过现有宿主生命周期。

Node 后端也不能继续作为外部前置条件。实测生产部署在尚未加入约 115 MB 的 Node 可执行文件前，就已占用约 328 MB、包含超过 31,000 个文件；这种布局既不能形成小型安装包，也不适合作为稳健的桌面应用结构。

## 决策

桌面应用是在 `src-tauri/` 中实现的非官方 Tauri v2 壳。其产品名称和窗口标题均标明“非官方”，`DSH` 终端图标也不同于 DeepSeek 的鲸鱼标志；`io.github.ucas-liumk.deepseek-harness-desktop` 标识符则把衍生应用数据与任何官方应用隔离。Tauri 提供原生窗口与操作系统 WebView；它不会替换或复制现有 Web 客户端或 HTTP 载体。

`scripts/build-desktop-sidecar.ts` 会构建仓库、创建生产部署闭包、补回其中必需的 dependency 与 peer dependency 闭包、拒绝残留符号链接，并把该闭包编译为当前原生宿主的单个 Node SEA 可执行文件。Tauri 将其作为 `dsh-backend` external binary 打包。macOS 和 Linux 还会把 node-pty 的原生支持文件放在后端旁边，因为 node-pty 根据 `process.execPath` 查找这些文件。

生产部署步骤会在执行前保存、执行后恢复 pnpm 的根工作区状态。否则，pnpm 会把仅属于 staging 的 hoisted production 设置记到开发 checkout 上，并在下一个无交互命令中尝试重装 production 依赖。

桌面壳先打开本地静态加载页，创建操作系统应用数据目录，再以该目录作为 `DSH_HOME` 和工作目录启动 `dsh web --host 127.0.0.1 --port 0`。它只接受精确的就绪前缀，以及紧随其后的不含凭据 `http://127.0.0.1:<非零端口>/` origin，然后才让 WebView 导航。45 秒超时、进程过早退出、畸形就绪输出和导航失败会产生有界的阶段编码错误，不会暴露 stderr 或本机路径。关闭主窗口时，应用会先终止 Windows 进程树或 Unix 进程组，再退出；明确离开该进程组的 Unix 后代不在此保证范围内。

每次启动 sidecar 前，Rust 都会生成新的 256 位 API 凭据，并且只通过子进程启动环境传入。CLI 会在保存启动环境快照或导入动态 profile 插件前读取并删除该变量；Connection Host 只能得到一个闭包保留凭据的冻结布尔校验器，不能得到凭据本身。不可变的顶层 WebView 脚本只为同源 `/api` HTTP 请求加入 `Authorization: Bearer <凭据>`。它只使用严格按顺序排列的 `dsh-v1` 与 `dsh-auth-<凭据>` subprotocol 打开两条事件 socket。cookie、Web 存储和普通 URL 均不包含 secret。只有已认证的同源 `/api` 响应成功，而且准确运行时 origin 报告本次启动的标题 nonce 后，Rust 才会标记启动就绪。

在 macOS 上，由 Rust 创建配置好的 WebView，以便在首次导航前安装一个固定平台标志和原生下载观察器。平台标志让客户端在每次随机端口的 `localStorage` origin 与应用 WebView 的主机级 cookie 之间同步经校验、编码后大小受限的当前 Session selection。首次迁移没有持久 selection 时，启动流程会从最近活跃 Workspace 中选择最近更新、未归档的非空白 Session，而不是创建临时空白 Session。下载观察器记录 WebView 选用的文件名，并在一个最终事件中同时发送文件名和完成状态。由于 anchor 导航不能携带 bearer header，认证成功的 `HEAD /api/session.export` 响应会签发新的 256 位票据。内存签发器最多保存 32 张票据；每张票据只能使用一次，30 秒后失效，并把一次 GET 绑定到准确路径和非票据 query。现有 Session Log 控制器最多等待两分钟；ZIP 流和“下载”目标位置仍由既有 Web 下载路径负责。

封闭式运行时设置 `DSH_CLOSED_RUNTIME=1`。其根 Loader 与 bootstrap Include 从可执行文件的安装锚点解析随附 bare 插件，不会从可写 profile 目录解析。客户端模块 host 会先从 profile、再从 Loader 的安装锚点解析每个浏览器插件；因此，随附的浏览器 bundle 会始终留在 SEA 虚拟文件系统内，不依赖指向虚拟路径的操作系统链接。profile 的仅配置 HMR 实例仍监听用户 patch 文件，但其空模块根 watcher 会明确以真实 profile 目录为基础，而不是以可执行文件的虚拟 snapshot 路径为基础。

Agent 预设发现流程只读取目录名，再对每个候选项执行 `lstat`，并保留目录符号链接不会成为预设行的既有规则。这样可以在普通文件系统和 SEA 虚拟文件系统上保持相同 roster 约定；后者的目录项不带 Node `Dirent` 方法。共享 Web 设置行会把 roster 读取失败显示为带重试操作的明确错误；加载失败后的空选择不会继续标为正在加载。

## 打包边界

构建流程只接受 3 种原生宿主：macOS arm64、Windows x64 和 GNU/Linux x64。它不接受目标覆盖参数。公开的 Linux Release 只选择 deb，因此不分发 AppImage 运行时或启动程序。生成的 sidecar 与 Rust target 仍是被忽略的构建产物；Tauri 源码、Cargo lock、图标和加载页则进入版本控制。

封闭式可执行文件支持仓库随附的插件图。运行时安装仓库外 Node 插件不属于此桌面约定，因为 bare 插件解析被有意锚定在可执行文件内部。

源码树保留上游 `@anthropic-ai/claude-agent-sdk` 集成，但桌面部署移除主 SDK 和可选的 `@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*` 平台包。编译 SEA 前，递归检查只要发现任何残留 SDK 身份或 `claude`／`claude.exe` 可执行文件，便会终止构建。默认封闭式 Web profile 不启用 Claude Code 子智能体插件。因此，上游限定到项目所有者身份的授权不会随衍生安装包转移。

完成目标平台原生载荷裁剪后，sidecar 构建会把实际存在的 npm 包名和版本集合提交给 npm bulk advisory API。网络或响应异常都会终止构建。high 和 critical 漏洞会终止构建。审计不会用整个工作区 lockfile 代替实际分发闭包。

每次 sidecar 构建都会根据裁剪后的 npm 树、目标平台 Cargo 闭包、内嵌 Node.js 运行时和 SEA 构建工具，生成封闭式校验的 `THIRD_PARTY_LICENSES` 目录。清单记录包身份、源码来源和 SHA-256 哈希。固定的离线源码产物覆盖保留的原生二进制：sharp/libvips 包含列出的全部 29 个组件的完整源码归档与原始条款、构建 recipe 和所有下载补丁；ripgrep 包含准确的目标平台 Cargo 源码闭包；Shiki、Koffi 和 node-pty 包含目标平台来源与通知。Windows 还把 NSIS 3.11 zlib 启动程序和 `nsis-tauri-utils` 0.5.3 记录为安装器运行时组件。Tauri CLI 与 `tauri-bundler` 仍标为构建工具。平台任务解压每个最终安装包后会再次校验该目录。

GitHub Actions 发布流程在匹配的原生运行器上构建 macOS arm64、Windows x64 和 Linux x64。构建包装脚本先准备真实 sidecar 并执行冒烟测试，随后 Rust 测试在 external binary 已存在时运行，第二个包装脚本阶段使用已验证输入打包，不重复构建 Web 或 sidecar。各平台任务检查可执行文件和安装包架构，要求未签名 macOS DMG 内的应用使用 ad-hoc 签名且 Windows 包保持未签名，启动最终 DMG、NSIS 和已安装 deb 载荷，确认就绪和 sidecar 清理，再生成 SHA-256 清单并上传工作流产物。

聚合任务是唯一拥有 `contents: write` 权限的任务。只有与 Tauri 和 Cargo 版本完全一致的 `desktop-v*` 标签才会发布；手动调度默认为仅验证，而且只能从同一个准确标签发布。名为 `desktop-release` 的 environment 接收所有成功的平台产物，要求完整产物集合，重新校验摘要，拒绝既有 Release，并仅在远端资产名称与已验证载荷完全一致后公开草稿。工作流再次运行时不会修改已公开的 Release。

macOS 使用 ad-hoc 签名，没有 Developer ID 签名或公证。Windows 和 Linux 包明确保持未签名，也不包含自动更新。macOS 配置沿用 3 项运行时兼容 entitlement：`com.apple.security.cs.allow-jit`、`com.apple.security.cs.allow-unsigned-executable-memory` 和 `com.apple.security.cs.disable-library-validation`。Tauri 会把它们应用于签名后的应用组件；这些 entitlement 不构成平台信任。

## 安全边界

加载页采用严格的 Content Security Policy，并且没有任何 Tauri JavaScript capability 或原生命令 API。Rust 负责 sidecar 启动与导航。启动阶段只允许内嵌加载页；就绪 URL 通过校验后，后续每次导航仍只能访问本次随机的 `http://127.0.0.1:<port>` origin。selection cookie 只接受当前 Session／subagent selection 结构，编码后上限为 2 KiB；其中不含 API key、文件系统路径、prompt 或 Session 内容。下载桥只接受同一已校验运行时端口的 `/api/session.export`。它记录请求时的文件名，只发送一个权威完成事件，并在执行固定事件分发脚本前把原生事件数据序列化为 JSON。

桌面 HTTP 与 WebSocket 请求除了要通过原有 Host、Origin 和 Fetch-Metadata 检查，还必须提供本次启动凭据。有效的 Session 导出票据只会绕过 bearer 检查；可达性栅栏仍会执行。凭据无效、重复、过期、重放、顺序错误或绑定不同时，请求会在 RPC 分发或事件流启动前失败。此机制会阻止盲扫端口和不知道 secret 的普通本机请求。

该凭据不是操作系统沙箱。同一操作系统账户下的进程仍可能通过进程内存、环境检查或调试取得凭据。普通 `dsh web` 启动没有桌面 authorizer，仍保持上游未认证的 Web 行为。桌面设计不会新增 LAN listener，也不会增加从 Web 内容到原生层的 IPC 桥；不得把 loopback 服务暴露到网络。

## 验证

聚焦的 app-boot 回归测试证明，bootstrap bare 插件和动态创建的 bare 插件都会从封闭式运行时安装锚点解析，不会命中可写 profile 中的同名包。客户端模块回归测试分别证明 profile 优先解析与已安装运行时回退。Agent 预设发现回归测试复现了虚拟文件系统中 `readdir(..., { withFileTypes: true })` 结果缺少 `Dirent` 方法的情况。共享 Web 设置行回归测试证明，初次加载 roster 失败时会显示重试控件，而不会一直显示加载标签。

每次 sidecar 构建都会从隔离的 `DSH_HOME` 启动编译后的可执行文件，校验启动 manifest 的每一行，下载每个已声明插件 bundle，调用 `agentPreset.list`，校验每个预设条目和一个有效默认项，再关闭该进程。探针直接使用宿主返回的 roster，不会写死当前预设 id，因此上游加入新预设时不需要修改桌面端专用目录。即使可执行文件的首页仍返回 HTTP 200，只要它提供空客户端图，或者其打包文件系统无法发现随附预设，这项检查就会失败。

端到端 sidecar 构建后，pnpm 根工作区状态仍表明完整开发安装与 isolated linker。后续普通 `pnpm run` 也能直接执行，不会触发依赖修复安装。

Rust 单元测试接受预期就绪 origin，并拒绝 HTTPS、`localhost`、缺失端口、非根路径和凭据。测试固定 256 位 token 和标题 nonce 生成、准确的 HTTP 与 WebSocket 注入范围、认证标题就绪信号，以及从子进程环境移除冒烟就绪变量。Host 回归测试要求一个准确 bearer 或按顺序排列的 WebSocket 协议对，拒绝重复的原始凭据 header，只选择 `dsh-v1`，并证明普通 Web 模式保持不变。票据回归测试覆盖 30 秒过期、一次性重放拒绝、准确 query／路径绑定、重复和畸形值、仅限 GET、32 项上限，以及控制器遇到票据异常时拒绝移交下载。macOS 专属测试证明，原生下载桥只接受已校验运行时端口的 Session 导出，按请求顺序保存相同 URL 的文件名，会在分发前对文件名执行 JSON 转义，并且只安装固定平台初始化标志。客户端回归测试还覆盖无效、含意外字段、编码畸形或超大的 selection cookie、跨端口恢复、首次迁移回退、普通浏览器隔离、权威原生下载完成、防重名文件名、不完整和旧版原生事件、两分钟期限、取消和原生下载失败。目标映射测试固定 3 种受支持的操作系统与架构组合，并拒绝不受支持的宿主。构建包装脚本测试固定准备、测试、打包的阶段拆分，并拒绝跨平台安装包格式。staging 测试会移除 Anthropic 主 SDK 和平台包，证明任何残留官方可执行文件都会使最终扫描失败，并固定漏洞审计在原生裁剪之后执行。许可证测试会拒绝不匹配的原生摘要、源码归档、归档成员、目标平台专属通知和校验清单。

发布工作流通过 YAML 结构测试固定触发条件、权限、原生运行器矩阵、阶段顺序、架构检查、签名声明、摘要校验和草稿发布。每个安装包的可执行证据仍由原生任务提供：macOS 挂载 DMG 并启动其中的应用，Windows 静默安装、启动和卸载 NSIS，Linux 则安装最终 deb，在 Xvfb 下启动应用、关闭窗口、检查 backend 与 helper 清理，再 purge 软件包。每次启动都会先等待有界的就绪信号，再执行关闭检查。

## 考虑过的替代方案

**使用带 IPC 载体的 Electron。** 本次交付不采用该方案，因为打包 Chromium 会复制操作系统浏览器引擎，并增加包体积、运行时内存、启动成本和浏览器补丁成本。未来的其他桌面壳仍可实现 GUI 分层约定所描述的 IPC 载体；当前 Tauri 壳不需要它。

**直接从磁盘加载 `apps/web/dist`。** 不予采用，因为 Web 宿主负责启动 manifest 注入、API 路由、插件 bundle、WebSocket upgrade 和关闭语义。在桌面壳中重建这些约定，比通过 loopback 复用 `dsh web` 更大，也更脆弱。

**同时打包独立 Node 可执行文件和部署目录。** 不予采用，因为实测布局会把大型运行时与数万个文件组合起来，安装字节数也高于 SEA；它还会扩大杀毒软件扫描、安装程序和部分升级的表面积。

**要求用户安装 Node.js。** 不予采用，因为这不能形成可安装桌面产品，会把运行时选择与升级交给用户，并削弱可复现性。

**用 Rust 重写后端。** 不予采用，因为这只会为打包而复制插件运行时、进程与文件系统能力、agent 生命周期、配置和 Web 宿主。Tauri 是窗口与生命周期壳，不是第二套 Harness 实现。

**把 API 凭据放入 cookie 或 URL。** 不予采用，因为 cookie 按 loopback 主机而非单个随机端口划分，其他 `127.0.0.1` 服务可能收到 cookie；URL 还会留在浏览器与诊断界面中。固定 WebView wrapper 可以把 bearer 限制到准确运行时 origin 和 `/api`，并把 WebSocket 凭据限制到两条事件路径。浏览器下载导航不能携带该 bearer，因此只为此路径使用范围狭窄的一次性票据。

**在单个运行器上交叉编译全部安装包。** 不予采用，因为 Node SEA、原生依赖、Tauri 二进制文件和安装程序必须与真实宿主 ABI 一致。目标名称覆盖参数会把未经执行的异平台字节标成原生构建。

**从平台任务直接上传。** 不予采用，因为写权限会扩散到整个矩阵，而且后续平台失败时可能留下不完整的公开 Release。平台任务只能上传已验证工作流产物；一个聚合任务统一管理 Release。

**再分发 Agent SDK 或 Claude Code 可执行文件。** 不予采用，因为项目所有者的授权限定到其身份，不能转移给此衍生项目。安装包不含主 SDK 及其平台载荷；默认封闭式 profile 也禁用该集成。

**复用 DeepSeek 应用标识符和类似官方版本的标题。** 不予采用，因为此衍生项目不拥有官方身份，而且可能与未来官方应用的数据冲突。衍生项目自有标识符和“非官方”标题会明确表明所有权并隔离存储。

## 后果

桌面应用不附带 Chromium，并复用产品当前 Web 行为。最终用户获得单个原生应用，无需管理 Node.js；平台 WebView 的安全更新仍由操作系统负责。

Node 后端仍占据主要磁盘与内存：Tauri 让桌面壳变轻，并不会让 Harness 运行时消失。SEA 打包是一种封闭部署，某些假定可以运行任意外部 Node 脚本或动态安装包的功能可能继续暴露不兼容；在声称支持之前，这些路径必须接受已打包应用测试。

macOS 会使用 ad-hoc 身份同时签名应用、sidecar 和 node-pty helper，并把上述 3 项兼容 entitlement 应用于每个签名后的可执行文件。这是打包 Node/V8 运行时和原生模块带来的实际安全成本，但不构成平台信任。桌面壳有意不向远程 origin 提供任何原生 capability。用户会看到明确的签名状态和摘要，而不是平台信任声明。

发布流水线新增 3 个原生构建环境和 1 个聚合任务。macOS arm64 包把最低系统版本声明为 macOS 15.0，因为封闭式运行时会加载按该部署目标构建的原生 addon。默认桌面 profile 不暴露 Claude Code，其他随附插件行为不变。

Linux Release 有意只发布 deb。AppImage 打包会额外分发独立运行时和启动程序，必须另行满足准确的第三方通知，以及静态链接 LGPL 代码对应源码或重新链接义务。公开资产不包含此格式，使 Linux 分发边界更小，也更容易直接检查。
