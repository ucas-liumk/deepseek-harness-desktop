/**
 * Build the auditable license payload shipped by the desktop installers.
 *
 * The npm half is read from the exact production staging tree that becomes the
 * Node SEA. The Rust half is read from Cargo metadata filtered to the native
 * target, with Cargo.lock pinned by --locked. Every package must declare a
 * reviewed SPDX expression and resolve to original license/notice text or an
 * explicitly identified same-repository/canonical donor. The output carries a
 * package manifest and a SHA-256 inventory, so extracted installers can be
 * checked without network access.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import parseSpdx from 'spdx-expression-parse'

const repositoryRoot = resolve(import.meta.dirname, '..')
export const DESKTOP_LICENSE_BUNDLE = resolve(repositoryRoot, '.artifacts/desktop-licenses/THIRD_PARTY_LICENSES')
const DEFAULT_NPM_STAGING = resolve(repositoryRoot, '.artifacts/desktop-sidecar/node')
const DEFAULT_CARGO_MANIFEST = resolve(repositoryRoot, 'src-tauri/Cargo.toml')
const DEFAULT_CARGO_LOCK = resolve(repositoryRoot, 'src-tauri/Cargo.lock')
const DEFAULT_PROJECT_LICENSE = resolve(repositoryRoot, 'LICENSE')
const LANDLOCK_PROJECT_LICENSE = resolve(repositoryRoot, 'native/landlock-run/LICENSE')
const PINNED_SOURCE_DIRECTORY = resolve(repositoryRoot, '.artifacts/desktop-licenses/pinned-sources')
const SOURCE_ARTIFACT_DIRECTORY = resolve(repositoryRoot, '.artifacts/desktop-licenses/source-artifacts')
const MIB = 1024 * 1024

export interface FetchRetryPolicy {
  /** Total attempts, including the first request. */
  readonly maxAttempts: number
  /** One timeout covering response headers and the complete body for each attempt. */
  readonly attemptTimeoutMs: number
  /** Deterministic delays between attempts; must contain maxAttempts - 1 entries. */
  readonly retryDelaysMs: readonly number[]
  /** Reject a response larger than this limit without retrying it. */
  readonly maxResponseBytes: number
}

interface FetchRetryDependencies {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
  readonly sleep?: (delayMs: number) => Promise<void>
}

export const PINNED_TEXT_FETCH_POLICY: FetchRetryPolicy = Object.freeze({
  maxAttempts: 4,
  attemptTimeoutMs: 30_000,
  retryDelaysMs: Object.freeze([250, 750, 2_000]),
  maxResponseBytes: MIB,
})

export const PINNED_SOURCE_FETCH_POLICY: FetchRetryPolicy = Object.freeze({
  maxAttempts: 4,
  attemptTimeoutMs: 120_000,
  retryDelaysMs: Object.freeze([250, 750, 2_000]),
  maxResponseBytes: 128 * MIB,
})
const RETRYABLE_NETWORK_CODES = new Set([
  'EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
  'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT',
])
const REVIEWED_PKG_BOOTSTRAP_PACKAGES = new Map([
  ['@roberts_lando/vfs', '0.3.3'],
])

const SHARP_LIBVIPS_VERSION = '1.3.2'
const SHARP_LIBVIPS_COMMIT = '4da6d14c0d59866adfb9d8cf52bcaa53846dc4f6'
const SHARP_LIBVIPS_ARCHIVE_SHA256 = '4f438a108427ed9054c62c134c559af10522815ea42892a9ca31f655d97fc806'
const SHARP_LIBVIPS_NOTICE_COMPONENTS = [
  'aom', 'cairo', 'cgif', 'expat', 'fontconfig', 'freetype', 'fribidi', 'glib',
  'harfbuzz', 'highway', 'lcms', 'libarchive', 'libexif', 'libffi', 'libheif',
  'libimagequant', 'libnsgif', 'libpng', 'librsvg', 'libtiff', 'libultrahdr',
  'libvips', 'libwebp', 'libxml2', 'mozjpeg', 'pango', 'pixman', 'proxy-libintl',
  'zlib-ng',
] as const
const RIPGREP_VERSION = '15.0.0'
const RIPGREP_COMMIT = '3a612f88b805e14aef45bfa43e25a54abc6297fc'
const RIPGREP_ARCHIVE_SHA256 = 'f30f2ff3bc91df5750d7a341088862559f1447f7bc278a69e5daf532c71b8e8d'
const RIPGREP_PREBUILT_COMMIT = '5c302c331f59f578fd90e024a8f374012c40e8b4'
const RIPGREP_PREBUILT_ARCHIVE_SHA256 = '377a58affbbdfbbd9752449957fbd9a1caa787bfde119605b7747d01becc59fc'
const VSCODE_ONIGURUMA_VERSION = '1.7.0'
const VSCODE_ONIGURUMA_WASM_SHA256 = 'fd885c2d12e5951e59d761ebd4a006e06254b1491fd6f530c92b69fb4d8d77d9'
const VSCODE_ONIGURUMA_ARCHIVE_SHA256 = '830c8de8fd475455d8c161ca3c1f5f3c935fad8327ee548dec38c8985097657f'
const KOFFI_VERSION = '3.1.1'
const KOFFI_ARCHIVE_SHA256 = 'd6e3cb95f5d155d16cfe40f39ce09be18568c7f84dfb0b0722820a0da9e03b17'
const NODE_PTY_VERSION = '1.1.0'
const NODE_PTY_ARCHIVE_SHA256 = 'c7517f19083ddcb05f276904680eb2b11a6b5ecab778b8e4e5685a6d645b3f60'
const CONPTY_VERSION = '1.23.251008001'
const TERMINAL_LICENSE_COMMIT = '9d7ea77cc8ecbfcf213f6a38fbeb611c71040a34'
const WINDOWS_SHARP_LIBVIPS_COMMIT = 'a2d035c4b72d8f33942c2dfa8e020e49fcacc0dc'
const WINDOWS_SHARP_LIBVIPS_ARCHIVE_SHA256 = 'cab8a652dc49e02bd5df89ba1ce30075949f4f5943de9bd425d05535f63e07eb'
const TAURI_BUNDLER_COMMIT = '8909f221d1515955fc843808032bdc5d62209c96'
const TAURI_SOURCE_ARCHIVE_SHA256 = '1718a576b18e511979ac81f4d40813b74f2a129935260da6af7be1d3fed97d48'

const RIPGREP_COMMON_CRATES = [
  'aho-corasick@1.1.3', 'anyhow@1.0.100', 'bstr@1.12.0', 'cc@1.2.41', 'cfg-if@1.0.4',
  'crossbeam-channel@0.5.15', 'crossbeam-deque@0.8.6', 'crossbeam-epoch@0.9.18',
  'crossbeam-utils@0.8.21', 'encoding_rs@0.8.35', 'encoding_rs_io@0.1.7',
  'find-msvc-tools@0.1.4', 'glob@0.3.3', 'itoa@1.0.15', 'jobserver@0.1.34',
  'lexopt@0.3.1', 'libc@0.2.177', 'log@0.4.28', 'memchr@2.7.6', 'memmap2@0.9.8',
  'pcre2-sys@0.2.10', 'pcre2@0.2.11', 'pkg-config@0.3.32', 'proc-macro2@1.0.101',
  'quote@1.0.41', 'regex-automata@0.4.13', 'regex-syntax@0.8.8', 'regex@1.12.2',
  'ryu@1.0.20', 'same-file@1.0.6', 'serde@1.0.228', 'serde_core@1.0.228',
  'serde_derive@1.0.228', 'serde_json@1.0.145', 'shlex@1.3.0', 'syn@2.0.106',
  'termcolor@1.4.1', 'textwrap@0.16.2', 'unicode-ident@1.0.19', 'walkdir@2.5.0',
] as const
const RIPGREP_WINDOWS_CRATES = [
  'getrandom@0.3.4', 'winapi-util@0.1.11', 'windows-link@0.2.1', 'windows-sys@0.61.2',
] as const
const RIPGREP_CRATE_CHECKSUMS: Readonly<Record<string, string>> = {
  'aho-corasick@1.1.3': '8e60d3430d3a69478ad0993f19238d2df97c507009a52b3c10addcd7f6bcb916',
  'anyhow@1.0.100': 'a23eb6b1614318a8071c9b2521f36b424b2c83db5eb3a0fead4a6c0809af6e61',
  'bstr@1.12.0': '234113d19d0d7d613b40e86fb654acf958910802bcceab913a4f9e7cda03b1a4',
  'cc@1.2.41': 'ac9fe6cdbb24b6ade63616c0a0688e45bb56732262c158df3c0c4bea4ca47cb7',
  'cfg-if@1.0.4': '9330f8b2ff13f34540b44e946ef35111825727b38d33286ef986142615121801',
  'crossbeam-channel@0.5.15': '82b8f8f868b36967f9606790d1903570de9ceaf870a7bf9fbbd3016d636a2cb2',
  'crossbeam-deque@0.8.6': '9dd111b7b7f7d55b72c0a6ae361660ee5853c9af73f70c3c2ef6858b950e2e51',
  'crossbeam-epoch@0.9.18': '5b82ac4a3c2ca9c3460964f020e1402edd5753411d7737aa39c3714ad1b5420e',
  'crossbeam-utils@0.8.21': 'd0a5c400df2834b80a4c3327b3aad3a4c4cd4de0629063962b03235697506a28',
  'encoding_rs@0.8.35': '75030f3c4f45dafd7586dd6780965a8c7e8e285a5ecb86713e63a79c5b2766f3',
  'encoding_rs_io@0.1.7': '1cc3c5651fb62ab8aa3103998dade57efdd028544bd300516baa31840c252a83',
  'find-msvc-tools@0.1.4': '52051878f80a721bb68ebfbc930e07b65ba72f2da88968ea5c06fd6ca3d3a127',
  'getrandom@0.3.4': '899def5c37c4fd7b2664648c28120ecec138e4d395b459e5ca34f9cce2dd77fd',
  'glob@0.3.3': '0cc23270f6e1808e30a928bdc84dea0b9b4136a8bc82338574f23baf47bbd280',
  'itoa@1.0.15': '4a5f13b858c8d314ee3e8f639011f7ccefe71f97f96e50151fb991f267928e2c',
  'jobserver@0.1.34': '9afb3de4395d6b3e67a780b6de64b51c978ecf11cb9a462c66be7d4ca9039d33',
  'lexopt@0.3.1': '9fa0e2a1fcbe2f6be6c42e342259976206b383122fc152e872795338b5a3f3a7',
  'libc@0.2.177': '2874a2af47a2325c2001a6e6fad9b16a53b802102b528163885171cf92b15976',
  'log@0.4.28': '34080505efa8e45a4b816c349525ebe327ceaa8559756f0356cba97ef3bf7432',
  'memchr@2.7.6': 'f52b00d39961fc5b2736ea853c9cc86238e165017a493d1d5c8eac6bdc4cc273',
  'memmap2@0.9.8': '843a98750cd611cc2965a8213b53b43e715f13c37a9e096c6408e69990961db7',
  'pcre2-sys@0.2.10': '18b9073c1a2549bd409bf4a32c94d903bb1a09bf845bc306ae148897fa0760a4',
  'pcre2@0.2.11': '9e970b0fcce0c7ee6ef662744ff711f21ccd6f11b7cf03cd187a80e89797fc67',
  'pkg-config@0.3.32': '7edddbd0b52d732b21ad9a5fab5c704c14cd949e5e9a1ec5929a24fded1b904c',
  'proc-macro2@1.0.101': '89ae43fd86e4158d6db51ad8e2b80f313af9cc74f5c0e03ccb87de09998732de',
  'quote@1.0.41': 'ce25767e7b499d1b604768e7cde645d14cc8584231ea6b295e9c9eb22c02e1d1',
  'regex-automata@0.4.13': '5276caf25ac86c8d810222b3dbb938e512c55c6831a10f3e6ed1c93b84041f1c',
  'regex-syntax@0.8.8': '7a2d987857b319362043e95f5353c0535c1f58eec5336fdfcf626430af7def58',
  'regex@1.12.2': '843bc0191f75f3e22651ae5f1e72939ab2f72a4bc30fa80a066bd66edefc24d4',
  'ryu@1.0.20': '28d3b2b1366ec20994f1fd18c3c594f05c5dd4bc44d8bb0c1c632c8d6829481f',
  'same-file@1.0.6': '93fc1dc3aaa9bfed95e02e6eadabb4baf7e3078b0bd1b4d7b6b0b68378900502',
  'serde@1.0.228': '9a8e94ea7f378bd32cbbd37198a4a91436180c5bb472411e48b5ec2e2124ae9e',
  'serde_core@1.0.228': '41d385c7d4ca58e59fc732af25c3983b67ac852c1a25000afe1175de458b67ad',
  'serde_derive@1.0.228': 'd540f220d3187173da220f885ab66608367b6574e925011a9353e4badda91d79',
  'serde_json@1.0.145': '402a6f66d8c709116cf22f558eab210f5a50187f702eb4d7e5ef38d9a7f1c79c',
  'shlex@1.3.0': '0fda2ff0d084019ba4d7c6f371c95d8fd75ce3524c3cb8fb653a3023f6323e64',
  'syn@2.0.106': 'ede7c438028d4436d71104916910f5bb611972c5cfd7f89b8300a8186e6fada6',
  'termcolor@1.4.1': '06794f8f6c5c898b3275aebefa6b8a1cb24cd2c6c79397ab15774837a0bc5755',
  'textwrap@0.16.2': 'c13547615a44dc9c452a8a534638acdf07120d4b6847c8178705da06306a3057',
  'unicode-ident@1.0.19': 'f63a545481291138910575129486daeaf8ac54aee4387fe7906919f7830c7d9d',
  'walkdir@2.5.0': '29790946404f91d9c5d06f9874efddea1dc06c5efe94541a7d6863108e3a5e4b',
  'winapi-util@0.1.11': 'c2a7b1c03c876122aa43f3020e6c3c3ee5c05081c9a00739faf7503aeba10d22',
  'windows-link@0.2.1': 'f0805222e57f7521d6a62e36fa9163bc891acd422f971defe97d64e70d0a4fe5',
  'windows-sys@0.61.2': 'ae137229bcbd6cdf0f7b80a31df61766145077ddf49416a728b02cb3921ff3fc',
}

const TEXT_FILE = /^(?:licen[cs]e|copying|notice|unlicense)(?:[-_.].*|$)/i
const REVIEWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unicode-3.0',
  'Unlicense',
  'Zlib',
])

// crates.io omits workspace-root license files from these published crates.
// Their versions and repositories were reviewed against Cargo.lock; a new
// version cannot silently inherit unrelated canonical text.
const REVIEWED_CANONICAL_TEXT_FALLBACKS = new Set([
  'cargo:block2@0.6.2',
  'cargo:dispatch2@0.3.1',
  'cargo:objc2@0.6.4',
  'cargo:objc2-app-kit@0.3.2',
  'cargo:objc2-core-foundation@0.3.2',
  'cargo:objc2-core-graphics@0.3.2',
  'cargo:objc2-encode@4.1.0',
  'cargo:objc2-exception-helper@0.1.1',
  'cargo:objc2-foundation@0.3.2',
  'cargo:objc2-io-surface@0.3.2',
  'cargo:objc2-web-kit@0.3.2',
  'cargo:selectors@0.36.1',
  'cargo:sigchld@0.2.4',
  'cargo:unic-char-property@0.9.0',
  'cargo:unic-char-range@0.9.0',
  'cargo:unic-common@0.9.0',
  'cargo:unic-ucd-ident@0.9.0',
  'cargo:unic-ucd-version@0.9.0',
])

interface CargoMetadata {
  readonly packages: CargoPackage[]
  readonly resolve: { readonly nodes: { readonly id: string }[] } | null
  readonly workspace_members: string[]
}

interface CargoPackage {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly license: string | null
  readonly license_file: string | null
  readonly authors: string[]
  readonly repository: string | null
  readonly homepage: string | null
  readonly source: string | null
  readonly manifest_path: string
}

interface RawPackage {
  readonly ecosystem: 'npm' | 'cargo' | 'runtime' | 'build-tool'
  readonly name: string
  readonly version: string
  readonly licenseExpression: string
  readonly authors: string[]
  readonly repository?: string
  readonly packageDirectory: string
  readonly originalTextFiles: string[]
}

interface TextSource {
  readonly sourcePath: string
  readonly origin: 'package' | 'pinned-upstream' | 'project-license' | 'repository-sibling' | 'canonical-license'
  readonly sourcePackage: string
  readonly licenseId?: string
}

interface OutputFile {
  readonly path: string
  readonly sha256: string
  readonly origin: TextSource['origin']
  readonly sourceName: string
  readonly sourcePackage: string
  readonly licenseId?: string
}

export interface LicenseManifestEntry {
  readonly ecosystem: RawPackage['ecosystem']
  readonly name: string
  readonly version: string
  readonly licenseExpression: string
  readonly authors: string[]
  readonly repository?: string
  readonly copyrightLines: string[]
  readonly files: OutputFile[]
}

interface GenerateOptions {
  readonly npmRoot: string
  readonly cargoMetadata: CargoMetadata
  readonly cargoLock: string
  readonly projectLicense: string
  readonly output: string
  readonly rustTarget: string
  readonly supplementalPackages?: RawPackage[]
  readonly sourceArtifacts?: SourceArtifactSpec[]
  readonly sourceArtifactCache?: string
}

export interface SourceArtifactSpec {
  readonly name: string
  readonly version: string
  readonly repository: string
  readonly revision: string
  readonly url: string
  readonly expectedSha256: string
  readonly purpose: string
  readonly relatedPackages: string[]
  readonly requiredMembers?: string[]
  readonly components?: string[]
  readonly licenseMembers?: string[]
}

export interface SourceArtifactEntry extends Omit<SourceArtifactSpec, 'expectedSha256'> {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

interface NativeTargetProvenance {
  readonly ripgrepPackage: string
  readonly ripgrepBinary: string
  readonly ripgrepSha256: string
  readonly koffiPackage: string
  readonly koffiBinary: string
  readonly koffiSha256: string
  readonly sharpFiles: Readonly<Record<string, string>>
  readonly nodePtyFiles: Readonly<Record<string, string>>
}

const NATIVE_TARGET_PROVENANCE: Readonly<Record<string, NativeTargetProvenance>> = {
  'aarch64-apple-darwin': {
    ripgrepPackage: '@vscode/ripgrep-darwin-arm64',
    ripgrepBinary: 'bin/rg',
    ripgrepSha256: '6ef40346bf31fcce79d9614c7745c198542925a0c7d4911e1ffe794c53392ac1',
    koffiPackage: '@koromix/koffi-darwin-arm64',
    koffiBinary: 'darwin_arm64/koffi.node',
    koffiSha256: '571168fbd60ffe51953b82e305cd721da603577649e8e58584f25233012253be',
    sharpFiles: {
      '@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node': '5efbf349396808af22ae4f6b67c327767297a97b54a1ecf04dedec63aeff4d46',
      '@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.3.dylib': '50090a3a7c8f455de3c6cf2b274d231ddcc92901f4b1957c3b3391b6b9877989',
    },
    nodePtyFiles: {
      'prebuilds/darwin-arm64/pty.node': 'e6457d66f45af3facd02920a5b212164e80fe0bb758afe6e6eab1eceeba3fc9a',
      'prebuilds/darwin-arm64/spawn-helper': '21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26',
    },
  },
  'x86_64-unknown-linux-gnu': {
    ripgrepPackage: '@vscode/ripgrep-linux-x64',
    ripgrepBinary: 'bin/rg',
    ripgrepSha256: '193906679498de4d939345b937fa24e0e69a03c244bd70c859f5e41232713f21',
    koffiPackage: '@koromix/koffi-linux-x64',
    koffiBinary: 'linux_x64/koffi.node',
    koffiSha256: 'df687b8c68598c3ee83d06dcbc1d72fca032475e62b6108c4badfb5e43a3e7ff',
    sharpFiles: {
      '@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.3.node': '62ad8a4400d01452a37034e527b3f0849c4d685b33e8acde79abfbcc9fe5bc12',
      '@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3': '0c1a1560417bbcdac38ce83151e52e56711deb70c5373053822c3301a19a4496',
    },
    nodePtyFiles: {},
  },
  'x86_64-pc-windows-msvc': {
    ripgrepPackage: '@vscode/ripgrep-win32-x64',
    ripgrepBinary: 'bin/rg.exe',
    ripgrepSha256: 'f9dde63498b3193f098355dbec97af99dc4f6b8fa0df5ed04114a03012c042cb',
    koffiPackage: '@koromix/koffi-win32-x64',
    koffiBinary: 'win32_x64/koffi.node',
    koffiSha256: 'eb0587c804bb76262968bf83028528da4dc2d4322f558845cce205c709e2ba20',
    sharpFiles: {
      '@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node': '45dbb968dff27a1e8d8870d2a34e6f5418fa2a1a4fe27a7ed13ab2fb3f895468',
      '@img/sharp-win32-x64/lib/libvips-42.dll': '6d8ec83a826a1b46ef25a670501fd186475568dd3e48893cb4f756d0f2f428d8',
      '@img/sharp-win32-x64/lib/libvips-cpp-8.18.3.dll': 'd6eb3395e6f7799c9e2c997aba38068f1ab0684dc08a853013dbe528649306b9',
    },
    nodePtyFiles: {
      'prebuilds/win32-x64/pty.node': 'ae323edd0835ee7b9e18cc96a7b2bb4b8173ff768317d178af2788406feb71ff',
      'prebuilds/win32-x64/conpty.node': 'ee8f4e6f4dad71939eecfda11de249400e34bfefe4c8b48af13f3b5476f4035b',
      'prebuilds/win32-x64/conpty_console_list.node': '879dd94cfc79f1e263a00077597ae9448a5394b7d193381aaa50d992a1f91090',
      'prebuilds/win32-x64/conpty/conpty.dll': '7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed',
      'prebuilds/win32-x64/conpty/OpenConsole.exe': 'd1fe7faa62f9e955e2ac2371f95d7e5513df4d496255097158f979c94782c5fc',
      'prebuilds/win32-x64/winpty.dll': 'e1cb26d868c954ba26817bedf3e4a5744e4ca2030adf51a7156e5ff2fadb881b',
      'prebuilds/win32-x64/winpty-agent.exe': '0c4834a0ab2a4f8c855a2f1db9b21fa6e5fc324ae8e3c82addd53d503d999825',
    },
  },
}

/** Select the fixed Cargo source closure used by the reviewed ripgrep 15 binary. */
export function ripgrepCargoCrateIds(rustTarget: string): string[] {
  if (rustTarget === 'x86_64-pc-windows-msvc') return [...RIPGREP_COMMON_CRATES, ...RIPGREP_WINDOWS_CRATES]
  if (rustTarget === 'aarch64-apple-darwin' || rustTarget === 'x86_64-unknown-linux-gnu') {
    return [...RIPGREP_COMMON_CRATES]
  }
  throw new Error(`desktop licenses: unsupported ripgrep target ${rustTarget}.`)
}

/** Decide native notices from the retained target payload, never from pruned third_party copies. */
export function nodePtyNoticeRequirements(rustTarget: string, retainedRelativePaths: readonly string[]): string[] {
  if (rustTarget !== 'x86_64-pc-windows-msvc') return []
  const retained = new Set(retainedRelativePaths)
  const required = [
    'prebuilds/win32-x64/conpty/conpty.dll',
    'prebuilds/win32-x64/conpty/OpenConsole.exe',
    'prebuilds/win32-x64/winpty.dll',
    'prebuilds/win32-x64/winpty-agent.exe',
  ]
  const missing = required.filter(path => !retained.has(path))
  if (missing.length > 0) {
    throw new Error(`desktop licenses: Windows node-pty native payload is incomplete: ${missing.join(', ')}.`)
  }
  return ['deps/winpty/LICENSE', 'Microsoft-Terminal/LICENSE', 'Microsoft-Terminal/NOTICE.md']
}

interface NpmManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly license?: unknown
  readonly author?: unknown
  readonly contributors?: unknown
  readonly repository?: unknown
  readonly homepage?: unknown
  readonly dependencies?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the package markers bundled into pkg's SEA bootstrap and reject any unreviewed closure change. */
export function reviewedPkgBootstrapPackages(source: string): string[] {
  const packages = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith('// node_modules/')) continue
    const match = /^\/\/ node_modules\/((?:@[^/]+\/[^/]+)|[^/]+)\//.exec(line)
    if (match?.[1] === undefined) {
      throw new Error(`desktop licenses: malformed pkg bootstrap package marker ${JSON.stringify(line)}`)
    }
    packages.add(match[1])
  }
  const names = [...packages].sort()
  const unknown = names.filter(name => !REVIEWED_PKG_BOOTSTRAP_PACKAGES.has(name))
  const missing = [...REVIEWED_PKG_BOOTSTRAP_PACKAGES.keys()].filter(name => !packages.has(name))
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      'desktop licenses: pkg SEA bootstrap package closure changed; '
      + `unreviewed: ${unknown.join(', ') || '(none)'}; missing: ${missing.join(', ') || '(none)'}.`,
    )
  }
  return names
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function validateFetchRetryPolicy(policy: FetchRetryPolicy): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1
    || !Number.isSafeInteger(policy.attemptTimeoutMs) || policy.attemptTimeoutMs < 1
    || !Number.isSafeInteger(policy.maxResponseBytes) || policy.maxResponseBytes < 1
    || policy.retryDelaysMs.length !== policy.maxAttempts - 1
    || policy.retryDelaysMs.some(delay => !Number.isSafeInteger(delay) || delay < 0)) {
    throw new Error('desktop licenses: invalid bounded fetch retry policy.')
  }
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500 && status <= 599
}

function retryableNetworkFailure(error: unknown, depth = 0): boolean {
  if (depth > 4) return false
  if (error instanceof TypeError) return true
  if (!isRecord(error)) return false
  if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'NetworkError') return true
  const code = typeof error.code === 'string' ? error.code : ''
  if (RETRYABLE_NETWORK_CODES.has(code) || code.startsWith('UND_ERR_')) {
    return true
  }
  return retryableNetworkFailure(error.cause, depth + 1)
}

function failureSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function defaultRetrySleep(delayMs: number): Promise<void> {
  await new Promise<void>(resolvePromise => setTimeout(resolvePromise, delayMs))
}

/** Fetch a pinned file with a deterministic, bounded retry and timeout policy. */
export async function fetchPinnedBytes(
  url: string,
  policy: FetchRetryPolicy,
  dependencies: FetchRetryDependencies = {},
): Promise<Buffer> {
  validateFetchRetryPolicy(policy)
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch
  const sleep = dependencies.sleep ?? defaultRetrySleep
  let lastFailure: unknown

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let response: Response | undefined
    try {
      response = await fetchImplementation(url, { signal: AbortSignal.timeout(policy.attemptTimeoutMs) })
    } catch (error) {
      if (!retryableNetworkFailure(error)) throw error
      lastFailure = error
    }

    if (response !== undefined) {
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        const failure = new Error(`HTTP ${String(response.status)}`)
        if (!retryableHttpStatus(response.status)) throw failure
        lastFailure = failure
      } else {
        let bytes: Buffer | undefined
        try {
          bytes = Buffer.from(await response.arrayBuffer())
        } catch (error) {
          if (!retryableNetworkFailure(error)) throw error
          lastFailure = error
        }
        if (bytes !== undefined) {
          if (bytes.length === 0 || bytes.length > policy.maxResponseBytes) {
            throw new Error(
              `response is empty or exceeds ${String(policy.maxResponseBytes)} bytes`,
            )
          }
          return bytes
        }
      }
    }

    if (attempt === policy.maxAttempts) {
      throw new Error(
        `fetch failed after ${String(policy.maxAttempts)} attempts: ${failureSummary(lastFailure)}`,
        { cause: lastFailure },
      )
    }
    await sleep(policy.retryDelaysMs[attempt - 1] ?? 0)
  }
  throw new Error('desktop licenses: bounded fetch retry loop ended unexpectedly.')
}

function normalizeExpression(expression: string): string {
  return expression.replace(/\s*\/\s*/g, ' OR ').trim()
}

function licenseIdentifiers(expression: string): string[] {
  let parsed: ReturnType<typeof parseSpdx>
  try {
    parsed = parseSpdx(normalizeExpression(expression))
  } catch {
    throw new Error(`desktop licenses: ${JSON.stringify(expression)} is not a valid SPDX expression.`)
  }
  const identifiers = new Set<string>()
  const visit = (node: ReturnType<typeof parseSpdx>): void => {
    if ('conjunction' in node) {
      visit(node.left)
      visit(node.right)
      return
    }
    if (node.exception !== undefined || node.plus === true || !REVIEWED_LICENSES.has(node.license)) {
      throw new Error(
        `desktop licenses: ${JSON.stringify(expression)} contains unreviewed or forbidden SPDX term ${node.license}`,
      )
    }
    identifiers.add(node.license)
  }
  visit(parsed)
  return [...identifiers].sort()
}

function manifestAuthors(manifest: NpmManifest): string[] {
  const contributors: unknown[] = Array.isArray(manifest.contributors)
    ? manifest.contributors.map((value: unknown) => value)
    : []
  const values: unknown[] = [manifest.author, ...contributors]
  const authors = values.flatMap((value): string[] => {
    if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    const email = typeof row.email === 'string' ? ` <${row.email.trim()}>` : ''
    return name === '' ? [] : [`${name}${email}`]
  })
  return [...new Set(authors)].sort()
}

function manifestRepository(manifest: NpmManifest): string | undefined {
  const value = manifest.repository
  const url = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).url === 'string'
      ? String((value as Record<string, unknown>).url)
      : typeof manifest.homepage === 'string'
        ? manifest.homepage
        : undefined
  return url?.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '')
}

async function directTextFiles(directory: string, explicit?: string | null): Promise<string[]> {
  const files = new Set<string>()
  if (explicit !== undefined && explicit !== null) {
    const path = resolve(directory, explicit)
    if (path !== directory && path.startsWith(directory + sep) && existsSync(path) && (await stat(path)).isFile()) {
      files.add(path)
    }
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && TEXT_FILE.test(entry.name)) files.add(join(directory, entry.name))
  }
  return [...files].sort()
}

async function pinnedUpstreamText(name: string, url: string, expectedSha256: string): Promise<string> {
  await mkdir(PINNED_SOURCE_DIRECTORY, { recursive: true })
  const destination = join(PINNED_SOURCE_DIRECTORY, outputSegment(name))
  if (existsSync(destination) && sha256(await readFile(destination)) === expectedSha256) return destination
  let bytes: Buffer
  try {
    bytes = await fetchPinnedBytes(url, PINNED_TEXT_FETCH_POLICY)
  } catch (error) {
    throw new Error(`desktop licenses: could not fetch pinned license source ${url}: ${failureSummary(error)}`)
  }
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`desktop licenses: pinned license source changed or was corrupted: ${url}`)
  }
  await writeFile(destination, bytes)
  return destination
}

async function pinnedSourceArtifact(
  spec: SourceArtifactSpec,
  cacheDirectory = SOURCE_ARTIFACT_DIRECTORY,
): Promise<string> {
  await mkdir(cacheDirectory, { recursive: true })
  const destination = join(cacheDirectory, outputSegment(spec.name))
  if (existsSync(destination) && sha256(await readFile(destination)) === spec.expectedSha256) return destination
  let bytes: Buffer
  try {
    bytes = await fetchPinnedBytes(spec.url, PINNED_SOURCE_FETCH_POLICY)
  } catch (error) {
    throw new Error(`desktop licenses: could not fetch pinned source artifact ${spec.url}: ${failureSummary(error)}`)
  }
  if (sha256(bytes) !== spec.expectedSha256) {
    throw new Error(`desktop licenses: pinned source artifact changed, is empty, or exceeds 128 MiB: ${spec.url}`)
  }
  await writeFile(destination, bytes)
  return destination
}

async function pinnedArchiveMember(
  archiveName: string,
  url: string,
  archiveSha256: string,
  member: string,
  memberName: string,
  expectedSha256: string,
): Promise<string> {
  const archive = await pinnedSourceArtifact({
    name: archiveName,
    version: 'pinned',
    repository: url,
    revision: archiveSha256,
    url,
    expectedSha256: archiveSha256,
    purpose: 'pinned upstream source',
    relatedPackages: [],
  })
  await mkdir(PINNED_SOURCE_DIRECTORY, { recursive: true })
  const destination = join(PINNED_SOURCE_DIRECTORY, outputSegment(memberName))
  if (existsSync(destination) && sha256(await readFile(destination)) === expectedSha256) return destination
  const bytes = await new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn('tar', ['-xOf', archive, member], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let stderr = ''
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= 1_048_576) chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && size <= 1_048_576) resolvePromise(Buffer.concat(chunks))
      else reject(new Error(
        `desktop licenses: could not extract ${member} from pinned archive `
        + `(${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}): ${stderr.trim()}`,
      ))
    })
  })
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`desktop licenses: pinned archive member changed or was corrupted: ${member}`)
  }
  await writeFile(destination, bytes)
  return destination
}

/** Validate the exact 29-component table in sharp-libvips' pinned upstream notice. */
export function sharpLibvipsNoticeComponents(notice: string): string[] {
  const components = notice.split(/\r?\n/).flatMap((line): string[] => {
    const match = /^\|\s*([a-z0-9][a-z0-9-]*)\s*\|/.exec(line)
    return match?.[1] === undefined ? [] : [match[1]]
  })
  if (new Set(components).size !== components.length) {
    throw new Error('desktop licenses: sharp-libvips notice repeats a component.')
  }
  const actual = [...components].sort()
  const expected = [...SHARP_LIBVIPS_NOTICE_COMPONENTS].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `desktop licenses: sharp-libvips notice component closure changed; expected ${String(expected.length)}, found ${String(actual.length)}.`,
    )
  }
  return actual
}

function sharpLibvipsSourceOffer(): string {
  return [
    'Sharp/libvips corresponding source included with this distribution',
    '',
    'The installer carries complete, hash-verified source archives for all 29 components listed',
    'in the pinned sharp-libvips third-party notice. It also carries the exact sharp-libvips build',
    'recipe, versions.properties, and every downloaded patch. Find these files below',
    '`THIRD_PARTY_LICENSES/source-artifacts`; `manifest.json` maps every component to its archive,',
    'original license/notice members, URL, revision, SHA-256, size, and related binary package.',
    'No network access or future source offer is needed to inspect, copy, modify, or rebuild them.',
    '',
    'The upstream notice is a summary; the original files in each source archive are authoritative.',
    'Its Cairo row says MPL 2.0, while Cairo 1.18.4 COPYING offers LGPL 2.1 or MPL 1.1.',
    'This bundle includes Cairo COPYING, COPYING-LGPL-2.1, and COPYING-MPL-1.1 unchanged.',
    '',
    `POSIX source recipe: https://github.com/lovell/sharp-libvips/tree/${SHARP_LIBVIPS_COMMIT}`,
    `Windows source recipe: https://github.com/lovell/sharp-libvips/tree/${WINDOWS_SHARP_LIBVIPS_COMMIT}`,
    '',
  ].join('\n')
}

async function pinnedSharpLibvipsFiles(): Promise<string[]> {
  const base = `https://raw.githubusercontent.com/lovell/sharp-libvips/${SHARP_LIBVIPS_COMMIT}`
  const offer = join(PINNED_SOURCE_DIRECTORY, 'sharp-libvips-CORRESPONDING-SOURCE-INCLUDED.txt')
  await mkdir(PINNED_SOURCE_DIRECTORY, { recursive: true })
  await writeFile(offer, sharpLibvipsSourceOffer())
  const notice = await pinnedUpstreamText('sharp-libvips-1.3.2-THIRD-PARTY-NOTICES.md', `${base}/THIRD-PARTY-NOTICES.md`, '25ffcfa69e28b1913ced27ec778b90f24911a1bb3021253577e8b0af55db0d49')
  sharpLibvipsNoticeComponents(await readFile(notice, 'utf8'))
  return [
    await pinnedUpstreamText('sharp-libvips-1.3.2-LICENSE', `${base}/LICENSE`, 'b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1'),
    notice,
    await pinnedUpstreamText('sharp-libvips-1.3.2-versions.properties', `${base}/versions.properties`, 'cebb421de9568ae3ce8cfd66be62c3da53c2d549232c2e4327d9a9f97276c237'),
    offer,
  ]
}

async function pinnedWindowsSharpLibvipsFiles(): Promise<string[]> {
  const base = `https://raw.githubusercontent.com/lovell/sharp-libvips/${WINDOWS_SHARP_LIBVIPS_COMMIT}`
  const included = join(PINNED_SOURCE_DIRECTORY, 'sharp-libvips-CORRESPONDING-SOURCE-INCLUDED.txt')
  await mkdir(PINNED_SOURCE_DIRECTORY, { recursive: true })
  await writeFile(included, sharpLibvipsSourceOffer())
  const notice = await pinnedUpstreamText('sharp-libvips-windows-THIRD-PARTY-NOTICES.md', `${base}/THIRD-PARTY-NOTICES.md`, '25ffcfa69e28b1913ced27ec778b90f24911a1bb3021253577e8b0af55db0d49')
  sharpLibvipsNoticeComponents(await readFile(notice, 'utf8'))
  return [
    await pinnedUpstreamText('sharp-libvips-windows-LICENSE', `${base}/LICENSE`, 'b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1'),
    notice,
    await pinnedUpstreamText('sharp-libvips-windows-versions.properties', `${base}/versions.properties`, '3ec5062bb7407e7ef85b295e21cb596cc290217fee170003388aa408b49b2636'),
    included,
  ]
}

/** Convert sharp-libvips' fixed properties file to the staged versions.json shape. */
export function sharpLibvipsVersions(properties: string): Record<string, string> {
  const aliases: Record<string, string> = { ARCHIVE: 'archive', EXIF: 'exif', FFI: 'ffi', HEIF: 'heif', IMAGEQUANT: 'imagequant', PNG: 'png', RSVG: 'rsvg', TIFF: 'tiff', UHDR: 'uhdr', VIPS: 'vips', XML2: 'xml2', ZLIB_NG: 'zlib-ng', PROXY_LIBINTL: 'proxy-libintl' }
  const result: Record<string, string> = {}
  for (const line of properties.trim().split(/\r?\n/)) {
    const match = /^VERSION_([A-Z0-9_]+)=(\S+)$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`desktop licenses: malformed sharp-libvips versions line ${JSON.stringify(line)}`)
    }
    result[aliases[match[1]] ?? match[1].toLowerCase().replaceAll('_', '-')] = match[2]
  }
  if (Object.keys(result).length !== 28) {
    throw new Error(`desktop licenses: expected 28 sharp-libvips component versions, found ${String(Object.keys(result).length)}`)
  }
  return result
}

async function posixSharpVersions(): Promise<Record<string, string>> {
  const upstream = await pinnedSharpLibvipsFiles()
  const propertiesPath = upstream[2]
  if (propertiesPath === undefined) throw new Error('desktop licenses: pinned sharp-libvips versions.properties is missing.')
  return sharpLibvipsVersions(await readFile(propertiesPath, 'utf8'))
}

async function verifySharpLibvipsPackage(name: string, version: string, directory: string): Promise<void> {
  if (version !== SHARP_LIBVIPS_VERSION) {
    throw new Error(`desktop licenses: ${name}@${version} is not reviewed sharp-libvips ${SHARP_LIBVIPS_VERSION}.`)
  }
  const staged = JSON.parse(await readFile(join(directory, 'versions.json'), 'utf8')) as unknown
  if (!isRecord(staged) || JSON.stringify(staged) !== JSON.stringify(await posixSharpVersions())) {
    throw new Error(`desktop licenses: ${name}@${version} versions.json does not match pinned sharp-libvips provenance.`)
  }
}

async function verifyFileSha256(path: string, expected: string, label: string): Promise<void> {
  if (!existsSync(path) || !(await stat(path)).isFile() || sha256(await readFile(path)) !== expected) {
    throw new Error(`desktop licenses: ${label} is missing or does not match its reviewed SHA-256.`)
  }
}

async function windowsSharpVersions(): Promise<Record<string, string>> {
  const archiveUrl = `https://codeload.github.com/lovell/sharp-libvips/tar.gz/${WINDOWS_SHARP_LIBVIPS_COMMIT}`
  const properties = await pinnedArchiveMember(
    'sharp-libvips-windows-recipe-a2d035.tar.gz',
    archiveUrl,
    WINDOWS_SHARP_LIBVIPS_ARCHIVE_SHA256,
    `sharp-libvips-${WINDOWS_SHARP_LIBVIPS_COMMIT}/versions.properties`,
    'sharp-libvips-windows-versions.properties',
    '3ec5062bb7407e7ef85b295e21cb596cc290217fee170003388aa408b49b2636',
  )
  return sharpLibvipsVersions(await readFile(properties, 'utf8'))
}

async function verifyWindowsSharpPackage(name: string, version: string, directory: string): Promise<void> {
  if (name !== '@img/sharp-win32-x64' || version !== '0.35.3') {
    throw new Error(`desktop licenses: ${name}@${version} is not the reviewed Windows sharp payload.`)
  }
  const staged = JSON.parse(await readFile(join(directory, 'versions.json'), 'utf8')) as unknown
  if (!isRecord(staged) || JSON.stringify(staged) !== JSON.stringify(await windowsSharpVersions())) {
    throw new Error(`desktop licenses: ${name}@${version} versions.json does not match the pinned Windows libvips recipe.`)
  }
}

async function pinnedOnigurumaFiles(): Promise<string[]> {
  const archiveUrl = `https://registry.npmjs.org/vscode-oniguruma/-/vscode-oniguruma-${VSCODE_ONIGURUMA_VERSION}.tgz`
  return [
    await pinnedArchiveMember('vscode-oniguruma-1.7.0.tgz', archiveUrl, VSCODE_ONIGURUMA_ARCHIVE_SHA256, 'package/LICENSE.txt', 'vscode-oniguruma-1.7.0-LICENSE.txt', 'ddde8aba8fe72b4830e27901fc78733eb6db7b6c653161075de213a6adeda3fd'),
    await pinnedArchiveMember('vscode-oniguruma-1.7.0.tgz', archiveUrl, VSCODE_ONIGURUMA_ARCHIVE_SHA256, 'package/NOTICES.txt', 'vscode-oniguruma-1.7.0-NOTICES.txt', '615d94d89eacc046241518c247f6650a5df80d1adf4b284a756f500867620b35'),
  ]
}

async function pinnedKoffiVendorFiles(): Promise<{ addonApi: string; nodeApi: string }> {
  const archiveUrl = `https://registry.npmjs.org/koffi/-/koffi-${KOFFI_VERSION}.tgz`
  return {
    addonApi: await pinnedArchiveMember('koffi-3.1.1-source.tgz', archiveUrl, KOFFI_ARCHIVE_SHA256, 'package/vendor/node-addon-api/LICENSE.md', 'koffi-3.1.1-node-addon-api-LICENSE.md', '89024017b88a9f2b763f79b941a4f2db3b4428edfcacdc0b23866b2da633ad0c'),
    nodeApi: await pinnedArchiveMember('koffi-3.1.1-source.tgz', archiveUrl, KOFFI_ARCHIVE_SHA256, 'package/vendor/node-api-headers/LICENSE', 'koffi-3.1.1-node-api-headers-LICENSE', 'a553508f516031c91f3af1148d44970cb81bbae6c4f091be6835d39cc252238c'),
  }
}

async function pinnedTerminalFiles(): Promise<string[]> {
  const terminalBase = `https://raw.githubusercontent.com/microsoft/terminal/${TERMINAL_LICENSE_COMMIT}`
  return [
    await pinnedUpstreamText('Microsoft-Terminal-ConPTY-LICENSE', `${terminalBase}/LICENSE`, '5d177f23ecfeb0ea8e050b6a5a16355e1ae9a0b286436ca8f83ed08b3795be6b'),
    await pinnedUpstreamText('Microsoft-Terminal-ConPTY-NOTICE.md', `${terminalBase}/NOTICE.md`, 'e7fbaadee6ab20c28b87730a510ee5f5815d8fb4bd88d1d54d282dc2a74c0726'),
  ]
}

async function auditedNpmFallbackFiles(name: string, version: string, directory: string): Promise<string[]> {
  if (name === 'data-uri-to-buffer' && version === '4.0.1') return [join(directory, 'README.md')]
  if (name === '@earendil-works/pi-ai') {
    if (version !== '0.82.1') {
      throw new Error(`desktop licenses: ${name}@${version} needs a reviewed upstream license-text pin.`)
    }
    return [await pinnedUpstreamText(
      'pi-ai-0.82.1-LICENSE',
      'https://raw.githubusercontent.com/earendil-works/pi/b4f293684bba718d59cc1157679bcf6157b3a7f5/LICENSE',
      '0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48',
    )]
  }
  if (name === '@nodable/entities') {
    if (version !== '2.2.0') throw new Error(`desktop licenses: ${name}@${version} needs a reviewed upstream license-text pin.`)
    return [await pinnedUpstreamText(
      'nodable-entities-2.2.0-LICENSE',
      'https://raw.githubusercontent.com/nodable/val-parsers/d2070d76a8ba07e6c7fa142caeb51ffd756e47eb/LICENSE',
      '750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40',
    )]
  }
  if (name === 'xml-naming') {
    if (version !== '0.1.0') throw new Error(`desktop licenses: ${name}@${version} needs a reviewed upstream license-text pin.`)
    return [await pinnedUpstreamText(
      'xml-naming-0.1.0-LICENSE',
      'https://raw.githubusercontent.com/NaturalIntelligence/xml-naming/0330d0cfa57ee483a834c474b2d0a4f0449ee81d/LICENSE',
      '8e75fc0e776c62ccadb8178ece8d3daa9ba7601fb0a49b2dfb0ea9a7a5c0aa07',
    )]
  }
  if (/^@img\/sharp-libvips-[a-z0-9-]+$/.test(name)) {
    await verifySharpLibvipsPackage(name, version, directory)
    return [join(directory, 'README.md'), ...await pinnedSharpLibvipsFiles()]
  }
  return []
}

async function npmPackageDirectories(npmRoot: string): Promise<string[]> {
  const directories = [npmRoot]
  const visitedNodeModules = new Set<string>()
  const visitNodeModules = async (nodeModules: string): Promise<void> => {
    if (!existsSync(nodeModules)) return
    const canonical = await realpath(nodeModules)
    if (visitedNodeModules.has(canonical)) return
    visitedNodeModules.add(canonical)
    for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
      if (entry.name === '.bin') continue
      const path = join(nodeModules, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`desktop licenses: staged npm closure contains symlink ${path}`)
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('@')) {
        for (const scoped of await readdir(path, { withFileTypes: true })) {
          const packageDirectory = join(path, scoped.name)
          if (scoped.isSymbolicLink()) throw new Error(`desktop licenses: staged npm closure contains symlink ${packageDirectory}`)
          if (!scoped.isDirectory() || !existsSync(join(packageDirectory, 'package.json'))) continue
          directories.push(packageDirectory)
          await visitNodeModules(join(packageDirectory, 'node_modules'))
        }
        continue
      }
      if (!existsSync(join(path, 'package.json'))) continue
      directories.push(path)
      await visitNodeModules(join(path, 'node_modules'))
    }
  }
  await visitNodeModules(join(npmRoot, 'node_modules'))
  return directories.sort()
}

async function collectNpm(npmRoot: string, rustTarget: string): Promise<RawPackage[]> {
  const packages: RawPackage[] = []
  for (const packageDirectory of await npmPackageDirectories(npmRoot)) {
    const manifestPath = join(packageDirectory, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as NpmManifest
    if (typeof manifest.name !== 'string' || manifest.name === '') {
      throw new Error(`desktop licenses: staged npm package has no name: ${manifestPath}`)
    }
    if (typeof manifest.version !== 'string' || manifest.version === '') {
      throw new Error(`desktop licenses: ${manifest.name} has no version: ${manifestPath}`)
    }
    if (typeof manifest.license !== 'string' || manifest.license.trim() === '') {
      throw new Error(`desktop licenses: ${manifest.name}@${manifest.version} has no SPDX license field.`)
    }
    licenseIdentifiers(manifest.license)
    const directFiles = await directTextFiles(packageDirectory)
    const supplementalTextFiles: string[] = []
    if (/^@img\/sharp-libvips-[a-z0-9-]+$/.test(manifest.name)) {
      await verifySharpLibvipsPackage(manifest.name, manifest.version, packageDirectory)
      supplementalTextFiles.push(join(packageDirectory, 'README.md'), ...await pinnedSharpLibvipsFiles())
    }
    if (/^@img\/sharp-(?:darwin|linux|linuxmusl|win32)-[a-z0-9-]+$/.test(manifest.name)
      && existsSync(join(packageDirectory, 'README.md'))) {
      if (rustTarget === 'x86_64-pc-windows-msvc') {
        await verifyWindowsSharpPackage(manifest.name, manifest.version, packageDirectory)
        supplementalTextFiles.push(...await pinnedWindowsSharpLibvipsFiles())
      }
      supplementalTextFiles.push(join(packageDirectory, 'README.md'))
    }
    if (/^@vscode\/ripgrep-(?:darwin|linux|win32)-[a-z0-9-]+$/.test(manifest.name)) {
      if (manifest.version !== '1.18.0') {
        throw new Error(`desktop licenses: ${manifest.name}@${manifest.version} has unreviewed ripgrep provenance.`)
      }
      const base = `https://raw.githubusercontent.com/BurntSushi/ripgrep/${RIPGREP_COMMIT}`
      const prebuilt = `https://raw.githubusercontent.com/microsoft/ripgrep-prebuilt/${RIPGREP_PREBUILT_COMMIT}`
      supplementalTextFiles.push(
        await pinnedUpstreamText('ripgrep-15.0.0-LICENSE-MIT', `${base}/LICENSE-MIT`, '0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f'),
        await pinnedUpstreamText('ripgrep-15.0.0-UNLICENSE', `${base}/UNLICENSE`, '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c'),
        await pinnedUpstreamText('ripgrep-15.0.0-COPYING', `${base}/COPYING`, '01c266bced4a434da0051174d6bee16a4c82cf634e2679b6155d40d75012390f'),
        await pinnedUpstreamText('ripgrep-prebuilt-v15.0.0-LICENSE', `${prebuilt}/LICENSE`, 'dea9265341829002e2c23a7372393eb2ed6e26085fb623f38a4ba0af833f30a6'),
        await pinnedUpstreamText('ripgrep-prebuilt-v15.0.0-config.json', `${prebuilt}/config.json`, '71bc7b3ecdd5442001f74896a738eafb3b831ee5a183e128067fe6b6d6b64ea7'),
        await pinnedUpstreamText('ripgrep-prebuilt-v15.0.0-patch', `${prebuilt}/patches/0001-resolve-binskim-issues.patch`, '45f8b58bba714c446de407f93120f557736b45fad6f43ea283077201646a1be7'),
      )
    }
    if (/^@koromix\/koffi-(?:darwin|linux|win32)-[a-z0-9-]+$/.test(manifest.name)) {
      if (manifest.version !== KOFFI_VERSION) {
        throw new Error(`desktop licenses: ${manifest.name}@${manifest.version} has unreviewed vendored-header provenance.`)
      }
      const vendor = await pinnedKoffiVendorFiles()
      supplementalTextFiles.push(vendor.addonApi, vendor.nodeApi)
    }
    if (manifest.name === 'node-pty') {
      if (manifest.version !== NODE_PTY_VERSION) {
        throw new Error(`desktop licenses: node-pty@${manifest.version} has unreviewed native provenance.`)
      }
      if (rustTarget === 'x86_64-pc-windows-msvc') {
        const winptyLicense = join(packageDirectory, 'deps/winpty/LICENSE')
        if (!existsSync(winptyLicense)) {
          throw new Error('desktop licenses: Windows node-pty payload is missing deps/winpty/LICENSE.')
        }
        const retained = Object.keys(NATIVE_TARGET_PROVENANCE[rustTarget]?.nodePtyFiles ?? {})
          .filter(relativePath => existsSync(join(packageDirectory, ...relativePath.split('/'))))
        nodePtyNoticeRequirements(rustTarget, retained)
        supplementalTextFiles.push(winptyLicense, ...await pinnedTerminalFiles())
      }
    }
    const originalTextFiles = [...new Set([...directFiles, ...supplementalTextFiles])].sort()
    const repository = manifestRepository(manifest)
    packages.push({
      ecosystem: 'npm',
      name: manifest.name,
      version: manifest.version,
      licenseExpression: normalizeExpression(manifest.license),
      authors: manifestAuthors(manifest),
      ...repository === undefined ? {} : { repository },
      packageDirectory,
      originalTextFiles: originalTextFiles.length > 0
        ? originalTextFiles
        : await auditedNpmFallbackFiles(manifest.name, manifest.version, packageDirectory),
    })
  }
  return packages
}

async function collectCargo(metadata: CargoMetadata): Promise<RawPackage[]> {
  if (metadata.resolve === null) throw new Error('desktop licenses: Cargo metadata has no resolved dependency graph.')
  const resolved = new Set(metadata.resolve.nodes.map(node => node.id))
  const workspace = new Set(metadata.workspace_members)
  const packages: RawPackage[] = []
  for (const manifest of metadata.packages) {
    if (!resolved.has(manifest.id) || workspace.has(manifest.id)) continue
    if (manifest.license === null || manifest.license.trim() === '') {
      throw new Error(`desktop licenses: Rust crate ${manifest.name}@${manifest.version} has no SPDX license field.`)
    }
    licenseIdentifiers(manifest.license)
    const packageDirectory = dirname(manifest.manifest_path)
    const repository = manifest.repository ?? manifest.homepage ?? undefined
    packages.push({
      ecosystem: 'cargo',
      name: manifest.name,
      version: manifest.version,
      licenseExpression: normalizeExpression(manifest.license),
      authors: [...manifest.authors].sort(),
      ...repository === undefined ? {} : { repository },
      packageDirectory,
      originalTextFiles: await directTextFiles(packageDirectory, manifest.license_file),
    })
  }
  return packages.sort(comparePackage)
}

function comparePackage(left: Pick<RawPackage, 'ecosystem' | 'name' | 'version'>, right: Pick<RawPackage, 'ecosystem' | 'name' | 'version'>): number {
  return `${left.ecosystem}\0${left.name}\0${left.version}`.localeCompare(`${right.ecosystem}\0${right.name}\0${right.version}`)
}

function packageId(row: Pick<RawPackage, 'ecosystem' | 'name' | 'version'>): string {
  return `${row.ecosystem}:${row.name}@${row.version}`
}

function outputSegment(value: string): string {
  const segment = value.replace(/^@/, '').replaceAll('/', '__').replace(/[^A-Za-z0-9._+-]/g, '_')
  if (segment === '' || segment === '.' || segment === '..') throw new Error(`desktop licenses: unsafe output segment ${JSON.stringify(value)}`)
  return segment
}

function textSourcesForPackage(
  row: RawPackage,
  packages: RawPackage[],
  canonicalDonors: ReadonlyMap<string, RawPackage>,
  projectLicense: string,
): TextSource[] {
  if (row.originalTextFiles.length > 0) {
    return row.originalTextFiles.map(sourcePath => ({
      sourcePath,
      origin: sourcePath.startsWith(PINNED_SOURCE_DIRECTORY + sep) ? 'pinned-upstream' : 'package',
      sourcePackage: packageId(row),
    }))
  }
  if (row.ecosystem === 'npm'
    && row.name.startsWith('@deepseek-ai/')
    && row.licenseExpression === 'MIT') {
    return [{ sourcePath: projectLicense, origin: 'project-license', sourcePackage: packageId(row), licenseId: 'MIT' }]
  }
  if (row.ecosystem === 'npm'
    && row.name.startsWith('@deepseek-ai/node-addon-landlock-run')
    && row.licenseExpression === 'BSD-3-Clause') {
    return [{ sourcePath: LANDLOCK_PROJECT_LICENSE, origin: 'project-license', sourcePackage: packageId(row), licenseId: 'BSD-3-Clause' }]
  }
  const repositorySibling = row.repository === undefined ? undefined : packages.find(candidate => (
    candidate !== row
    && candidate.repository === row.repository
    && candidate.originalTextFiles.length > 0
    && candidate.licenseExpression === row.licenseExpression
  ))
  if (repositorySibling !== undefined) {
    return repositorySibling.originalTextFiles.map(sourcePath => ({
      sourcePath,
      origin: 'repository-sibling',
      sourcePackage: packageId(repositorySibling),
    }))
  }
  if (!REVIEWED_CANONICAL_TEXT_FALLBACKS.has(packageId(row))) {
    throw new Error(`desktop licenses: ${packageId(row)} has no original license/notice text or reviewed same-repository donor.`)
  }
  const donors = licenseIdentifiers(row.licenseExpression).map((licenseId): TextSource => {
    const donor = canonicalDonors.get(licenseId)
    const sourcePath = donor?.originalTextFiles[0]
    if (donor === undefined || sourcePath === undefined) {
      throw new Error(
        `desktop licenses: ${packageId(row)} has no original license/notice text and no reviewed ${licenseId} donor.`,
      )
    }
    return {
      sourcePath,
      origin: 'canonical-license',
      sourcePackage: packageId(donor),
      licenseId,
    }
  })
  return donors
}

function canonicalDonors(packages: RawPackage[]): Map<string, RawPackage> {
  const donors = new Map<string, RawPackage>()
  for (const row of packages) {
    if (row.originalTextFiles.length === 0) continue
    const identifiers = licenseIdentifiers(row.licenseExpression)
    if (identifiers.length !== 1 || row.licenseExpression !== identifiers[0]) continue
    const [identifier] = identifiers
    if (!donors.has(identifier)) donors.set(identifier, row)
  }
  return donors
}

async function validatedText(path: string): Promise<string> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > 1_048_576) {
    throw new Error(`desktop licenses: license source must be a non-empty file no larger than 1 MiB: ${path}`)
  }
  const text = await readFile(path, 'utf8')
  if (text.includes('\0') || text.includes('\uFFFD') || text.trim() === '') {
    throw new Error(`desktop licenses: license source is not valid non-empty UTF-8 text: ${path}`)
  }
  return text.endsWith('\n') ? text : `${text}\n`
}

function copyrightLines(texts: string[], authors: string[]): string[] {
  const found = texts.flatMap(text => text.split(/\r?\n/)
    .filter(line => /^(?:\s*(?:copyright(?:\s+\(c\))?|©)\s+)/i.test(line))
    .map(line => line.trim())
    .filter(line => line !== ''))
  return [...new Set([...found, ...authors.map(author => `Declared author: ${author}`)])].sort().slice(0, 100)
}

async function writePackage(
  output: string,
  row: RawPackage,
  sources: TextSource[],
): Promise<LicenseManifestEntry> {
  const packageDirectory = join(output, 'packages', row.ecosystem, outputSegment(row.name), outputSegment(row.version))
  await mkdir(packageDirectory, { recursive: true })
  const files: OutputFile[] = []
  const texts: string[] = []
  const usedNames = new Set<string>()
  for (const [index, source] of sources.entries()) {
    const text = await validatedText(source.sourcePath)
    texts.push(text)
    const base = outputSegment(basename(source.sourcePath))
    let name = `${source.origin.toUpperCase()}-${base}`
    if (usedNames.has(name)) name = `${String(index + 1).padStart(2, '0')}-${name}`
    usedNames.add(name)
    const destination = join(packageDirectory, name)
    await writeFile(destination, text)
    files.push({
      path: relative(output, destination).split(sep).join('/'),
      sha256: sha256(text),
      origin: source.origin,
      sourceName: basename(source.sourcePath),
      sourcePackage: source.sourcePackage,
      ...(source.licenseId === undefined ? {} : { licenseId: source.licenseId }),
    })
  }
  const entry: LicenseManifestEntry = {
    ecosystem: row.ecosystem,
    name: row.name,
    version: row.version,
    licenseExpression: row.licenseExpression,
    authors: row.authors,
    ...(row.repository === undefined ? {} : { repository: row.repository }),
    copyrightLines: copyrightLines(texts, row.authors),
    files,
  }
  await writeFile(join(packageDirectory, 'METADATA.json'), `${JSON.stringify(entry, null, 2)}\n`)
  return entry
}

async function allFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) files.push(child)
      else throw new Error(`desktop licenses: unexpected non-file in output: ${child}`)
    }
  }
  await walk(directory)
  return files.sort()
}

function sourceArtifact(
  name: string,
  version: string,
  repository: string,
  revision: string,
  url: string,
  expectedSha256: string,
  purpose: string,
  relatedPackages: string[],
  requiredMembers?: string[],
): SourceArtifactSpec {
  return {
    name,
    version,
    repository,
    revision,
    url,
    expectedSha256,
    purpose,
    relatedPackages,
    ...(requiredMembers === undefined ? {} : { requiredMembers }),
  }
}

interface SharpComponentArchive {
  readonly components: string[]
  readonly name: string
  readonly version: string
  readonly repository: string
  readonly revision: string
  readonly url: string
  readonly sha256: string
  readonly licenseMembers: string[]
}

function sharpComponentSourceArtifact(
  input: SharpComponentArchive,
  relatedPackages: string[],
): SourceArtifactSpec {
  return {
    ...sourceArtifact(
      input.name,
      input.version,
      input.repository,
      input.revision,
      input.url,
      input.sha256,
      `Complete source and original license/notice files for sharp/libvips components: ${input.components.join(', ')}.`,
      relatedPackages,
      input.licenseMembers,
    ),
    components: [...input.components],
    licenseMembers: [...input.licenseMembers],
  }
}

function validateSharpComponentArtifacts(artifacts: readonly SourceArtifactSpec[]): void {
  const owners = new Map<string, string>()
  for (const artifact of artifacts) {
    if (artifact.components === undefined) continue
    if (artifact.components.length === 0 || artifact.licenseMembers === undefined
      || artifact.licenseMembers.length === 0 || artifact.requiredMembers === undefined) {
      throw new Error(`desktop licenses: sharp component artifact ${artifact.name} lacks original license members.`)
    }
    for (const member of artifact.licenseMembers) {
      if (!artifact.requiredMembers.includes(member)) {
        throw new Error(`desktop licenses: sharp component artifact ${artifact.name} does not verify ${member}.`)
      }
    }
    for (const component of artifact.components) {
      const previous = owners.get(component)
      if (previous !== undefined) {
        throw new Error(`desktop licenses: sharp component ${component} is repeated by ${previous} and ${artifact.name}.`)
      }
      owners.set(component, artifact.name)
    }
  }
  const actual = [...owners.keys()].sort()
  const expected = [...SHARP_LIBVIPS_NOTICE_COMPONENTS].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter(component => !owners.has(component))
    const unexpected = actual.filter(component => !expected.includes(component as typeof expected[number]))
    throw new Error(
      `desktop licenses: sharp source closure does not cover its 29 notices; missing: ${missing.join(', ') || '(none)'}; unexpected: ${unexpected.join(', ') || '(none)'}.`,
    )
  }
}

function validateSharpComponentVersions(
  artifacts: readonly SourceArtifactSpec[],
  versions: Readonly<Record<string, string>>,
): void {
  const componentForVersionKey: Readonly<Record<string, string>> = {
    archive: 'libarchive',
    exif: 'libexif',
    ffi: 'libffi',
    heif: 'libheif',
    imagequant: 'libimagequant',
    png: 'libpng',
    rsvg: 'librsvg',
    tiff: 'libtiff',
    uhdr: 'libultrahdr',
    vips: 'libvips',
    webp: 'libwebp',
    xml2: 'libxml2',
  }
  const artifactsByComponent = new Map<string, SourceArtifactSpec>()
  for (const artifact of artifacts) {
    for (const component of artifact.components ?? []) artifactsByComponent.set(component, artifact)
  }
  for (const [key, version] of Object.entries(versions)) {
    const component = componentForVersionKey[key] ?? key
    const artifact = artifactsByComponent.get(component)
    if (artifact?.version !== version) {
      throw new Error(
        `desktop licenses: sharp component ${component} source is ${String(artifact?.version)}, expected ${version}.`,
      )
    }
  }
}

function sharpSourceArtifacts(rustTarget: string): SourceArtifactSpec[] {
  const windows = rustTarget === 'x86_64-pc-windows-msvc'
  const relatedPackages = windows
    ? ['npm:@img/sharp-win32-x64@0.35.3']
    : rustTarget === 'aarch64-apple-darwin'
      ? ['npm:@img/sharp-darwin-arm64@0.35.3', 'npm:@img/sharp-libvips-darwin-arm64@1.3.2']
      : ['npm:@img/sharp-linux-x64@0.35.3', 'npm:@img/sharp-libvips-linux-x64@1.3.2']
  const recipeCommit = windows ? WINDOWS_SHARP_LIBVIPS_COMMIT : SHARP_LIBVIPS_COMMIT
  const recipeHash = windows ? WINDOWS_SHARP_LIBVIPS_ARCHIVE_SHA256 : SHARP_LIBVIPS_ARCHIVE_SHA256
  const componentArchives: SharpComponentArchive[] = [
    {
      components: ['aom'],
      name: 'aom-3.14.1-source.tar.gz',
      version: '3.14.1',
      repository: 'https://aomedia.googlesource.com/aom',
      revision: 'v3.14.1',
      url: 'https://storage.googleapis.com/aom-releases/libaom-3.14.1.tar.gz',
      sha256: '44bf90dbd23e734d50e70a8c41c285193922938bd0d3bc2ee56764d181d55ef5',
      licenseMembers: ['libaom-3.14.1/LICENSE', 'libaom-3.14.1/PATENTS'],
    },
    {
      components: ['cairo'],
      name: 'cairo-1.18.4.tar.xz',
      version: '1.18.4',
      repository: 'https://gitlab.freedesktop.org/cairo/cairo',
      revision: '1.18.4',
      url: 'https://cairographics.org/releases/cairo-1.18.4.tar.xz',
      sha256: '445ed8208a6e4823de1226a74ca319d3600e83f6369f99b14265006599c32ccb',
      licenseMembers: ['cairo-1.18.4/COPYING', 'cairo-1.18.4/COPYING-LGPL-2.1', 'cairo-1.18.4/COPYING-MPL-1.1'],
    },
    {
      components: ['cgif'],
      name: 'cgif-0.5.3-source.tar.gz',
      version: '0.5.3',
      repository: 'https://github.com/dloebl/cgif',
      revision: 'v0.5.3',
      url: 'https://github.com/dloebl/cgif/archive/v0.5.3.tar.gz',
      sha256: 'dcc7731e974ee77db75df26c99aca4d95f11ca2d267d870d42bce1e0d1e1e75f',
      licenseMembers: ['cgif-0.5.3/LICENSE'],
    },
    {
      components: ['fontconfig'],
      name: 'fontconfig-2.18.1-source.tar.gz',
      version: '2.18.1',
      repository: 'https://github.com/fontconfig/fontconfig',
      revision: 'd87ec67db56518e9e9c36ff38f151dfc9b728b2e',
      url: 'https://codeload.github.com/fontconfig/fontconfig/tar.gz/d87ec67db56518e9e9c36ff38f151dfc9b728b2e',
      sha256: '8d201c26f2e0e1ec8e888b8cfaad988b25a22286933bb69e7fbd040152bd7fd5',
      licenseMembers: ['fontconfig-d87ec67db56518e9e9c36ff38f151dfc9b728b2e/COPYING'],
    },
    {
      components: ['freetype'],
      name: 'freetype-2.14.3-source.tar.gz',
      version: '2.14.3',
      repository: 'https://github.com/freetype/freetype',
      revision: 'VER-2-14-3',
      url: 'https://github.com/freetype/freetype/archive/VER-2-14-3.tar.gz',
      sha256: 'dc49de6b01a266eef4876a4dd34d9842c475d3e28ff2eff63bd2fb760ab56261',
      licenseMembers: ['freetype-VER-2-14-3/LICENSE.TXT', 'freetype-VER-2-14-3/docs/FTL.TXT'],
    },
    {
      components: ['fribidi'],
      name: 'fribidi-1.0.16.tar.xz',
      version: '1.0.16',
      repository: 'https://github.com/fribidi/fribidi',
      revision: 'v1.0.16',
      url: 'https://github.com/fribidi/fribidi/releases/download/v1.0.16/fribidi-1.0.16.tar.xz',
      sha256: '1b1cde5b235d40479e91be2f0e88a309e3214c8ab470ec8a2744d82a5a9ea05c',
      licenseMembers: ['fribidi-1.0.16/COPYING'],
    },
    {
      components: ['harfbuzz'],
      name: 'harfbuzz-14.2.1-source.tar.gz',
      version: '14.2.1',
      repository: 'https://github.com/harfbuzz/harfbuzz',
      revision: '14.2.1',
      url: 'https://github.com/harfbuzz/harfbuzz/archive/14.2.1.tar.gz',
      sha256: '3c2a9006a7e1bf58737e557014d7882c554c628fb379a9f00008f5ea53dbbdfb',
      licenseMembers: ['harfbuzz-14.2.1/COPYING'],
    },
    {
      components: ['highway'],
      name: 'highway-1.4.0-source.tar.gz',
      version: '1.4.0',
      repository: 'https://github.com/google/highway',
      revision: '1.4.0',
      url: 'https://github.com/google/highway/archive/1.4.0.tar.gz',
      sha256: 'e72241ac9524bb653ae52ced768b508045d4438726a303f10181a38f764a453c',
      licenseMembers: ['highway-1.4.0/LICENSE'],
    },
    {
      components: ['lcms'],
      name: 'lcms2-2.19.1-source.tar.gz',
      version: '2.19.1',
      repository: 'https://github.com/mm2/Little-CMS',
      revision: 'lcms2.19.1',
      url: 'https://github.com/mm2/Little-CMS/releases/download/lcms2.19.1/lcms2-2.19.1.tar.gz',
      sha256: 'bfc54f7bab59fbc921012014a8032e4cba4abd46db47d46b76416a8c0b2815c8',
      licenseMembers: ['lcms2-2.19.1/LICENSE'],
    },
    {
      components: ['libexif'],
      name: 'libexif-0.6.26.tar.xz',
      version: '0.6.26',
      repository: 'https://github.com/libexif/libexif',
      revision: 'v0.6.26',
      url: 'https://github.com/libexif/libexif/releases/download/v0.6.26/libexif-0.6.26.tar.xz',
      sha256: '4a055ed6575e61ca46c3172be3c753cc16c9becd0f99ec71d58dd0e471476c0c',
      licenseMembers: ['libexif-0.6.26/COPYING'],
    },
    {
      components: ['libimagequant'],
      name: 'libimagequant-2.4.1-source.tar.gz',
      version: '2.4.1',
      repository: 'https://github.com/lovell/libimagequant',
      revision: 'v2.4.1',
      url: 'https://github.com/lovell/libimagequant/archive/v2.4.1.tar.gz',
      sha256: '47d2a84b7b1052975c9d50a3d4e3cacbf57b43d84a4c3131210848ead9964dfb',
      licenseMembers: ['libimagequant-2.4.1/COPYRIGHT'],
    },
    {
      components: ['libpng'],
      name: 'libpng-1.6.58-source.tar.gz',
      version: '1.6.58',
      repository: 'https://github.com/pnggroup/libpng',
      revision: 'v1.6.58',
      url: 'https://github.com/pnggroup/libpng/archive/v1.6.58.tar.gz',
      sha256: 'a9d4df463d36a6e5f9c29bd6f4967312d17e996c1854f3511f833924eb1993cf',
      licenseMembers: ['libpng-1.6.58/LICENSE'],
    },
    {
      components: ['libvips', 'libnsgif'],
      name: 'vips-8.18.3.tar.xz',
      version: '8.18.3',
      repository: 'https://github.com/libvips/libvips',
      revision: 'v8.18.3',
      url: 'https://github.com/libvips/libvips/releases/download/v8.18.3/vips-8.18.3.tar.xz',
      sha256: 'f41285b61bfb495605494f074ca341f7791a1d406e2f157dcea606ef1ae1b146',
      licenseMembers: ['vips-8.18.3/LICENSE', 'vips-8.18.3/libvips/foreign/libnsgif/COPYING'],
    },
    {
      components: ['libwebp'],
      name: 'libwebp-1.6.0-source.tar.gz',
      version: '1.6.0',
      repository: 'https://chromium.googlesource.com/webm/libwebp',
      revision: 'v1.6.0',
      url: 'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz',
      sha256: 'e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564',
      licenseMembers: ['libwebp-1.6.0/COPYING'],
    },
    {
      components: ['libxml2'],
      name: 'libxml2-2.15.3-source.tar.xz',
      version: '2.15.3',
      repository: 'https://gitlab.gnome.org/GNOME/libxml2',
      revision: 'v2.15.3',
      url: 'https://download.gnome.org/sources/libxml2/2.15/libxml2-2.15.3.tar.xz',
      sha256: '78262a6e7ac170d6528ebfe2efccdf220191a5af6a6cd61ea4a9a9a5042c7a07',
      licenseMembers: ['libxml2-2.15.3/Copyright'],
    },
    {
      components: ['mozjpeg'],
      name: 'mozjpeg-0826579-source.tar.gz',
      version: '0826579',
      repository: 'https://github.com/mozilla/mozjpeg',
      revision: '08265790774cd0714832c9e675522acbe5581437',
      url: 'https://codeload.github.com/mozilla/mozjpeg/tar.gz/08265790774cd0714832c9e675522acbe5581437',
      sha256: 'b680167bd5d9afebdd576a12f8c49d2c9066a3b92ef96a2b2c5f7829b8600fe5',
      licenseMembers: ['mozjpeg-08265790774cd0714832c9e675522acbe5581437/LICENSE.md'],
    },
    {
      components: ['pixman'],
      name: 'pixman-0.46.4-source.tar.gz',
      version: '0.46.4',
      repository: 'https://gitlab.freedesktop.org/pixman/pixman',
      revision: '0.46.4',
      url: 'https://cairographics.org/releases/pixman-0.46.4.tar.gz',
      sha256: 'd09c44ebc3bd5bee7021c79f922fe8fb2fb57f7320f55e97ff9914d2346a591c',
      licenseMembers: ['pixman-0.46.4/COPYING'],
    },
    {
      components: ['proxy-libintl'],
      name: 'proxy-libintl-0.5.tar.gz',
      version: '0.5',
      repository: 'https://github.com/frida/proxy-libintl',
      revision: '0.5',
      url: 'https://github.com/frida/proxy-libintl/archive/0.5.tar.gz',
      sha256: 'f7a1cbd7579baaf575c66f9d99fb6295e9b0684a28b095967cfda17857595303',
      licenseMembers: ['proxy-libintl-0.5/COPYING'],
    },
    {
      components: ['zlib-ng'],
      name: 'zlib-ng-2.3.3-source.tar.gz',
      version: '2.3.3',
      repository: 'https://github.com/zlib-ng/zlib-ng',
      revision: '2.3.3',
      url: 'https://github.com/zlib-ng/zlib-ng/archive/2.3.3.tar.gz',
      sha256: 'f9c65aa9c852eb8255b636fd9f07ce1c406f061ec19a2e7d508b318ca0c907d1',
      licenseMembers: ['zlib-ng-2.3.3/LICENSE.md'],
    },
    ...(windows ? [
      {
        components: ['libarchive'], name: 'libarchive-3.8.7.tar.xz', version: '3.8.7',
        repository: 'https://github.com/libarchive/libarchive', revision: 'v3.8.7',
        url: 'https://github.com/libarchive/libarchive/releases/download/v3.8.7/libarchive-3.8.7.tar.xz',
        sha256: 'd3a8ba457ae25c27c84fd2830a2efdcc5b1d40bf585d4eb0d35f47e99e5d4774',
        licenseMembers: ['libarchive-3.8.7/COPYING'],
      },
      {
        components: ['expat'], name: 'expat-2.8.1.tar.xz', version: '2.8.1',
        repository: 'https://github.com/libexpat/libexpat', revision: 'R_2_8_1',
        url: 'https://github.com/libexpat/libexpat/releases/download/R_2_8_1/expat-2.8.1.tar.xz',
        sha256: '10b195ee78160a908388180a8fe3603d4e9a12f4755fbf5f3816b23a9d750da0',
        licenseMembers: ['expat-2.8.1/COPYING'],
      },
      {
        components: ['libffi'], name: 'libffi-3.5.2.tar.gz', version: '3.5.2',
        repository: 'https://github.com/libffi/libffi', revision: 'v3.5.2',
        url: 'https://github.com/libffi/libffi/releases/download/v3.5.2/libffi-3.5.2.tar.gz',
        sha256: 'f3a3082a23b37c293a4fcd1053147b371f2ff91fa7ea1b2a52e335676bac82dc',
        licenseMembers: ['libffi-3.5.2/LICENSE'],
      },
      {
        components: ['glib'], name: 'glib-2.89.0.tar.xz', version: '2.89.0',
        repository: 'https://gitlab.gnome.org/GNOME/glib', revision: '2.89.0',
        url: 'https://download.gnome.org/sources/glib/2.89/glib-2.89.0.tar.xz',
        sha256: '205bf5dab175de68f11e33be7bb36d4ad4c5a5097d8c0c88a8682b257b6293dc',
        licenseMembers: ['glib-2.89.0/COPYING'],
      },
      {
        components: ['libheif'], name: 'libheif-1.23.0.tar.gz', version: '1.23.0',
        repository: 'https://github.com/strukturag/libheif', revision: 'v1.23.0',
        url: 'https://github.com/strukturag/libheif/releases/download/v1.23.0/libheif-1.23.0.tar.gz',
        sha256: '4c9182b18897617182eed12ab5eb9f9d855b3aa3a736d6bdb31abc034ec7d393',
        licenseMembers: ['libheif-1.23.0/COPYING'],
      },
      {
        components: ['librsvg'], name: 'librsvg-2.62.3.tar.xz', version: '2.62.3',
        repository: 'https://gitlab.gnome.org/GNOME/librsvg', revision: '2.62.3',
        url: 'https://download.gnome.org/sources/librsvg/2.62/librsvg-2.62.3.tar.xz',
        sha256: '7eb449b2722a768021356f66dfee3202c229b54ed4e6a70ce40c090e97ff16f2',
        licenseMembers: ['librsvg-2.62.3/COPYING.LIB'],
      },
      {
        components: ['libtiff'], name: 'libtiff-732665c-source.tar.gz', version: '732665c',
        repository: 'https://github.com/libsdl-org/libtiff', revision: '732665c2c8785cec3e1f46ba9908575f0f3a8059',
        url: 'https://codeload.github.com/libsdl-org/libtiff/tar.gz/732665c2c8785cec3e1f46ba9908575f0f3a8059',
        sha256: 'c4f01c3b31672d2163d7daf3acb7a3ac1b7a140b13cf5421baa3d1c572c5614c',
        licenseMembers: ['libtiff-732665c2c8785cec3e1f46ba9908575f0f3a8059/LICENSE.md'],
      },
      {
        components: ['libultrahdr'], name: 'libultrahdr-13a058f-source.tar.gz', version: '13a058f',
        repository: 'https://github.com/google/libultrahdr', revision: '13a058f452d846e43d4691f6885eeeaa8b0ea8d0',
        url: 'https://codeload.github.com/google/libultrahdr/tar.gz/13a058f452d846e43d4691f6885eeeaa8b0ea8d0',
        sha256: '4f386011edae866499e43626004c482d88c371d3002560b9b7bce9dc007f5307',
        licenseMembers: [
          'libultrahdr-13a058f452d846e43d4691f6885eeeaa8b0ea8d0/LICENSE',
          'libultrahdr-13a058f452d846e43d4691f6885eeeaa8b0ea8d0/adobe-hdr-gain-map-license/NOTICE',
        ],
      },
      {
        components: ['pango'], name: 'pango-1.57.1.tar.xz', version: '1.57.1',
        repository: 'https://gitlab.gnome.org/GNOME/pango', revision: '1.57.1',
        url: 'https://download.gnome.org/sources/pango/1.57/pango-1.57.1.tar.xz',
        sha256: 'e65d6d117080dc3aeeb7d8b4b3b518f7383aa2e6cfce23117c623cd624764c2f',
        licenseMembers: ['pango-1.57.1/COPYING'],
      },
    ] : [
      {
        components: ['libarchive'], name: 'libarchive-3.8.8.tar.xz', version: '3.8.8',
        repository: 'https://github.com/libarchive/libarchive', revision: 'v3.8.8',
        url: 'https://github.com/libarchive/libarchive/releases/download/v3.8.8/libarchive-3.8.8.tar.xz',
        sha256: '3873a88801da067d0528a989af06877710529d50ee8fe6f3970cbb4302efb918',
        licenseMembers: ['libarchive-3.8.8/COPYING'],
      },
      {
        components: ['expat'], name: 'expat-2.8.2.tar.xz', version: '2.8.2',
        repository: 'https://github.com/libexpat/libexpat', revision: 'R_2_8_2',
        url: 'https://github.com/libexpat/libexpat/releases/download/R_2_8_2/expat-2.8.2.tar.xz',
        sha256: '3ad89b8588e6644bd4e49981480d48b21289eebbcd4f0a1a4afb1c29f99b6ab4',
        licenseMembers: ['expat-2.8.2/COPYING'],
      },
      {
        components: ['libffi'], name: 'libffi-3.6.0.tar.gz', version: '3.6.0',
        repository: 'https://github.com/libffi/libffi', revision: 'v3.6.0',
        url: 'https://github.com/libffi/libffi/releases/download/v3.6.0/libffi-3.6.0.tar.gz',
        sha256: '31ff1fe32deaebfbb388727f32677bb254bf2a41382c51464c0b1837c9ee9828',
        licenseMembers: ['libffi-3.6.0/LICENSE'],
      },
      {
        components: ['glib'], name: 'glib-2.89.1.tar.xz', version: '2.89.1',
        repository: 'https://gitlab.gnome.org/GNOME/glib', revision: '2.89.1',
        url: 'https://download.gnome.org/sources/glib/2.89/glib-2.89.1.tar.xz',
        sha256: '74447129c31afe141810f995626e8b99ab677413dae76ee3cf5a9cc6e75a486e',
        licenseMembers: ['glib-2.89.1/COPYING'],
      },
      {
        components: ['libheif'], name: 'libheif-1.23.1.tar.gz', version: '1.23.1',
        repository: 'https://github.com/strukturag/libheif', revision: 'v1.23.1',
        url: 'https://github.com/strukturag/libheif/releases/download/v1.23.1/libheif-1.23.1.tar.gz',
        sha256: '0de0327f60fcd47de90d5654c6fe152232738d60d84fe084ec3e0f35e03b166a',
        licenseMembers: ['libheif-1.23.1/COPYING'],
      },
      {
        components: ['librsvg'], name: 'librsvg-2.62.90.tar.xz', version: '2.62.90',
        repository: 'https://gitlab.gnome.org/GNOME/librsvg', revision: '2.62.90',
        url: 'https://download.gnome.org/sources/librsvg/2.62/librsvg-2.62.90.tar.xz',
        sha256: '5d108758255c225590d862d94f2591ee1f8cc976dc7b25b06eaba74f21850f08',
        licenseMembers: ['librsvg-2.62.90/COPYING.LIB'],
      },
      {
        components: ['libtiff'], name: 'libtiff-d01a94b-source.tar.gz', version: 'd01a94b',
        repository: 'https://github.com/libsdl-org/libtiff', revision: 'd01a94be176f5f6a87f7ee1c0b32e65416aa2b4d',
        url: 'https://codeload.github.com/libsdl-org/libtiff/tar.gz/d01a94be176f5f6a87f7ee1c0b32e65416aa2b4d',
        sha256: '1379a37eb878b5f222e90e61ca761e668acc7e7fba8f320ffec2903923757847',
        licenseMembers: ['libtiff-d01a94be176f5f6a87f7ee1c0b32e65416aa2b4d/LICENSE.md'],
      },
      {
        components: ['libultrahdr'], name: 'libultrahdr-1acdbed-source.tar.gz', version: '1acdbed',
        repository: 'https://github.com/google/libultrahdr', revision: '1acdbed8c712e6923ebf9de4e7c8d8dda06509e9',
        url: 'https://codeload.github.com/google/libultrahdr/tar.gz/1acdbed8c712e6923ebf9de4e7c8d8dda06509e9',
        sha256: 'c5bdb5afc7cb8bc88cf8ba66f33f5cbfb540baaa22519d2e805fd998bb89af9c',
        licenseMembers: [
          'libultrahdr-1acdbed8c712e6923ebf9de4e7c8d8dda06509e9/LICENSE',
          'libultrahdr-1acdbed8c712e6923ebf9de4e7c8d8dda06509e9/adobe-hdr-gain-map-license/NOTICE',
        ],
      },
      {
        components: ['pango'], name: 'pango-1.58.0.tar.xz', version: '1.58.0',
        repository: 'https://gitlab.gnome.org/GNOME/pango', revision: '1.58.0',
        url: 'https://download.gnome.org/sources/pango/1.58/pango-1.58.0.tar.xz',
        sha256: 'bc5bad6213ad4886a47d1e80292fd850b64159b50db67917a43d9ea80ee2298a',
        licenseMembers: ['pango-1.58.0/COPYING'],
      },
    ]),
  ]
  const artifacts: SourceArtifactSpec[] = [
    sourceArtifact(
      windows ? 'sharp-libvips-windows-recipe-a2d035.tar.gz' : 'sharp-libvips-1.3.2-recipe.tar.gz',
      windows ? 'windows-vips-8.18.3' : SHARP_LIBVIPS_VERSION,
      'https://github.com/lovell/sharp-libvips',
      recipeCommit,
      `https://codeload.github.com/lovell/sharp-libvips/tar.gz/${recipeCommit}`,
      recipeHash,
      'Exact build recipe, versions, notices, and scripts for the distributed libvips payload.',
      relatedPackages,
      [
        `sharp-libvips-${recipeCommit}/versions.properties`,
        `sharp-libvips-${recipeCommit}/THIRD-PARTY-NOTICES.md`,
        `sharp-libvips-${recipeCommit}/build/${windows ? 'win' : 'posix'}.sh`,
      ],
    ),
    sourceArtifact(
      'sharp-0.35.3-source.tar.gz',
      '0.35.3',
      'https://github.com/lovell/sharp',
      '1018449164723ba0203c1beffaba0e21f7829c18',
      'https://codeload.github.com/lovell/sharp/tar.gz/1018449164723ba0203c1beffaba0e21f7829c18',
      'c9559a4ada7e98bfa0d6208a1f04f58ac8ddde466e6d7ae23fe9fd437e19047b',
      'Source for the distributed sharp native addon.',
      relatedPackages,
      ['sharp-1018449164723ba0203c1beffaba0e21f7829c18/LICENSE'],
    ),
    ...componentArchives.map(archive => sharpComponentSourceArtifact(archive, relatedPackages)),
  ]
  if (windows) {
    artifacts.push(
      sourceArtifact('build-win64-mxe-8.18.3.tar.gz', '8.18.3', 'https://github.com/libvips/build-win64-mxe', 'v8.18.3', 'https://codeload.github.com/libvips/build-win64-mxe/tar.gz/refs/tags/v8.18.3', '05c9f3708ce8afe820d4a401e8b270e30c8bd6270e75a6cfb97f918f2f087962', 'Windows build scripts and the exact dependency patch set.', relatedPackages, [
        'build-win64-mxe-8.18.3/build.sh',
        'build-win64-mxe-8.18.3/build/vips.mk',
        'build-win64-mxe-8.18.3/build/patches/cairo-1-fixes.patch',
        'build-win64-mxe-8.18.3/build/patches/glib-2-without-gregex.patch',
        'build-win64-mxe-8.18.3/build/patches/libheif-1-fixes.patch',
        'build-win64-mxe-8.18.3/build/patches/librsvg-2-fixes.patch',
        'build-win64-mxe-8.18.3/build/patches/libxml2-2-fixes.patch',
        'build-win64-mxe-8.18.3/build/patches/uhdr-1-fixes.patch',
        'build-win64-mxe-8.18.3/build/plugins/mozjpeg/patches/mozjpeg-4-fixes.patch',
        'build-win64-mxe-8.18.3/build/plugins/proxy-libintl/patches/proxy-libintl-1-fixes.patch',
        'build-win64-mxe-8.18.3/build/plugins/zlib-ng/patches/zlib-ng-2-fixes.patch',
      ]),
    )
  } else {
    artifacts.push(
      sourceArtifact('glib-without-gregex.patch', 'sharp-libvips-1.3.2', 'https://gist.github.com/kleisauke/284d685efa00908da99ea6afbaaf39ae', 'bdad5489a61c217850631571caf57f5db6ea8b2c', 'https://gist.github.com/kleisauke/284d685efa00908da99ea6afbaaf39ae/raw/bdad5489a61c217850631571caf57f5db6ea8b2c/glib-without-gregex.patch', 'b1f2930a11292e529de137c7eb723850e0cc0969b1a2b0358196389312acd272', 'Exact patch applied to the LGPL glib source.', relatedPackages),
      sourceArtifact('libvips-cpp-soversion.patch', 'sharp-libvips-1.3.2', 'https://gist.github.com/lovell/313a6901e9db1bf285f2a1f1180499e4', '3988223c7dfa4d22745d9392034b0117abef1446', 'https://gist.githubusercontent.com/lovell/313a6901e9db1bf285f2a1f1180499e4/raw/3988223c7dfa4d22745d9392034b0117abef1446/libvips-cpp-soversion.patch', '256b7d6f8c973bb53b20cff5171c7117d6b35d3aa4e72d22cb906f4fe1e2c890', 'Exact patch applied to the LGPL libvips source.', relatedPackages),
      sourceArtifact('mozjpeg-f90668.patch', 'sharp-libvips-1.3.2', 'https://github.com/mozilla/mozjpeg', 'f90668e0e4fb79c81e1f24a0ccc0e2090af761bf', 'https://github.com/mozilla/mozjpeg/commit/f90668e0e4fb79c81e1f24a0ccc0e2090af761bf.patch', 'a65f87cadf3a6052e44d6314c906f6e2891352f82646b8a6f0b8fcf2c1891e7c', 'Exact patch applied to the mozjpeg source.', relatedPackages),
      sourceArtifact('libultrahdr-pr383.patch', 'sharp-libvips-1.3.2', 'https://github.com/google/libultrahdr', 'pull/383', 'https://patch-diff.githubusercontent.com/raw/google/libultrahdr/pull/383.patch', 'e0106f9458626f6745a9a9a3841478b7a42f6905f67373d19f6f9b897c33ada5', 'Exact patch applied to the libultrahdr source.', relatedPackages),
    )
  }
  validateSharpComponentArtifacts(artifacts)
  return artifacts
}

/** Return the exact component set whose original terms are shipped for one target. */
export function sharpLibvipsSourceComponentNames(rustTarget: string): string[] {
  return sharpSourceArtifacts(rustTarget)
    .flatMap(artifact => artifact.components ?? [])
    .sort()
}

function ripgrepSourceArtifacts(rustTarget: string, packageName: string): SourceArtifactSpec[] {
  const relatedPackages = [`npm:${packageName}@1.18.0`]
  const crateIds = ripgrepCargoCrateIds(rustTarget)
  const artifacts = [
    sourceArtifact('ripgrep-15.0.0-source.tar.gz', RIPGREP_VERSION, 'https://github.com/BurntSushi/ripgrep', RIPGREP_COMMIT, `https://codeload.github.com/BurntSushi/ripgrep/tar.gz/${RIPGREP_COMMIT}`, RIPGREP_ARCHIVE_SHA256, 'Exact ripgrep source, Cargo.lock, root licenses, and workspace crates.', relatedPackages, [`ripgrep-${RIPGREP_COMMIT}/Cargo.lock`, `ripgrep-${RIPGREP_COMMIT}/LICENSE-MIT`, `ripgrep-${RIPGREP_COMMIT}/UNLICENSE`]),
    sourceArtifact('ripgrep-prebuilt-v15-recipe.tar.gz', RIPGREP_VERSION, 'https://github.com/microsoft/ripgrep-prebuilt', RIPGREP_PREBUILT_COMMIT, `https://codeload.github.com/microsoft/ripgrep-prebuilt/tar.gz/${RIPGREP_PREBUILT_COMMIT}`, RIPGREP_PREBUILT_ARCHIVE_SHA256, 'Exact Microsoft prebuilt recipe, version configuration, and BinSkim patch.', relatedPackages, [`ripgrep-prebuilt-${RIPGREP_PREBUILT_COMMIT}/config.json`, `ripgrep-prebuilt-${RIPGREP_PREBUILT_COMMIT}/LICENSE`]),
  ]
  for (const id of crateIds) {
    const separator = id.lastIndexOf('@')
    const name = id.slice(0, separator)
    const version = id.slice(separator + 1)
    const checksum = RIPGREP_CRATE_CHECKSUMS[id]
    if (checksum === undefined) throw new Error(`desktop licenses: ripgrep crate ${id} lacks a pinned Cargo.lock checksum.`)
    artifacts.push(sourceArtifact(
      `ripgrep-crate-${name}-${version}.crate`,
      version,
      `https://crates.io/crates/${name}`,
      checksum,
      `https://static.crates.io/crates/${name}/${name}-${version}.crate`,
      checksum,
      `Complete source and original license/notice files for the ${rustTarget} ripgrep Cargo closure.`,
      relatedPackages,
      [`${name}-${version}/Cargo.toml`],
    ))
  }
  return artifacts
}

async function packageIdentity(npmRoot: string, name: string, version: string): Promise<string> {
  const directory = join(npmRoot, 'node_modules', ...name.split('/'))
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as NpmManifest
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(`desktop licenses: expected staged ${name}@${version}, found ${String(manifest.name)}@${String(manifest.version)}.`)
  }
  return directory
}

async function targetNativeProvenance(
  npmRoot: string,
  rustTarget: string,
): Promise<{ supplementalPackages: RawPackage[]; sourceArtifacts: SourceArtifactSpec[] }> {
  const target = NATIVE_TARGET_PROVENANCE[rustTarget]
  if (target === undefined) throw new Error(`desktop licenses: unsupported native release target ${rustTarget}.`)

  const ripgrepDirectory = await packageIdentity(npmRoot, target.ripgrepPackage, '1.18.0')
  await verifyFileSha256(join(ripgrepDirectory, target.ripgrepBinary), target.ripgrepSha256, `${target.ripgrepPackage} ripgrep 15.0.0 binary`)
  const koffiDirectory = await packageIdentity(npmRoot, target.koffiPackage, KOFFI_VERSION)
  await verifyFileSha256(join(koffiDirectory, target.koffiBinary), target.koffiSha256, `${target.koffiPackage} addon`)
  for (const [relativePath, expected] of Object.entries(target.sharpFiles)) {
    await verifyFileSha256(join(npmRoot, 'node_modules', ...relativePath.split('/')), expected, relativePath)
  }
  const nodePtyDirectory = await packageIdentity(npmRoot, 'node-pty', NODE_PTY_VERSION)
  for (const [relativePath, expected] of Object.entries(target.nodePtyFiles)) {
    await verifyFileSha256(join(nodePtyDirectory, ...relativePath.split('/')), expected, `node-pty ${relativePath}`)
  }
  if (rustTarget === 'x86_64-unknown-linux-gnu') {
    for (const relativePath of ['build/Release/pty.node', 'build/Release/spawn-helper']) {
      const path = join(nodePtyDirectory, ...relativePath.split('/'))
      if (!existsSync(path) || !(await stat(path)).isFile() || (await stat(path)).size === 0) {
        throw new Error(`desktop licenses: built Linux node-pty payload is missing ${relativePath}.`)
      }
    }
  }

  const shikiDirectory = await packageIdentity(npmRoot, 'shiki', '4.3.1')
  await verifyFileSha256(join(shikiDirectory, 'dist/onig.wasm'), VSCODE_ONIGURUMA_WASM_SHA256, 'Shiki dist/onig.wasm (vscode-oniguruma 1.7.0)')
  const onigurumaFiles = await pinnedOnigurumaFiles()
  const koffiVendor = await pinnedKoffiVendorFiles()
  const tauriBase = `https://raw.githubusercontent.com/tauri-apps/tauri/${TAURI_BUNDLER_COMMIT}`
  const tauriLicenses = [
    await pinnedUpstreamText('tauri-2.11.4-LICENSE_APACHE-2.0', `${tauriBase}/LICENSE_APACHE-2.0`, '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594'),
    await pinnedUpstreamText('tauri-2.11.4-LICENSE_MIT', `${tauriBase}/LICENSE_MIT`, '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'),
  ]
  const supplementalPackages: RawPackage[] = [
    {
      ecosystem: 'runtime',
      name: 'vscode-oniguruma (embedded by shiki)',
      version: VSCODE_ONIGURUMA_VERSION,
      licenseExpression: 'MIT AND BSD-2-Clause',
      authors: ['Microsoft Corporation', 'K. Kosako'],
      repository: 'https://github.com/microsoft/vscode-oniguruma',
      packageDirectory: shikiDirectory,
      originalTextFiles: onigurumaFiles,
    },
    {
      ecosystem: 'runtime',
      name: 'node-addon-api (modified vendored copy in koffi)',
      version: '8.9.0+koffi.3.1.1',
      licenseExpression: 'MIT',
      authors: ['Node.js contributors', 'Koffi contributors'],
      repository: 'https://github.com/nodejs/node-addon-api',
      packageDirectory: koffiDirectory,
      originalTextFiles: [koffiVendor.addonApi],
    },
    {
      ecosystem: 'runtime',
      name: 'node-api-headers (vendored by koffi)',
      version: '1.8.0',
      licenseExpression: 'MIT',
      authors: ['Node.js contributors'],
      repository: 'https://github.com/nodejs/node-api-headers',
      packageDirectory: koffiDirectory,
      originalTextFiles: [koffiVendor.nodeApi],
    },
    {
      ecosystem: 'build-tool',
      name: '@tauri-apps/cli',
      version: '2.11.4',
      licenseExpression: 'Apache-2.0 OR MIT',
      authors: ['Tauri Programme within The Commons Conservancy'],
      repository: 'https://github.com/tauri-apps/tauri',
      packageDirectory: repositoryRoot,
      originalTextFiles: tauriLicenses,
    },
    {
      ecosystem: 'build-tool',
      name: 'tauri-bundler',
      version: '2.9.4',
      licenseExpression: 'Apache-2.0 OR MIT',
      authors: ['George Burton', 'Tauri Programme within The Commons Conservancy'],
      repository: 'https://github.com/tauri-apps/tauri',
      packageDirectory: repositoryRoot,
      originalTextFiles: tauriLicenses,
    },
  ]

  const sharpArtifacts = sharpSourceArtifacts(rustTarget)
  validateSharpComponentVersions(
    sharpArtifacts,
    rustTarget === 'x86_64-pc-windows-msvc' ? await windowsSharpVersions() : await posixSharpVersions(),
  )
  const sourceArtifacts = [
    ...sharpArtifacts,
    ...ripgrepSourceArtifacts(rustTarget, target.ripgrepPackage),
    sourceArtifact('vscode-oniguruma-1.7.0.tgz', VSCODE_ONIGURUMA_VERSION, 'https://github.com/microsoft/vscode-oniguruma', '716aeaa229e4ae2e3b0057377b55743e9a3e995b', `https://registry.npmjs.org/vscode-oniguruma/-/vscode-oniguruma-${VSCODE_ONIGURUMA_VERSION}.tgz`, VSCODE_ONIGURUMA_ARCHIVE_SHA256, 'Exact source, WebAssembly binary, MIT license, and Oniguruma BSD notices embedded through Shiki.', ['runtime:vscode-oniguruma (embedded by shiki)@1.7.0'], ['package/LICENSE.txt', 'package/NOTICES.txt', 'package/release/onig.wasm']),
    sourceArtifact('koffi-3.1.1-source.tgz', KOFFI_VERSION, 'https://github.com/Koromix/koffi', 'npm:koffi@3.1.1', `https://registry.npmjs.org/koffi/-/koffi-${KOFFI_VERSION}.tgz`, KOFFI_ARCHIVE_SHA256, 'Exact Koffi source including its modified node-addon-api 8.9.0 base and exact node-api-headers 1.8.0 vendored trees.', [`npm:${target.koffiPackage}@3.1.1`], ['package/vendor/node-addon-api/LICENSE.md', 'package/vendor/node-api-headers/LICENSE']),
    sourceArtifact('node-addon-api-8.9.0.tgz', '8.9.0', 'https://github.com/nodejs/node-addon-api', '13c28f6673776e4015cd8d675e92b143177bb816', 'https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.9.0.tgz', '19b87e2ce3a77fec0121ac97d7db088aae28aacfff481adab50d5f61b70e68f4', 'Upstream base source and license for Koffi vendored headers; Koffi modifications are in koffi-3.1.1-source.tgz.', ['runtime:node-addon-api (modified vendored copy in koffi)@8.9.0+koffi.3.1.1'], ['package/LICENSE.md']),
    sourceArtifact('node-api-headers-1.8.0.tgz', '1.8.0', 'https://github.com/nodejs/node-api-headers', 'd41aa272949bb5e5ef477b87d2d565fd67a03f32', 'https://registry.npmjs.org/node-api-headers/-/node-api-headers-1.8.0.tgz', '2ef102e61384ec80d519c48b2bfa54c5afbc847a9fa488e6db5c2554180b6626', 'Exact upstream source and license for Koffi vendored Node-API headers.', ['runtime:node-api-headers (vendored by koffi)@1.8.0'], ['package/LICENSE']),
    sourceArtifact('node-pty-1.1.0-source.tgz', NODE_PTY_VERSION, 'https://github.com/microsoft/node-pty', '1def5774632305246fe21f0f69e23a664d6c5910', `https://registry.npmjs.org/node-pty/-/node-pty-${NODE_PTY_VERSION}.tgz`, NODE_PTY_ARCHIVE_SHA256, 'Exact node-pty source, native prebuilds, winpty source and license, and ConPTY payload provenance.', ['npm:node-pty@1.1.0'], ['package/LICENSE', 'package/deps/winpty/LICENSE']),
    sourceArtifact('tauri-cli-2.11.4-bundler-2.9.4-source.tar.gz', 'cli-2.11.4+bundler-2.9.4', 'https://github.com/tauri-apps/tauri', TAURI_BUNDLER_COMMIT, `https://codeload.github.com/tauri-apps/tauri/tar.gz/${TAURI_BUNDLER_COMMIT}`, TAURI_SOURCE_ARCHIVE_SHA256, 'Exact source and licenses for the material Tauri CLI and bundler build tools.', ['build-tool:@tauri-apps/cli@2.11.4', 'build-tool:tauri-bundler@2.9.4'], [`tauri-${TAURI_BUNDLER_COMMIT}/crates/tauri-bundler/Cargo.toml`, `tauri-${TAURI_BUNDLER_COMMIT}/LICENSE_MIT`]),
  ]

  if (rustTarget === 'x86_64-pc-windows-msvc') {
    const nsisUrl = 'https://prdownloads.sourceforge.net/nsis/nsis-3.11-src.tar.bz2'
    const nsisCopying = await pinnedArchiveMember('nsis-3.11-source.tar.bz2', nsisUrl, '19e72062676ebdc67c11dc032ba80b979cdbffd3886c60b04bb442cdd401ff4b', 'nsis-3.11-src/COPYING', 'NSIS-3.11-COPYING', 'e7dd514003ab96cb3ddccbc028fe5c795fccf57dc41f21cfb9d4dd16ead23bf5')
    const nsisUtilsUrl = 'https://codeload.github.com/tauri-apps/nsis-tauri-utils/tar.gz/13d9edd27b69310e108d6fbd49f90992f8a05390'
    const nsisUtilsLicenses = [
      await pinnedArchiveMember('nsis-tauri-utils-0.5.3-source.tar.gz', nsisUtilsUrl, '9b277f7cdec4277b48d319c32e10b5dc4303e9efce8c3b44f1db77f86a8131c7', 'nsis-tauri-utils-13d9edd27b69310e108d6fbd49f90992f8a05390/LICENSE_APACHE-2.0', 'nsis-tauri-utils-0.5.3-LICENSE_APACHE-2.0', '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594'),
      await pinnedArchiveMember('nsis-tauri-utils-0.5.3-source.tar.gz', nsisUtilsUrl, '9b277f7cdec4277b48d319c32e10b5dc4303e9efce8c3b44f1db77f86a8131c7', 'nsis-tauri-utils-13d9edd27b69310e108d6fbd49f90992f8a05390/LICENSE_MIT', 'nsis-tauri-utils-0.5.3-LICENSE_MIT', '1c1020fa10a6bf318717e82c911bcc54ebdfb9bb280460ae332bcb2f82f57fbe'),
    ]
    const nsisUtilsLicenseDirectory = nsisUtilsLicenses[0]
    if (nsisUtilsLicenseDirectory === undefined) throw new Error('desktop licenses: nsis-tauri-utils licenses are missing.')
    supplementalPackages.push(
      {
        ecosystem: 'runtime',
        name: 'NSIS zlib installer stub',
        version: '3.11',
        licenseExpression: 'Zlib',
        authors: ['NSIS contributors'],
        repository: 'https://sourceforge.net/projects/nsis/',
        packageDirectory: dirname(nsisCopying),
        originalTextFiles: [nsisCopying],
      },
      {
        ecosystem: 'runtime',
        name: 'nsis-tauri-utils',
        version: '0.5.3',
        licenseExpression: 'Apache-2.0 OR MIT',
        authors: ['Tauri Programme within The Commons Conservancy'],
        repository: 'https://github.com/tauri-apps/nsis-tauri-utils',
        packageDirectory: dirname(nsisUtilsLicenseDirectory),
        originalTextFiles: nsisUtilsLicenses,
      },
    )
    sourceArtifacts.push(
      sourceArtifact('nsis-3.11-source.tar.bz2', '3.11', 'https://sourceforge.net/projects/nsis/', '3.11', nsisUrl, '19e72062676ebdc67c11dc032ba80b979cdbffd3886c60b04bb442cdd401ff4b', 'Source and COPYING for the zlib-compressed NSIS installer stub; LZMA/CPL code is not selected by the release configuration.', ['runtime:NSIS zlib installer stub@3.11'], ['nsis-3.11-src/COPYING']),
      sourceArtifact('nsis-tauri-utils-0.5.3-source.tar.gz', '0.5.3', 'https://github.com/tauri-apps/nsis-tauri-utils', '13d9edd27b69310e108d6fbd49f90992f8a05390', nsisUtilsUrl, '9b277f7cdec4277b48d319c32e10b5dc4303e9efce8c3b44f1db77f86a8131c7', 'Exact source and licenses for the plugin embedded in the NSIS installer.', ['runtime:nsis-tauri-utils@0.5.3'], ['nsis-tauri-utils-13d9edd27b69310e108d6fbd49f90992f8a05390/LICENSE_MIT']),
      sourceArtifact('microsoft-terminal-conpty-source.tar.gz', CONPTY_VERSION, 'https://github.com/microsoft/terminal', TERMINAL_LICENSE_COMMIT, `https://codeload.github.com/microsoft/terminal/tar.gz/${TERMINAL_LICENSE_COMMIT}`, 'b56d287f39c18ac1f23fc47e21150f2166ab52842efc3474edeb55c14c8d1aae', 'Fixed Microsoft Terminal source, MIT license, and NOTICE for the retained ConPTY binaries.', ['npm:node-pty@1.1.0'], [`terminal-${TERMINAL_LICENSE_COMMIT}/LICENSE`, `terminal-${TERMINAL_LICENSE_COMMIT}/NOTICE.md`]),
    )
  }
  return { supplementalPackages, sourceArtifacts }
}

async function verifySourceArchiveMembers(
  path: string,
  spec: Pick<SourceArtifactSpec, 'name' | 'requiredMembers'>,
): Promise<void> {
  if (spec.requiredMembers === undefined && !spec.name.endsWith('.crate')) return
  const members = await new Promise<string[]>((resolvePromise, reject) => {
    const child = spawn('tar', ['-tf', path], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 16 * 1024 * 1024) child.kill('SIGKILL')
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && stdout.length <= 16 * 1024 * 1024) {
        resolvePromise(stdout.split(/\r?\n/).filter(Boolean))
      } else {
        reject(new Error(
          `desktop licenses: could not inspect source artifact ${spec.name} `
          + `(${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}): ${stderr.trim()}`,
        ))
      }
    })
  })
  const unique = new Set<string>()
  for (const member of members) {
    if (member.startsWith('/') || member.split('/').includes('..') || unique.has(member)) {
      throw new Error(`desktop licenses: source artifact ${spec.name} has an unsafe or duplicate member ${member}.`)
    }
    unique.add(member)
  }
  for (const required of spec.requiredMembers ?? []) {
    if (!unique.has(required)) {
      throw new Error(`desktop licenses: source artifact ${spec.name} is missing required member ${required}.`)
    }
  }
  if (spec.name.endsWith('.crate') && !members.some(member => TEXT_FILE.test(basename(member)))) {
    throw new Error(`desktop licenses: ripgrep dependency source ${spec.name} has no original license/notice file.`)
  }
}

async function writeSourceArtifacts(
  output: string,
  specs: readonly SourceArtifactSpec[],
  cacheDirectory = SOURCE_ARTIFACT_DIRECTORY,
): Promise<SourceArtifactEntry[]> {
  const directory = join(output, 'source-artifacts')
  await mkdir(directory, { recursive: true })
  const entries: SourceArtifactEntry[] = []
  const names = new Set<string>()
  for (const spec of [...specs].sort((left, right) => left.name.localeCompare(right.name))) {
    if (names.has(spec.name)) throw new Error(`desktop licenses: duplicate source artifact ${spec.name}.`)
    names.add(spec.name)
    const source = await pinnedSourceArtifact(spec, cacheDirectory)
    await verifySourceArchiveMembers(source, spec)
    const bytes = await readFile(source)
    const destination = join(directory, outputSegment(spec.name))
    await writeFile(destination, bytes)
    entries.push({
      name: spec.name,
      version: spec.version,
      repository: spec.repository,
      revision: spec.revision,
      url: spec.url,
      purpose: spec.purpose,
      relatedPackages: [...spec.relatedPackages].sort(),
      ...(spec.requiredMembers === undefined ? {} : { requiredMembers: [...spec.requiredMembers].sort() }),
      ...(spec.components === undefined ? {} : { components: [...spec.components].sort() }),
      ...(spec.licenseMembers === undefined ? {} : { licenseMembers: [...spec.licenseMembers].sort() }),
      path: relative(output, destination).split(sep).join('/'),
      sha256: sha256(bytes),
      size: bytes.length,
    })
  }
  return entries
}

/** Generate one target-specific desktop license directory from resolved inputs. */
export async function generateDesktopLicenseBundle(options: GenerateOptions): Promise<LicenseManifestEntry[]> {
  const output = resolve(options.output)
  if (output === repositoryRoot || repositoryRoot.startsWith(output + sep)) {
    throw new Error(`desktop licenses: refusing to clear unsafe output ${output}`)
  }
  const npm = await collectNpm(resolve(options.npmRoot), options.rustTarget)
  const cargo = await collectCargo(options.cargoMetadata)
  const packages = [...npm, ...cargo, ...(options.supplementalPackages ?? [])].sort(comparePackage)
  const seen = new Map<string, RawPackage>()
  for (const row of packages) {
    const id = packageId(row)
    const previous = seen.get(id)
    if (previous !== undefined) {
      if (previous.licenseExpression !== row.licenseExpression) {
        throw new Error(`desktop licenses: duplicate ${id} disagrees on its license expression.`)
      }
      continue
    }
    seen.set(id, row)
  }
  const unique = [...seen.values()].sort(comparePackage)
  const donors = canonicalDonors(unique)
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  const entries: LicenseManifestEntry[] = []
  for (const row of unique) {
    entries.push(await writePackage(
      output,
      row,
      textSourcesForPackage(row, unique, donors, resolve(options.projectLicense)),
    ))
  }
  const sourceArtifacts = await writeSourceArtifacts(
    output,
    options.sourceArtifacts ?? [],
    options.sourceArtifactCache,
  )
  const manifest = {
    schemaVersion: 2,
    rustTarget: options.rustTarget,
    cargoLockSha256: sha256(await readFile(options.cargoLock)),
    packageCount: entries.length,
    npmPackageCount: entries.filter(row => row.ecosystem === 'npm').length,
    cargoPackageCount: entries.filter(row => row.ecosystem === 'cargo').length,
    runtimePackageCount: entries.filter(row => row.ecosystem === 'runtime').length,
    buildToolPackageCount: entries.filter(row => row.ecosystem === 'build-tool').length,
    sourceArtifactCount: sourceArtifacts.length,
    sourceArtifacts,
    packages: entries,
  }
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(output, 'README.md'), [
    '# Desktop third-party licenses',
    '',
    `This target-specific directory records ${String(entries.length)} shipped packages and material build tools.`,
    'Each package directory contains its metadata and the original or explicitly identified donor license/notice text.',
    '`manifest.json` records package versions, SPDX expressions, attribution, source provenance, and hashes.',
    '`SHA256SUMS.txt` covers every other file in this directory.',
    '',
    `Rust target: \`${options.rustTarget}\``,
    '',
  ].join('\n'))
  const inventory = []
  for (const path of await allFiles(output)) {
    const relativePath = relative(output, path).split(sep).join('/')
    inventory.push(`${sha256(await readFile(path))}  ${relativePath}`)
  }
  await writeFile(join(output, 'SHA256SUMS.txt'), `${inventory.join('\n')}\n`)
  await verifyDesktopLicenseBundle(output)
  return entries
}

async function localNodeLicense(nodeVersion: string, rustTarget: string): Promise<string> {
  const platformArch = rustTarget.includes('apple-darwin')
    ? `darwin-${rustTarget.startsWith('aarch64') ? 'arm64' : 'x64'}`
    : rustTarget.includes('windows')
      ? `win-${rustTarget.startsWith('aarch64') ? 'arm64' : 'x64'}`
      : `linux-${rustTarget.startsWith('aarch64') ? 'arm64' : 'x64'}`
  const extracted = resolve(homedir(), `.pkg-cache/sea/node-${nodeVersion}-${platformArch}/LICENSE`)
  if (existsSync(extracted)) return extracted
  const tarball = resolve(homedir(), `.pkg-cache/sea/node-${nodeVersion}-${platformArch}.tar.gz`)
  const zip = resolve(homedir(), `.pkg-cache/sea/node-${nodeVersion}-${platformArch}.zip`)
  const archive = existsSync(tarball) ? tarball : zip
  if (!existsSync(archive) || !existsSync(`${archive}.ok`)) {
    throw new Error(`desktop licenses: Node ${nodeVersion} source license is absent from the verified pkg cache: ${tarball} or ${zip}`)
  }
  const outputDirectory = resolve(repositoryRoot, '.artifacts/desktop-licenses/node-source')
  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
  const member = `node-${nodeVersion}-${platformArch}/LICENSE`
  await new Promise<void>((resolvePromise, reject) => {
    const command = archive.endsWith('.zip') ? '7z' : 'tar'
    const args = archive.endsWith('.zip')
      ? ['x', '-y', `-o${outputDirectory}`, archive, member]
      : ['-xzf', archive, '-C', outputDirectory, member]
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop licenses: could not extract Node license (${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}).`))
    })
  })
  return join(outputDirectory, member)
}

/** Resolve the one concrete, verified Node archive matching an exact SEA target version. */
export async function cachedNodeVersion(
  rustTarget: string,
  expectedVersion = '24.19.0',
  cache = resolve(homedir(), '.pkg-cache/sea'),
): Promise<string> {
  const platformArch = rustTarget.includes('apple-darwin')
    ? `darwin-${rustTarget.startsWith('aarch64') ? 'arm64' : 'x64'}`
    : rustTarget.includes('windows')
      ? `win-${rustTarget.startsWith('aarch64') ? 'arm64' : 'x64'}`
      : `linux-${rustTarget.startsWith('aarch64') ? 'arm64' : 'x64'}`
  const pattern = new RegExp(`^node-(v${expectedVersion.replaceAll('.', '\\.').replaceAll('-', '\\-')})-${platformArch.replaceAll('-', '\\-')}\\.(?:tar\\.gz|zip)$`)
  const cacheEntries = await readdir(cache).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') return []
    throw error
  })
  const versions = cacheEntries
    .flatMap((name) => {
      const match = pattern.exec(name)
      return match?.[1] !== undefined && existsSync(join(cache, `${name}.ok`)) ? [match[1]] : []
    })
  if (versions.length !== 1 || versions[0] === undefined) {
    throw new Error(`desktop licenses: expected one verified Node ${expectedVersion} SEA archive for ${platformArch}; build the exact sidecar target first.`)
  }
  return versions[0]
}

async function supplementalPackages(rustTarget: string): Promise<RawPackage[]> {
  const pkgDirectory = await realpath(resolve(repositoryRoot, 'node_modules/@yao-pkg/pkg'))
  const pkgManifest = JSON.parse(await readFile(join(pkgDirectory, 'package.json'), 'utf8')) as NpmManifest
  if (typeof pkgManifest.version !== 'string' || pkgManifest.version === '') {
    throw new Error('desktop licenses: installed @yao-pkg/pkg has no version.')
  }
  const nodeVersion = await cachedNodeVersion(rustTarget)
  const pkgLicense = join(pkgDirectory, 'LICENSE')
  const nodeLicense = await localNodeLicense(nodeVersion, rustTarget)
  const bootstrapSource = await readFile(join(pkgDirectory, 'prelude/sea-bootstrap.bundle.js'), 'utf8')
  const bootstrapPackages: RawPackage[] = []
  const pkgDependencyRoot = resolve(pkgDirectory, '..', '..')
  for (const name of reviewedPkgBootstrapPackages(bootstrapSource)) {
    if (!isRecord(pkgManifest.dependencies) || typeof pkgManifest.dependencies[name] !== 'string') {
      throw new Error(`desktop licenses: pkg bootstrap dependency ${name} is not declared by @yao-pkg/pkg.`)
    }
    const packageDirectory = await realpath(resolve(pkgDependencyRoot, ...name.split('/')))
    const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as NpmManifest
    const expectedVersion = REVIEWED_PKG_BOOTSTRAP_PACKAGES.get(name)
    if (expectedVersion === undefined || manifest.name !== name
      || typeof manifest.version !== 'string' || manifest.version !== expectedVersion) {
      throw new Error(
        `desktop licenses: reviewed pkg bootstrap package ${name}@${String(expectedVersion)} `
        + `resolved as ${String(manifest.name)}@${String(manifest.version)}.`,
      )
    }
    if (typeof manifest.license !== 'string' || manifest.license.trim() === '') {
      throw new Error(`desktop licenses: pkg bootstrap package ${name}@${expectedVersion} has no SPDX license.`)
    }
    licenseIdentifiers(manifest.license)
    const repository = manifestRepository(manifest)
    bootstrapPackages.push({
      ecosystem: 'build-tool',
      name,
      version: manifest.version,
      licenseExpression: normalizeExpression(manifest.license),
      authors: manifestAuthors(manifest),
      ...repository === undefined ? {} : { repository },
      packageDirectory,
      originalTextFiles: await directTextFiles(packageDirectory),
    })
  }
  const pkgRepository = manifestRepository(pkgManifest)
  return [
    {
      ecosystem: 'build-tool',
      name: '@yao-pkg/pkg',
      version: pkgManifest.version,
      licenseExpression: 'MIT',
      authors: manifestAuthors(pkgManifest),
      ...pkgRepository === undefined ? {} : { repository: pkgRepository },
      packageDirectory: pkgDirectory,
      originalTextFiles: [pkgLicense],
    },
    {
      ecosystem: 'runtime',
      name: 'node',
      version: nodeVersion.slice(1),
      licenseExpression: 'MIT',
      authors: ['Node.js contributors'],
      repository: 'https://github.com/nodejs/node',
      packageDirectory: dirname(nodeLicense),
      originalTextFiles: [nodeLicense],
    },
    ...bootstrapPackages,
  ]
}

/** Verify hashes, package counts, and reviewed license expressions in an extracted bundle. */
export async function verifyDesktopLicenseBundle(directory: string): Promise<void> {
  const root = resolve(directory)
  const checksumPath = join(root, 'SHA256SUMS.txt')
  const lines = (await readFile(checksumPath, 'utf8')).trim().split('\n').filter(Boolean)
  const expectedPaths = new Set<string>()
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined || match[2].startsWith('/') || match[2].includes('..')) {
      throw new Error(`desktop licenses: invalid checksum line ${JSON.stringify(line)}`)
    }
    const path = resolve(root, match[2])
    if (!path.startsWith(root + sep)) throw new Error(`desktop licenses: checksum path escapes bundle: ${match[2]}`)
    if (sha256(await readFile(path)) !== match[1]) throw new Error(`desktop licenses: checksum mismatch for ${match[2]}`)
    expectedPaths.add(match[2])
  }
  const actualPaths = (await allFiles(root))
    .map(path => relative(root, path).split(sep).join('/'))
    .filter(path => path !== 'SHA256SUMS.txt')
  const unexpected = actualPaths.filter(path => !expectedPaths.has(path))
  if (unexpected.length > 0 || expectedPaths.size !== actualPaths.length) {
    throw new Error(`desktop licenses: checksum inventory is incomplete: ${unexpected.join(', ')}`)
  }
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    schemaVersion?: unknown
    packageCount?: unknown
    packages?: LicenseManifestEntry[]
    sourceArtifactCount?: unknown
    sourceArtifacts?: SourceArtifactEntry[]
    rustTarget?: unknown
  }
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.packages)
    || manifest.packageCount !== manifest.packages.length || manifest.packages.length === 0
    || !Array.isArray(manifest.sourceArtifacts)
    || manifest.sourceArtifactCount !== manifest.sourceArtifacts.length
    || typeof manifest.rustTarget !== 'string' || manifest.rustTarget === '') {
    throw new Error('desktop licenses: invalid or empty manifest.')
  }
  const packageIds = new Set<string>()
  const metadataPaths = new Set(actualPaths.filter(path => path.endsWith('/METADATA.json')))
  for (const row of manifest.packages) {
    const id = `${row.ecosystem}:${row.name}@${row.version}`
    if (packageIds.has(id)) throw new Error(`desktop licenses: duplicate manifest package ${id}.`)
    packageIds.add(id)
    licenseIdentifiers(row.licenseExpression)
    if (!Array.isArray(row.files) || row.files.length === 0) {
      throw new Error(`desktop licenses: ${id} has no license text.`)
    }
    const metadataPath = `packages/${row.ecosystem}/${outputSegment(row.name)}/${outputSegment(row.version)}/METADATA.json`
    if (!metadataPaths.delete(metadataPath)) throw new Error(`desktop licenses: ${id} has no unique METADATA.json.`)
    const metadata = JSON.parse(await readFile(join(root, metadataPath), 'utf8')) as LicenseManifestEntry
    if (JSON.stringify(metadata) !== JSON.stringify(row)) {
      throw new Error(`desktop licenses: ${id} metadata disagrees with manifest.json.`)
    }
    for (const file of row.files) {
      const path = resolve(root, file.path)
      if (!path.startsWith(root + sep) || !expectedPaths.has(file.path)) {
        throw new Error(`desktop licenses: ${id} references an untracked license file ${file.path}.`)
      }
      if (sha256(await readFile(path)) !== file.sha256) {
        throw new Error(`desktop licenses: manifest hash mismatch for ${file.path}`)
      }
    }
  }
  if (metadataPaths.size > 0) {
    throw new Error(`desktop licenses: unreferenced package metadata: ${[...metadataPaths].sort().join(', ')}`)
  }
  const artifactNames = new Set<string>()
  const sharpComponentOwners = new Map<string, string>()
  for (const artifact of manifest.sourceArtifacts) {
    if (artifactNames.has(artifact.name)) throw new Error(`desktop licenses: duplicate source artifact ${artifact.name}.`)
    artifactNames.add(artifact.name)
    if (artifact.path !== `source-artifacts/${outputSegment(artifact.name)}`
      || !expectedPaths.has(artifact.path) || sha256(await readFile(join(root, artifact.path))) !== artifact.sha256
      || artifact.sha256.length !== 64 || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
      || typeof artifact.url !== 'string' || artifact.url === '' || typeof artifact.revision !== 'string'
      || artifact.revision === '' || !Array.isArray(artifact.relatedPackages)) {
      throw new Error(`desktop licenses: invalid source artifact ${artifact.name}.`)
    }
    if (artifact.requiredMembers !== undefined
      && (!Array.isArray(artifact.requiredMembers) || artifact.requiredMembers.length === 0
        || artifact.requiredMembers.some(member => typeof member !== 'string' || member === ''))) {
      throw new Error(`desktop licenses: invalid required members for ${artifact.name}.`)
    }
    if (artifact.components !== undefined || artifact.licenseMembers !== undefined) {
      if (!Array.isArray(artifact.components) || artifact.components.length === 0
        || artifact.components.some(component => typeof component !== 'string' || component === '')
        || new Set(artifact.components).size !== artifact.components.length
        || !Array.isArray(artifact.licenseMembers) || artifact.licenseMembers.length === 0
        || artifact.licenseMembers.some(member => typeof member !== 'string' || member === '')
        || artifact.requiredMembers === undefined
        || artifact.licenseMembers.some(member => !artifact.requiredMembers?.includes(member))) {
        throw new Error(`desktop licenses: invalid sharp component provenance in ${artifact.name}.`)
      }
      for (const component of artifact.components) {
        const previous = sharpComponentOwners.get(component)
        if (previous !== undefined) {
          throw new Error(`desktop licenses: sharp component ${component} is repeated by ${previous} and ${artifact.name}.`)
        }
        sharpComponentOwners.set(component, artifact.name)
      }
    }
    await verifySourceArchiveMembers(join(root, artifact.path), artifact)
  }
  if (NATIVE_TARGET_PROVENANCE[manifest.rustTarget] !== undefined) {
    const actual = [...sharpComponentOwners.keys()].sort()
    const expected = [...SHARP_LIBVIPS_NOTICE_COMPONENTS].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `desktop licenses: extracted bundle does not contain original terms for all ${String(expected.length)} sharp components.`,
      )
    }
  }
}

async function cargoMetadata(rustTarget: string, cargoManifest: string): Promise<CargoMetadata> {
  const args = [
    'metadata',
    '--locked',
    '--format-version',
    '1',
    '--filter-platform',
    rustTarget,
    '--manifest-path',
    cargoManifest,
  ]
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn('cargo', args, { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise(output)
      else reject(new Error(`desktop licenses: cargo metadata failed (${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}).`))
    })
  })
  return JSON.parse(stdout) as CargoMetadata
}

/** Generate the standard desktop bundle for one native Rust target. */
export async function generateDesktopLicensesForTarget(rustTarget: string): Promise<LicenseManifestEntry[]> {
  const native = await targetNativeProvenance(DEFAULT_NPM_STAGING, rustTarget)
  return await generateDesktopLicenseBundle({
    npmRoot: DEFAULT_NPM_STAGING,
    cargoMetadata: await cargoMetadata(rustTarget, DEFAULT_CARGO_MANIFEST),
    cargoLock: DEFAULT_CARGO_LOCK,
    projectLicense: DEFAULT_PROJECT_LICENSE,
    output: DESKTOP_LICENSE_BUNDLE,
    rustTarget,
    supplementalPackages: [...await supplementalPackages(rustTarget), ...native.supplementalPackages],
    sourceArtifacts: native.sourceArtifacts,
  })
}

async function main(): Promise<void> {
  const values = parseArgs({
    args: process.argv.slice(2),
    options: {
      verify: { type: 'string' },
      'rust-target': { type: 'string' },
    },
  }).values
  if (values.verify !== undefined) {
    await verifyDesktopLicenseBundle(values.verify)
    console.log(`desktop licenses: verified ${resolve(values.verify)}`)
    return
  }
  if (values['rust-target'] === undefined) {
    throw new Error('Usage: tsx scripts/gen-desktop-third-party-licenses.ts --rust-target <Rust triple> | --verify <directory>')
  }
  const entries = await generateDesktopLicensesForTarget(values['rust-target'])
  console.log(`desktop licenses: generated ${String(entries.length)} package records in ${DESKTOP_LICENSE_BUNDLE}`)
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) await main()
