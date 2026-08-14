# Unofficial DeepSeek Harness Desktop

English | [中文](README.zh.md)

This repository packages the existing [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web interface and runtime as a native desktop application. The visible interface is the upstream Web profile rather than a reimplementation. The desktop shell uses Tauri, the operating-system WebView, and a bundled Node SEA sidecar.

This is an unofficial derivative. DeepSeek did not publish, sponsor, or endorse it. The desktop foundation comes from [GTC2080/deepseek-harness-desktop](https://github.com/GTC2080/deepseek-harness-desktop); this fork adds Linux packaging, one native release matrix, redistribution guards, and runtime hardening.

## Download

The release workflow publishes `desktop-v0.1.0-rc.8` on [GitHub Releases](https://github.com/ucas-liumk/deepseek-harness-desktop/releases) only after every native build and installer check passes.

| Platform | Release package | Signing state |
| --- | --- | --- |
| macOS 15.0+ arm64 | DMG | DMG unsigned; contained app ad-hoc signed and not notarized |
| Windows x64 | NSIS installer | unsigned |
| Linux x64 | deb | unsigned |

`SHA256SUMS.txt` covers all three installers. The Release is published only after all three native-host jobs pass.

## What the desktop layer adds

- It launches the packaged runtime on an operating-system-selected `127.0.0.1` port and accepts only that exact origin in the main WebView.
- It generates a fresh 256-bit API credential for every desktop launch. Same-origin `/api` HTTP requests use `Authorization: Bearer <credential>`, and the two event WebSockets use an exact two-subprotocol credential.
- It fetches every discovered browser-plugin bundle and validates the Agent-preset roster and its default by starting the real sidecar during every build.
- It bounds startup, removes raw stderr from user-visible errors, and cleans up the sidecar on window and application exit.
- It uses a derivative-owned `DSH` terminal icon instead of DeepSeek's whale mark.
- It builds on native macOS, Windows, and Linux runners, checks executable architecture and signing state, and verifies every installer digest before publishing.
- It excludes the Anthropic Agent SDK package, its platform packages, and bundled `claude` executables. Each installer includes the upstream license, complete generated third-party license texts, and a bilingual redistribution notice.

These are stability patterns inspired by the open-source [OpenAI Codex](https://github.com/openai/codex) repository. This project does not copy the Codex interface or product assets.

## Known limits

- DeepSeek Harness 0.1 is a developer preview. This desktop release is therefore also a prerelease.
- Windows x64 does not support persistent Bash or persistent Shell sessions. Use non-persistent PowerShell commands; Windows is not fully feature-equivalent to macOS and Linux.
- The macOS arm64 package requires macOS 15.0 or later and is not Developer ID signed or notarized. Windows and Linux packages are unsigned. Automatic updates are not included.
- The Linux x64 deb is built on Ubuntu 22.04 and requires a compatible Debian-family GNU/Linux system with WebKitGTK 4.1.
- The default closed Web profile does not enable the Claude Code subagent plugin. The installer does not redistribute or install Claude Code.
- Desktop API authentication blocks blind port scans and ordinary local requests that do not know the per-launch credential. It is not a sandbox: a process running under the same operating-system account may recover the credential through process memory, environment inspection, or debugging. Do not expose the loopback service to a network.
- An ordinary `dsh web` launch keeps the upstream unauthenticated Web behavior. The desktop-only credential and one-use download tickets are enabled only when the native shell starts the packaged runtime.

See the [desktop build and release guide](desktop/README.md) and [distribution boundary](desktop/DISTRIBUTION_BOUNDARY.md) for exact details.

<a id="run"></a><a id="run-from-source"></a>

## Build from source

Install Node.js, pnpm, Rust, and the native Tauri prerequisites for the target operating system. Then run:

```sh
pnpm install --frozen-lockfile
pnpm run desktop:build
```

Builds are native-host only. Artifacts are written below `src-tauri/target/release/bundle/`.

## License and attribution

DeepSeek Harness code is used under the upstream [MIT License](LICENSE). Direct dependency terms are summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); every desktop build also generates the complete license-text bundle placed in its installer. The MIT license does not grant DeepSeek trademark rights.
