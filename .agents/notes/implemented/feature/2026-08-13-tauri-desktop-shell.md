# Agent Note: Tauri desktop shell over the loopback Web runtime

Status: implemented

English | [中文](2026-08-13-tauri-desktop-shell.zh.md)

## Problem

Windows, macOS, and Linux users need an installable DeepSeek Harness application without first installing a Node.js toolchain. An Electron shell would supply that experience, but it would also ship a second browser engine and add its startup, memory, package-size, and security-update costs.

The built Web files are not a standalone application. `dsh web` injects the runtime boot manifest, hosts the API and plugin bundles, and carries WebSocket traffic. Loading `apps/web/dist` directly in a WebView would display incomplete static files while bypassing the existing host lifecycle.

The Node backend cannot simply remain an external prerequisite. A measured production deployment occupied approximately 328 MB across more than 31,000 files before adding a roughly 115 MB Node executable, which was neither a small installer nor a robust desktop layout.

## Decision

The desktop application is an unofficial Tauri v2 shell in `src-tauri/`. Its product and window titles say “Unofficial”, its `DSH` terminal icon differs from DeepSeek's whale mark, and its `io.github.ucas-liumk.deepseek-harness-desktop` identifier isolates derivative application data from any official application. Tauri supplies native windows and the operating-system WebView; it does not replace or duplicate the existing Web client or HTTP carrier.

`scripts/build-desktop-sidecar.ts` builds the repository, creates a production deployment closure, restores its required dependency and peer-dependency closure, rejects remaining symbolic links, and compiles that closure into one native-host Node SEA executable. Tauri bundles it as the `dsh-backend` external binary. macOS and Linux also bundle node-pty's native support files beside the backend because node-pty resolves them from `process.execPath`.

The production deploy snapshots and restores pnpm's root workspace state. Without that boundary, pnpm records the staging-only hoisted production settings against the development checkout and tries to reinstall production dependencies on the next non-interactive command.

The shell starts a local static loading page, creates the operating-system application-data directory, and launches `dsh web --host 127.0.0.1 --port 0` with that directory as `DSH_HOME` and working directory. It accepts only the exact readiness prefix followed by a credential-free `http://127.0.0.1:<nonzero-port>/` origin, then navigates the WebView. A 45-second timeout, early process exit, malformed readiness output, and navigation failure produce bounded stage-coded startup errors without exposing stderr or local paths. Closing the main window terminates the Windows process tree or the Unix process group before the application exits; a Unix descendant that explicitly leaves that process group remains outside this guarantee.

Rust generates a fresh 256-bit API credential before every sidecar launch and passes it only through the child launch environment. The CLI consumes and deletes the variable before capturing the launch-environment snapshot or importing dynamic profile plugins; the Connection Host receives a frozen boolean verifier whose closure retains the credential, not the credential itself. An immutable top-frame WebView script attaches `Authorization: Bearer <credential>` only to same-origin `/api` HTTP requests. It opens only the two event sockets with the exact ordered subprotocols `dsh-v1` and `dsh-auth-<credential>`. The secret is absent from cookies, Web storage, and ordinary URLs. Rust marks startup ready only after an authenticated same-origin `/api` response succeeds and the exact runtime origin reports the per-launch title nonce.

On macOS, Rust creates the configured WebView so it can install one fixed platform marker and a native download observer before the first navigation. The marker lets the client copy its validated, encoded-size-bounded current-Session selection between each random-port `localStorage` origin and the application WebView's host-scoped cookie. If the first migration has no durable selection, startup selects the most recently updated nonblank, non-archived Session from the recent Workspace instead of creating a transient blank Session. The download observer records the WebView-selected filename and sends it with the final completion status in one event. Because an anchor navigation cannot attach the bearer header, a successful authenticated `HEAD /api/session.export` response issues a fresh 256-bit ticket. The in-memory issuer holds at most 32 tickets; each ticket is usable once, expires after 30 seconds, and binds one GET to the exact path and non-ticket query. The existing Session Log controller waits at most two minutes; ZIP streaming and the Downloads destination remain owned by the existing Web download path.

The closed runtime sets `DSH_CLOSED_RUNTIME=1`. Its root Loader and bootstrap Include resolve shipped bare plugins from the executable's installation anchor instead of the writable profile directory. The client-module host resolves each browser plugin from the profile first and then the Loader's installation anchor; shipped browser bundles therefore remain inside the SEA virtual filesystem instead of depending on operating-system links to virtual paths. The profile's config-only HMR instance still watches user patch files, but its empty module-root watcher is explicitly based at the real profile directory rather than the executable's virtual snapshot path.

Agent-preset discovery uses name-only directory reads and applies `lstat` to each candidate, preserving the existing rule that directory symlinks are not preset rows. This keeps the same roster contract on a normal filesystem and the SEA virtual filesystem, whose directory entries do not carry Node `Dirent` methods. The shared Web settings row turns a failed roster read into an explicit error with a retry action; an empty failed selection is never labelled as still loading.

## Packaging boundary

The build accepts three native hosts: macOS arm64, Windows x64, and GNU/Linux x64. It accepts no target override. The public Linux Release selects only deb, so it does not redistribute an AppImage runtime or bootstrap. Generated sidecars and Rust targets remain ignored build output; the Tauri source, Cargo lock, icons, and loading page are versioned.

The closed executable supports the plugin graph shipped by the repository. Runtime installation of an out-of-tree Node plugin is outside this desktop contract because bare plugin resolution is intentionally anchored inside the executable.

The source tree retains the upstream `@anthropic-ai/claude-agent-sdk` integration, but desktop deployment removes the main SDK package and its optional `@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*` platform packages. A recursive pre-SEA check rejects any remaining SDK identity or `claude`/`claude.exe` executable. The default closed Web profile does not enable the Claude Code subagent plugin. The identity-scoped upstream authorization therefore does not transfer through the derivative installer.

After target-native pruning, the sidecar build submits the exact physical npm package name/version set to npm's bulk advisory API. Network or response faults fail closed. High and critical advisories stop the build. The audit does not use the full workspace lockfile as a substitute for the distributed closure.

Each sidecar build generates a fail-closed `THIRD_PARTY_LICENSES` directory from that post-prune npm tree, the target-specific Cargo closure, the embedded Node.js runtime, and the SEA build tool. The manifest records identities, source provenance, and SHA-256 hashes. Fixed offline source artifacts cover retained native binaries: sharp/libvips includes complete source archives and original terms for all 29 listed components, its build recipe, and every downloaded patch; ripgrep includes its exact target Cargo source closure; and Shiki, Koffi, and node-pty include their target-specific provenance and notices. Windows additionally records the NSIS 3.11 zlib bootstrap and `nsis-tauri-utils` 0.5.3 as installer runtime components. Tauri CLI and `tauri-bundler` remain identified as build tools. Platform jobs verify the directory again after extracting each final installer.

The GitHub Actions release builds macOS arm64, Windows x64, and Linux x64 on matching native runners. The build wrapper first prepares and smoke-tests the real sidecar, Rust tests then run with that external binary present, and a second wrapper phase bundles the verified inputs without repeating the Web or sidecar build. The platform jobs inspect executable and package architectures, require an ad-hoc signature on the application inside the unsigned macOS DMG and unsigned Windows packages, launch the final DMG, NSIS, and installed deb payloads, confirm readiness and sidecar cleanup, and generate SHA-256 manifests before uploading workflow artifacts.

The aggregation job is the only job with `contents: write`. A `desktop-v*` tag publishes only when it exactly matches the Tauri and Cargo version; manual dispatch defaults to verification-only and can publish only from the same exact tag. The named `desktop-release` environment receives all successful platform artifacts, requires the complete asset set, rechecks their hashes, rejects an existing Release, and makes the draft public only after its remote asset names exactly match the verified payload. A published Release is immutable to workflow reruns.

macOS uses an ad-hoc signature and is neither Developer ID signed nor notarized. Windows and Linux packages are explicitly unsigned, and automatic updates are absent. The macOS configuration retains three runtime compatibility entitlements: `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, and `com.apple.security.cs.disable-library-validation`. Tauri applies them to the signed application components; they do not confer platform trust.

## Security boundary

The loading page has a restrictive Content Security Policy and receives no Tauri JavaScript capability or native command API. Rust owns sidecar launch and navigation. Startup accepts only the embedded loading page. After readiness validation, every later navigation remains locked to the exact random `http://127.0.0.1:<port>` origin. The selection cookie accepts only the current Session/subagent selection shape and its encoded value is capped at 2 KiB; it contains no API key, filesystem path, prompt, or Session content. The download bridge accepts only `/api/session.export` from that same validated runtime port. It records the requested filename, emits one authoritative completion event, and serializes native event data as JSON before evaluating its fixed dispatch script.

Desktop HTTP and WebSocket requests require the per-launch credential in addition to the existing Host, Origin, and Fetch-Metadata checks. A valid Session-export ticket bypasses only the bearer check; the reachability fence still runs. Invalid, duplicated, expired, replayed, reordered, or differently bound credentials fail before RPC dispatch or event-stream startup. This blocks blind port scans and ordinary local requests that do not know the secret.

This credential is not an operating-system sandbox. A process under the same operating-system account may recover it through process memory, environment inspection, or debugging. An ordinary `dsh web` launch has no desktop authorizer and keeps the upstream unauthenticated Web behavior. The desktop design adds no LAN listener and no Web content-to-native IPC bridge; the loopback service must not be exposed to a network.

## Verification

A focused app-boot regression test proves that both bootstrap and dynamically created bare plugins resolve from the closed-runtime installation anchor instead of a same-named package in the writable profile. A client-module regression test proves profile-first resolution and the installed-runtime fallback independently. An agent-preset discovery regression test reproduces a virtual filesystem whose `readdir(..., { withFileTypes: true })` result lacks `Dirent` methods. A shared Web row regression test proves that a failed initial roster load exposes a retry control instead of an endless loading label.

Every sidecar build starts the compiled executable from an isolated `DSH_HOME`, validates every boot-manifest row, downloads every advertised plugin bundle, calls `agentPreset.list`, validates every preset row and one valid default, and shuts the process down. The probe follows the host-reported roster instead of hard-coding current preset ids, so new upstream presets do not require a desktop-only catalog change. This check fails when the executable serves an empty client graph or its packaged filesystem cannot discover shipped presets, even if the index still returns HTTP 200.

After an end-to-end sidecar build, pnpm's root workspace state still reports the full development install and isolated linker. A subsequent ordinary `pnpm run` proceeds without a dependency repair install.

Rust unit tests accept the expected readiness origin and reject HTTPS, `localhost`, missing ports, non-root paths, and credentials. They pin 256-bit token and title-nonce generation, the exact HTTP and WebSocket injection scopes, authenticated title readiness, and removal of the smoke-ready variable from the child environment. Host regressions require one exact bearer or ordered WebSocket protocol pair, reject duplicate raw credential headers, select only `dsh-v1`, and prove ordinary Web mode stays unchanged. Ticket regressions cover 30-second expiry, one-use replay rejection, exact query/path binding, duplicate and malformed values, GET-only use, the 32-entry cap, and controller fail-closed behavior. macOS-specific tests prove that the native download bridge accepts only Session exports from the validated runtime port, preserves same-URL filenames in request order, JSON-escapes filenames before dispatch, and installs only the fixed platform initialization marker. Client regressions also cover invalid, unexpected-field, malformed, or oversized selection cookies; cross-port restoration; first-migration fallback; ordinary-browser isolation; authoritative native download completion; collision-safe filenames; incomplete and legacy native events; the two-minute deadline; cancellation; and native download failure. Target-mapping tests pin the three supported operating-system and architecture pairs and reject unsupported hosts. Build-wrapper tests pin the prepare/test/bundle split and reject cross-platform bundle formats. Staging tests remove the Anthropic main SDK and platform packages, prove that any residual official executable fails the final scan, and fix the vulnerability audit after native pruning. License tests reject mismatched native hashes, source archives, archive members, target-only notices, and checksum inventories.

The release workflow has a YAML structure test for its triggers, permissions, native runner matrix, phase ordering, architecture checks, signing disclosures, checksum verification, and draft publication. The native jobs remain the executable evidence for each installer: macOS mounts the DMG and starts its application, Windows performs a silent NSIS install, launch, and uninstall, and Linux installs the final deb, starts it under Xvfb, closes its window, verifies backend and helper cleanup, and purges the package. Every launch waits for the bounded readiness signal before shutdown checks run.

## Alternatives considered

**Electron with an IPC carrier.** Rejected for this delivery because bundling Chromium would duplicate the operating-system browser engine and increase package, runtime-memory, startup, and browser-patching costs. A different future shell may still implement the IPC carrier described by the GUI layering contract; this Tauri shell does not need it.

**Load `apps/web/dist` directly from disk.** Rejected because the Web host owns boot-manifest injection, API routes, plugin bundles, WebSocket upgrades, and shutdown. Recreating those contracts in the shell would be larger and more fragile than reusing `dsh web` over loopback.

**Bundle a standalone Node executable plus the deployed directory.** Rejected because the measured layout combined a large runtime with tens of thousands of files and more installed bytes than the SEA. It also created more antivirus, installer, and partial-upgrade surface.

**Require users to install Node.js.** Rejected because it is not an installable desktop product, makes runtime selection and upgrades user-owned, and weakens reproducibility.

**Rewrite the backend in Rust.** Rejected because it would duplicate the plugin runtime, process and filesystem capabilities, agent lifecycle, configuration, and Web host solely for packaging. Tauri is the window and lifecycle shell, not a second Harness implementation.

**Put the API credential in a cookie or URL.** Rejected because cookies are scoped to the loopback host rather than one random port, so another `127.0.0.1` service could receive them; URLs also persist in browser and diagnostic surfaces. The fixed WebView wrapper can constrain the bearer to the exact runtime origin and `/api`, and constrain the WebSocket credential to the two event paths. The narrow one-use ticket exists only because browser download navigation cannot attach that bearer.

**Cross-compile all packages on one runner.** Rejected because the Node SEA, native dependencies, Tauri binary, and installer must agree with the actual host ABI. A target-name override would label unexecuted foreign bytes as a native build.

**Upload directly from platform jobs.** Rejected because write permission would spread across the matrix and a failed later platform could leave a partial public Release. Platform jobs can upload only verified workflow artifacts; one aggregation job owns the Release.

**Redistribute the Agent SDK or Claude Code executable.** Rejected because the project owner's authorization is identity-scoped and does not transfer to this derivative. Both the main SDK and its platform payloads are absent from the installer; the default closed profile disables that integration.

**Reuse DeepSeek's application identifier and official-looking title.** Rejected because this derivative does not own the official identity and could collide with a future official application's data. The derivative-owned identifier and “Unofficial” title make ownership and storage separation explicit.

## Consequences

The desktop application avoids a bundled Chromium engine and reuses the product's current Web behavior. End users receive one native application and do not manage Node.js, while platform WebView security updates remain owned by the operating system.

The Node backend still dominates disk and memory use: Tauri makes the shell light, not the Harness runtime free. SEA packaging is a closed deployment and may expose further incompatibilities in features that assume arbitrary external Node scripts or dynamically installed packages; those paths require packaged-application tests before claiming support.

macOS signs the app, sidecar, and node-pty helper together with an ad-hoc identity and applies the three configured compatibility entitlements to each signed executable. This is a real security cost of the packaged Node/V8 runtime and native modules; it does not establish platform trust. The shell deliberately adds no remote-origin native capability. Users receive explicit signing status and checksums rather than a claim of platform trust.

The release pipeline adds three native build environments and one aggregation job. The macOS arm64 package declares macOS 15.0 as its minimum because its closed runtime loads a native addon built for that deployment target. The default desktop profile does not expose Claude Code, while the other shipped plugin behavior is unchanged.

The Linux Release intentionally publishes only deb. AppImage packaging would add a separately distributed runtime and bootstrap whose exact third-party notices and static LGPL corresponding-source or relinking obligations must be fulfilled independently. Keeping that format out of the public asset set preserves a smaller, directly inspectable Linux distribution boundary.
