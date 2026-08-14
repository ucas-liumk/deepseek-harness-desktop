# Unofficial desktop application

English | [中文](README.zh.md)

This desktop application is an unofficial derivative, not a DeepSeek release. It packages the existing DeepSeek Harness Web profile inside a lightweight Tauri shell; desktop-specific code adds Session-selection persistence and download-completion feedback without reimplementing the interface or copying the Codex UI. Tauri uses the operating system WebView, and a native sidecar supplies the backend, so end users do not need Node.js, pnpm, or Rust.

## Supported targets

| Target mapping | Required build host | Tauri bundles | Automated release |
| --- | --- | --- | --- |
| macOS 15.0+ arm64 | macOS arm64 | app, DMG | arm64 DMG |
| Windows x64 | Windows x64 | NSIS | x64 NSIS |
| Linux x64 GNU | Linux x64 GNU | deb | x64 deb |

Every mapping is native-host only. The scripts derive the `pkg`, Rust, and `node-pty` target names from the running Node.js process and accept no cross-target override.

## Windows x64 functional limit

The Windows x64 release does not support persistent Bash sessions or persistent shell sessions. Use ordinary, non-persistent PowerShell command execution. Shell state such as the working directory, environment changes, and aliases is not preserved between commands. The Windows package therefore does not have complete feature parity with the macOS and Linux packages.

## Prerequisites

- Install Node.js 24.19.0, pnpm 11.7.0, and the repository's frozen dependencies on every platform.
- Install Rust 1.94.0. On macOS 15.0 or later, also install Xcode Command Line Tools. On Windows, install Microsoft C++ Build Tools, the Windows SDK (including `signtool.exe`), and WebView2 build prerequisites.
- On Debian or Ubuntu Linux, install the Tauri WebKit, AppIndicator, SVG, OpenSSL, XDO, and packaging dependencies:

```sh
sudo apt-get install build-essential file libayatana-appindicator3-dev librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev patchelf
```

## Build

Build the production Web application, the closed Node SEA sidecar, and the current platform's default native bundles with:

```sh
pnpm run desktop:build
```

Select native bundle formats when needed. The Linux Release uses:

```sh
pnpm run desktop:build -- --bundles deb
```

The release workflow uses `--prepare-only` to build and smoke-test the real native sidecar, runs the Rust tests against that sidecar, and then uses `--skip-prepare` for Tauri bundling. These flags split one native build; neither flag selects another target.

Artifacts are written below `src-tauri/target/release/bundle/`. For an unpackaged development window, use `pnpm run desktop:dev`.

## Release

The [desktop release workflow](../.github/workflows/desktop-release.yml) runs on `desktop-v*` tags and by manual dispatch. A publishing manual run must select the exact `desktop-v<version>` tag; an untagged manual run can only build and verify. Version `0.1.0-rc.8` therefore publishes from `desktop-v0.1.0-rc.8`.

The workflow builds macOS arm64, Windows x64, and Linux x64 on matching GitHub-hosted runners. Each job verifies the native host, executes the sidecar runtime smoke test, runs Rust tests, inspects the packaged architecture and signing state, and emits a SHA-256 manifest before uploading its workflow artifact.

The final job has the only `contents: write` permission. It uses the named `desktop-release` environment, downloads only the three successful build artifacts, requires the complete three-installer set, rechecks every SHA-256 digest, and rejects an existing Release or any unexpected remote asset. It publishes the draft only after the remote asset-name set exactly matches the verified four-file payload.

| Release asset | Signing state |
| --- | --- |
| `Unofficial-DeepSeek-Harness-Desktop_0.1.0-rc.8_macos-arm64_app-adhoc_dmg-unsigned.dmg` | DMG unsigned; contained app ad-hoc signed, not Developer ID signed or notarized |
| `Unofficial-DeepSeek-Harness-Desktop_0.1.0-rc.8_windows-x64_unsigned-setup.exe` | unsigned |
| `Unofficial-DeepSeek-Harness-Desktop_0.1.0-rc.8_linux-x64_unsigned.deb` | unsigned |

`SHA256SUMS.txt` covers all three installers in the Release.

## Runtime model

The Tauri window opens a local startup page. Rust generates a fresh 256-bit API credential, passes it only through the sidecar launch environment, and starts packaged `dsh web` on an operating-system-selected `127.0.0.1` port. The CLI consumes and deletes that environment variable before it snapshots the launch environment or imports dynamic profile plugins; the Connection Host receives only a frozen boolean verifier, not the credential. After validating the exact loopback readiness URL, Rust navigates the system WebView to the existing Harness interface. The startup page has no Tauri JavaScript capability or native command surface.

An immutable, top-frame initialization script adds `Authorization: Bearer <credential>` only to same-origin `/api` HTTP requests. It opens the two event WebSockets with exactly `dsh-v1` and `dsh-auth-<credential>` as their ordered subprotocols. The shell does not accept startup as complete until a same-origin authenticated `/api` request succeeds.

On macOS, the loopback port changes between launches. The client restores the validated, size-bounded current-Session selection through host-scoped WebView storage before normal startup and mirrors later selection changes. A first migration with no durable selection opens the most recently updated nonblank, non-archived Session instead of creating a startup-only blank draft. Session Log downloads remain owned by the WebView download manager. Because an anchor download cannot carry the bearer header, a successful authenticated `HEAD /api/session.export` preflight returns a fresh 256-bit ticket. The browser uses that ticket once, within 30 seconds, for a GET whose path and remaining query match exactly. One final native event reports the completed download and its actual saved filename to the existing Web dialog; a missing or malformed completion fails after two minutes.

The unofficial application uses the `io.github.ucas-liumk.deepseek-harness-desktop` identifier, which keeps its operating-system application-data directory separate from an official application. Closing the main window or quitting the application terminates the sidecar before the desktop process exits.

## Local API boundary

The bearer and WebSocket credentials block blind port scans and ordinary local clients that do not know the per-launch secret. Existing loopback `Host`, same-origin, and cross-site request checks remain in force. This is not isolation from the current operating-system account: another process under that account may recover the secret through process memory, environment inspection, or debugging. Do not expose the loopback service to a network.

An ordinary `dsh web` launch has no desktop authorizer and keeps the upstream unauthenticated Web behavior. It does not issue or require desktop download tickets.

## Anthropic redistribution boundary

The source tree retains the upstream `@anthropic-ai/claude-agent-sdk` integration, but the installer excludes the `@anthropic-ai/claude-agent-sdk` package and every optional `@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*` platform package. Before SEA compilation, a fail-closed scan rejects any remaining SDK package, platform package, or `claude`/`claude.exe` executable.

The default closed Web-profile runtime does not enable the Claude Code subagent plugin. A future build that enables it must require users to install Claude Code separately under Anthropic's terms and make the native `claude` executable available on `PATH`. The desktop installer does not redistribute, install, or authenticate that executable.

The closed executable contains the other shipped plugins. Installing additional out-of-tree Node plugins into this desktop build is not supported; add and validate a plugin in the repository before producing a new package.

Every installer includes the upstream `LICENSE`, `THIRD_PARTY_NOTICES.md`, the generated `THIRD_PARTY_LICENSES` closure, and the bilingual [`DISTRIBUTION_BOUNDARY.md`](DISTRIBUTION_BOUNDARY.md). The license generator reads the actual staged npm closure, target-filtered Cargo lock closure, embedded Node runtime notices, SEA compiler provenance, and explicitly inventoried installer bootstrap or runtime bytes present in a Release asset. It does not claim complete coverage of pure packaging-tool closures because those tools are not shipped as application dependencies. Missing or unsupported license data in the declared inventory stops the build. The distribution notice explains that the upstream owner's identity-scoped authorization for the Anthropic SDK and platform payloads does not transfer to this derivative. It also records the DeepSeek, OpenAI, and Codex trademark boundary. Codex supplied stability ideas only; this desktop shell copies no Codex code or UI assets.

## Distribution limits

- The product name and Release title say “Unofficial”, the application uses a derivative-owned `DSH` terminal icon, and the application identifier belongs to the derivative.
- The DMG container is unsigned. Its app uses only Tauri's configured ad-hoc identity. The workflow removes the invalidated Node.js signature from the Windows SEA and then requires every Windows binary to report `NotSigned`; no signing secret is implied or consumed.
- Automatic updates are not included.
