/**
 * Build the native-host DeepSeek Harness sidecar consumed by Tauri. The
 * deployed production closure is compiled into one Node SEA executable so the
 * desktop application does not require a system Node.js installation.
 */

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { generateDesktopLicensesForTarget } from './gen-desktop-third-party-licenses.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

const root = resolve(import.meta.dirname, '..')
const STAGING = resolve(root, '.artifacts/desktop-sidecar/node')
const BINARIES = resolve(root, 'src-tauri/binaries')
const WORKSPACE_MODULES = resolve(root, 'node_modules/.pnpm/node_modules')
const WORKSPACE_STATE = resolve(root, 'node_modules/.pnpm-workspace-state-v1.json')
const ROOT_NODE_PTY_RELEASE = resolve(
  root,
  'packages/subprocess/subprocess-local/node_modules/node-pty/build/Release',
)
const DEPLOY_PACKAGE = '@deepseek-ai/dsh'
const ENTRY_BIN = 'lib/bin.js'
const SIDECAR_READY_TIMEOUT_MS = 45_000
const SIDECAR_AGENT_SMOKE_TIMEOUT_MS = 30_000
const SIDECAR_SMOKE_SESSION_ID = 'desktop-sidecar-default-preset-smoke'
const SIDECAR_SMOKE_REQUEST_MAX_BYTES = 16 * 1024 * 1024
const SIDECAR_SEARCH_SMOKE_FILE = 'sidecar-ripgrep-smoke.txt'
const SIDECAR_SEARCH_SMOKE_MARKER = 'SEA_RIPGREP_EXECUTION_CONFIRMED'
const SIDECAR_GLOB_CALL_ID = 'desktop-sidecar-glob-smoke'
const SIDECAR_GREP_CALL_ID = 'desktop-sidecar-grep-smoke'
const BADGE_BODY_MARKERS = [
  '# dsh Badge',
  'Preserve the badge\'s 121×20 dimensions',
] as const
const CLAUDE_RESTRICTED_PACKAGE = /^@anthropic-ai\/claude-agent-sdk(?:$|-(?:darwin|linux|win32)(?:-|$))/
const CLAUDE_EXECUTABLES = new Set(['claude', 'claude.exe'])
const REQUIRED_CLIENT_PACKAGES = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-layout',
] as const
const ISOLATED_BUILD_PREFIX = 'dsh-desktop-sea-build-'
const PKG_CLI = resolve(root, 'node_modules/@yao-pkg/pkg/lib-es5/bin.js')

const PORTABLE_ASSET_GLOBS = [
  'package.json',
  'config/**/*',
  'lib/**/*.js',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.wasm',
  'node_modules/**/*.yml',
  'node_modules/**/*.yaml',
  'node_modules/@deepseek-ai/dsh-skill-badge/assets/**/*',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/**/*',
]

export interface HostTarget {
  readonly platform: 'darwin' | 'linux' | 'win32'
  readonly architecture: 'arm64' | 'x64'
  readonly pkgTarget: string
  readonly rustTriple: string
  readonly nodePtyPlatform: string
  readonly executableSuffix: string
}

interface Cli {
  readonly skipBuild: boolean
  readonly dryRun: boolean
}

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>
  readonly [key: string]: unknown
}

export interface StagedNpmPackageVersion {
  readonly name: string
  readonly version: string
}

export interface NpmAdvisory {
  readonly id: string | number
  readonly url: string
  readonly title: string
  readonly severity: 'low' | 'moderate' | 'high' | 'critical'
  readonly vulnerable_versions: string
}

export interface StagedNpmAuditResult {
  readonly packageCount: number
  readonly advisoryCount: number
  readonly blockingAdvisories: readonly NpmAdvisory[]
}

interface AgentPresetRosterSmoke {
  readonly count: number
  readonly defaultPresetId: string
}

export interface SmokeLlmServer {
  readonly baseUrl: string
  readonly badgeRequest: Promise<unknown>
  readonly searchCompleted: Promise<void>
  close(): Promise<void>
}

export interface RipgrepAsset {
  readonly packageName: string
  readonly binaryName: 'rg' | 'rg.exe'
  readonly relativePath: string
  readonly vfsPath: string
}

export interface ArtifactIsolationContext {
  readonly repositoryRoot: string
  readonly userHome: string
  readonly isolationRoots: readonly string[]
  readonly githubWorkspace?: string
}

export interface ArtifactMarker {
  readonly label: string
  readonly value: string
}

export interface PeCertificateTable {
  readonly fileOffset: number
  readonly size: number
}

interface PeCertificateTableLocation extends PeCertificateTable {
  readonly directoryOffset?: number
}

function usage(): string {
  return [
    'Usage: pnpm run build:desktop-sidecar [flags]',
    '',
    '  --skip-build  skip `pnpm run build` (lib/ and apps/web/dist must already exist).',
    '  --dry-run     print commands and filesystem changes without executing them.',
    '  --help        print this help.',
    '',
    'The sidecar is built for the current native host only.',
  ].join('\n')
}

export function parseSidecarCli(argv: string[]): Cli {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let values: ReturnType<typeof parseArgs>['values']
  try {
    values = parseArgs({
      args,
      options: {
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`)
  }
  if (values.help) {
    console.log(usage())
    process.exit(0)
  }
  return {
    skipBuild: values['skip-build'] === true,
    dryRun: values['dry-run'] === true,
  }
}

/**
 * Resolve one native desktop sidecar target without accepting a cross-target override.
 * @param platform Operating system reported by the Node.js host.
 * @param architecture CPU architecture reported by the Node.js host.
 * @returns The matching pkg, Rust, and node-pty target names.
 */
export function resolveHostTarget(platform: NodeJS.Platform, architecture: string): HostTarget {
  if (platform === 'darwin' && architecture === 'arm64') {
    return {
      platform,
      architecture,
      pkgTarget: 'node24.19.0-macos-arm64',
      rustTriple: 'aarch64-apple-darwin',
      nodePtyPlatform: 'darwin-arm64',
      executableSuffix: '',
    }
  }
  if (platform === 'win32' && architecture === 'x64') {
    return {
      platform,
      architecture,
      pkgTarget: 'node24.19.0-win-x64',
      rustTriple: 'x86_64-pc-windows-msvc',
      nodePtyPlatform: 'win32-x64',
      executableSuffix: '.exe',
    }
  }
  if (platform === 'linux' && architecture === 'x64') {
    return {
      platform,
      architecture,
      pkgTarget: 'node24.19.0-linux-x64',
      rustTriple: 'x86_64-unknown-linux-gnu',
      nodePtyPlatform: 'linux-x64',
      executableSuffix: '',
    }
  }
  throw new Error(
    `unsupported desktop build host ${platform}/${architecture}; supported native hosts are darwin/arm64, win32/x64, and linux/x64.`,
  )
}

/** Resolve the one platform package and executable that @vscode/ripgrep may load for a target. */
export function ripgrepAssetForTarget(target: HostTarget): RipgrepAsset {
  const packageName = `@vscode/ripgrep-${target.platform}-${target.architecture}`
  const binaryName = target.platform === 'win32' ? 'rg.exe' : 'rg'
  const relativePath = `node_modules/${packageName}/bin/${binaryName}`
  return {
    packageName,
    binaryName,
    relativePath,
    vfsPath: `/app/${relativePath}`,
  }
}

export interface HostNativeLayout {
  readonly ripgrep: RipgrepAsset
  readonly sharpPackage: string
  readonly sharpLibvipsPackage?: string
  readonly koffiPackage: string
  readonly addonRequireBuiltinPackage: string
  readonly nodePtyNativeDirectory: string
}

/** Resolve every target-labelled native package directory admitted into one SEA closure. */
export function hostNativeLayout(target: HostTarget): HostNativeLayout {
  const platformArch = `${target.platform}-${target.architecture}`
  const addonSuffix = target.platform === 'linux'
    ? `${platformArch}-gnu`
    : target.platform === 'win32'
      ? `${platformArch}-msvc`
      : platformArch
  return {
    ripgrep: ripgrepAssetForTarget(target),
    sharpPackage: `@img/sharp-${platformArch}`,
    ...target.platform === 'win32'
      ? {}
      : { sharpLibvipsPackage: `@img/sharp-libvips-${platformArch}` },
    koffiPackage: `@koromix/koffi-${platformArch}`,
    addonRequireBuiltinPackage: `node-addon-require-builtin-${addonSuffix}`,
    nodePtyNativeDirectory: target.platform === 'linux'
      ? 'node_modules/node-pty/build/Release'
      : `node_modules/node-pty/prebuilds/${platformArch}`,
  }
}

/** Explicit pkg globs for the one target-native closure; no architecture-wide wildcard is permitted. */
export function nativeAssetGlobsForTarget(target: HostTarget): string[] {
  const layout = hostNativeLayout(target)
  return [
    layout.ripgrep.relativePath,
    `node_modules/${layout.sharpPackage}/**/*`,
    ...(layout.sharpLibvipsPackage === undefined
      ? []
      : [`node_modules/${layout.sharpLibvipsPackage}/**/*`]),
    `node_modules/${layout.koffiPackage}/**/*`,
    `node_modules/${layout.addonRequireBuiltinPackage}/**/*`,
    `${layout.nodePtyNativeDirectory}/**/*`,
  ]
}

function byteView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Read the architecture from one little-endian 64-bit Linux ELF image.
 * @param bytes Complete ELF file contents.
 * @returns The desktop architecture encoded in the ELF header.
 */
export function readLinuxElfArchitecture(bytes: Uint8Array): 'arm64' | 'x64' {
  if (bytes.byteLength < 20
    || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new Error('file is not an ELF image')
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    throw new Error('ELF image is not 64-bit little-endian')
  }
  const machine = byteView(bytes).getUint16(18, true)
  if (machine === 0x3e) return 'x64'
  if (machine === 0xb7) return 'arm64'
  throw new Error(`ELF image uses unsupported machine 0x${machine.toString(16)}`)
}

function requireByteRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || offset > bytes.byteLength - length) {
    throw new Error(`PE image has a truncated ${label}`)
  }
}

function locatePeCertificateTable(bytes: Uint8Array): PeCertificateTableLocation {
  requireByteRange(bytes, 0, 0x40, 'DOS header')
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('file is not a PE image')
  const view = byteView(bytes)
  const peOffset = view.getUint32(0x3c, true)
  requireByteRange(bytes, peOffset, 24, 'COFF header')
  if (view.getUint32(peOffset, true) !== 0x0000_4550) throw new Error('file has no PE signature')

  const optionalHeaderSize = view.getUint16(peOffset + 20, true)
  const optionalHeader = peOffset + 24
  requireByteRange(bytes, optionalHeader, optionalHeaderSize, 'optional header')
  if (optionalHeaderSize < 2) throw new Error('PE image has a truncated optional header')
  const magic = view.getUint16(optionalHeader, true)
  const numberOfDirectoriesOffset = magic === 0x20b
    ? 108
    : magic === 0x10b
      ? 92
      : undefined
  if (numberOfDirectoriesOffset === undefined) {
    throw new Error(`PE image has unsupported optional-header magic 0x${magic.toString(16)}`)
  }
  if (numberOfDirectoriesOffset + 4 > optionalHeaderSize) {
    throw new Error('PE image has a truncated data-directory count')
  }
  requireByteRange(bytes, optionalHeader + numberOfDirectoriesOffset, 4, 'data-directory count')
  if (view.getUint32(optionalHeader + numberOfDirectoriesOffset, true) <= 4) {
    return { fileOffset: 0, size: 0 }
  }

  const dataDirectories = optionalHeader + numberOfDirectoriesOffset + 4
  const certificateEntry = dataDirectories + 4 * 8
  if (certificateEntry + 8 > optionalHeader + optionalHeaderSize) {
    throw new Error('PE optional header does not contain its declared certificate-table entry')
  }
  requireByteRange(bytes, certificateEntry, 8, 'certificate-table entry')
  const fileOffset = view.getUint32(certificateEntry, true)
  const size = view.getUint32(certificateEntry + 4, true)
  if ((fileOffset === 0) !== (size === 0)) {
    throw new Error('PE image has a malformed certificate-table entry')
  }
  if (size !== 0) requireByteRange(bytes, fileOffset, size, 'certificate table')
  return { fileOffset, size, directoryOffset: certificateEntry }
}

/**
 * Read the Authenticode certificate-table entry from a PE image.
 * The certificate table is data-directory entry 4 and uses file offsets rather than RVAs.
 * @param bytes Complete PE file contents.
 * @returns The certificate table location; both values are zero when the image is unsigned.
 */
export function readPeCertificateTable(bytes: Uint8Array): PeCertificateTable {
  const { fileOffset, size } = locatePeCertificateTable(bytes)
  return { fileOffset, size }
}

/**
 * Clear the PE Security Directory without removing certificate bytes or a later SEA overlay.
 * @param bytes Complete PE file contents.
 * @returns A same-length copy whose certificate-table entry is empty.
 */
export function clearPeSecurityDirectory(bytes: Uint8Array): Uint8Array {
  const { directoryOffset } = locatePeCertificateTable(bytes)
  const unsigned = Uint8Array.from(bytes)
  if (directoryOffset !== undefined) unsigned.fill(0, directoryOffset, directoryOffset + 8)
  const certificateTable = readPeCertificateTable(unsigned)
  if (unsigned.byteLength !== bytes.byteLength
    || certificateTable.fileOffset !== 0 || certificateTable.size !== 0) {
    throw new Error('failed to clear the PE Security Directory without changing the image length')
  }
  return unsigned
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

function pathMarkerVariants(path: string): string[] {
  const forward = path.replaceAll('\\', '/')
  const backward = path.replaceAll('/', '\\')
  const variants = new Set([path, forward, backward])
  if (path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)) {
    try {
      variants.add(pathToFileURL(resolve(path)).href)
    } catch {
      // The slash variants still cover platform-native absolute paths.
    }
  }
  return [...variants].filter(value => value !== '')
}

const HOSTED_RUNNER_WORKSPACE_MARKERS = [
  '/home/runner/work/',
  '/Users/runner/work/',
  '/github/workspace/',
  'C:\\Users\\runneradmin\\',
  'C:\\a\\',
  'D:\\a\\',
] as const

function normalizedHostPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function isKnownHostedRunnerHome(path: string, githubWorkspace: string | undefined): boolean {
  if (githubWorkspace === undefined) return false
  const normalized = normalizedHostPath(path)
  const knownHome = normalized === '/home/runner'
    || normalized === '/users/runner'
    || normalized === 'c:/users/runneradmin'
  const normalizedWorkspace = `${normalizedHostPath(githubWorkspace)}/`
  return knownHome && HOSTED_RUNNER_WORKSPACE_MARKERS.some((prefix) => {
    return normalizedWorkspace.startsWith(normalizedHostPath(prefix) + '/')
  })
}

/** Build the path and package markers that may never occur in a distributable SEA image. */
export function sidecarArtifactForbiddenMarkers(context: ArtifactIsolationContext): ArtifactMarker[] {
  const markers: ArtifactMarker[] = []
  const addPath = (label: string, path: string | undefined): void => {
    if (path === undefined || path === '') return
    for (const value of pathMarkerVariants(path)) markers.push({ label, value })
  }
  addPath('repository root', context.repositoryRoot)
  addPath(
    isKnownHostedRunnerHome(context.userHome, context.githubWorkspace) ? 'hosted-runner home' : 'user home',
    context.userHome,
  )
  for (const isolationRoot of context.isolationRoots) addPath('isolated build root', isolationRoot)
  addPath('GITHUB_WORKSPACE', context.githubWorkspace)
  for (const value of HOSTED_RUNNER_WORKSPACE_MARKERS) {
    markers.push({ label: 'hosted-runner workspace', value })
  }
  for (const value of ['/var/folders/', '/private/var/folders/']) {
    markers.push({ label: 'host temporary directory', value })
  }
  for (const value of [
    '/node_modules/.pnpm/tsx@',
    '/node_modules/.pnpm/esbuild@',
    '/node_modules/tsx/',
    '/node_modules/esbuild/',
    '\\node_modules\\.pnpm\\tsx@',
    '\\node_modules\\.pnpm\\esbuild@',
    '\\node_modules\\tsx\\',
    '\\node_modules\\esbuild\\',
  ]) {
    markers.push({ label: 'undeclared build-tool asset', value })
  }
  const seen = new Set<string>()
  return markers.filter((marker) => {
    const key = `${marker.label}\0${marker.value.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const VFS_ONLY_ARTIFACT_MARKER_LABELS = new Set([
  'hosted-runner home',
  'hosted-runner workspace',
  'undeclared build-tool asset',
])

/** Keep compiler/debug-path false positives out of whole-binary scans while retaining VFS rejection. */
export function wholeArtifactSidecarForbiddenMarkers(
  markers: readonly ArtifactMarker[],
): ArtifactMarker[] {
  return markers.filter(marker => !VFS_ONLY_ARTIFACT_MARKER_LABELS.has(marker.label))
}

interface EncodedArtifactMarker extends ArtifactMarker {
  readonly bytes: string
}

function encodedArtifactMarkers(markers: readonly ArtifactMarker[]): EncodedArtifactMarker[] {
  return markers.flatMap(marker => [
    {
      ...marker,
      bytes: Buffer.from(marker.value, 'utf8').toString('latin1').toLowerCase(),
    },
    {
      ...marker,
      bytes: Buffer.from(marker.value, 'utf16le').toString('latin1').toLowerCase(),
    },
  ]).filter(marker => marker.bytes.length > 0)
}

/** Stream an artifact and report forbidden ASCII/UTF-16 strings, including chunk-boundary matches. */
export async function findForbiddenSidecarArtifactMarkers(
  executable: string,
  markers: readonly ArtifactMarker[],
): Promise<ArtifactMarker[]> {
  const encoded = encodedArtifactMarkers(markers)
  if (encoded.length === 0) return []
  const maximumLength = Math.max(...encoded.map(marker => marker.bytes.length))
  const found = new Map<string, ArtifactMarker>()
  let tail = ''
  for await (const rawChunk of createReadStream(executable, { highWaterMark: 64 * 1024 })) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    const window = `${tail}${chunk.toString('latin1')}`
    const searchable = window.toLowerCase()
    for (const marker of encoded) {
      if (!searchable.includes(marker.bytes)) continue
      const key = `${marker.label}\0${marker.value.toLowerCase()}`
      found.set(key, { label: marker.label, value: marker.value })
    }
    tail = window.slice(Math.max(0, window.length - maximumLength + 1))
  }
  return [...found.values()].sort((left, right) => (
    left.label.localeCompare(right.label) || left.value.localeCompare(right.value)
  ))
}

const PKG_VFS_PREFIX = Buffer.from('{"entrypoint":"/snapshot/', 'utf8')

/** Extract and validate @yao-pkg/pkg's one JSON VFS index from a compiled SEA image. */
export function extractPkgVfsManifest(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const start = buffer.indexOf(PKG_VFS_PREFIX)
  if (start === -1) throw new Error('compiled SEA contains no pkg VFS manifest.')
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let index = start; index < buffer.length; index += 1) {
    const byte = buffer[index]
    if (byte === undefined) break
    if (inString) {
      if (escaped) escaped = false
      else if (byte === 0x5c) escaped = true
      else if (byte === 0x22) inString = false
      continue
    }
    if (byte === 0x22) {
      inString = true
      continue
    }
    if (byte === 0x7b || byte === 0x5b) depth += 1
    else if (byte === 0x7d || byte === 0x5d) {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  if (end === -1 || inString || depth !== 0) throw new Error('compiled SEA has a truncated pkg VFS manifest.')
  if (buffer.indexOf(PKG_VFS_PREFIX, end) !== -1) throw new Error('compiled SEA contains multiple pkg VFS manifests.')
  const json = buffer.subarray(start, end).toString('utf8')
  const manifest = JSON.parse(json) as unknown
  if (!isRecord(manifest) || typeof manifest.entrypoint !== 'string'
    || !manifest.entrypoint.startsWith('/snapshot/')
    || typeof manifest.entryIsESM !== 'boolean'
    || !isRecord(manifest.directories) || !isRecord(manifest.stats)
    || !isRecord(manifest.symlinks) || !isRecord(manifest.offsets)) {
    throw new Error('compiled SEA contains an invalid pkg VFS manifest.')
  }
  return json
}

function requireVfsFile(
  manifest: Record<string, unknown>,
  path: string,
  label: string,
): void {
  const stats = manifest.stats
  const offsets = manifest.offsets
  if (!isRecord(stats) || !isRecord(offsets)) {
    throw new Error('compiled SEA contains an invalid pkg VFS manifest.')
  }
  const metadata = stats[path]
  const offset = offsets[path]
  if (!isRecord(metadata) || metadata.isFile !== true
    || typeof metadata.size !== 'number' || !Number.isSafeInteger(metadata.size) || metadata.size <= 0
    || !Array.isArray(offset) || offset.length !== 2
    || !offset.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
    throw new Error(`compiled SEA VFS is missing the complete ${label}: ${path}`)
  }
}

function requireNativeVfsFile(
  manifest: Record<string, unknown>,
  packageName: string,
  label: string,
  accepts: (path: string) => boolean,
): void {
  const stats = manifest.stats
  if (!isRecord(stats)) throw new Error('compiled SEA contains an invalid pkg VFS manifest.')
  const prefix = `/app/node_modules/${packageName}/`
  const candidate = Object.keys(stats).find(path => path.startsWith(prefix) && accepts(path))
  if (candidate === undefined) {
    throw new Error(`compiled SEA VFS is missing ${label} below ${prefix}`)
  }
  requireVfsFile(manifest, candidate, label)
}

/**
 * Fail closed unless one SEA VFS carries exactly the target-native closure.
 * Generic loader source may mention other targets; only material VFS paths are inspected here.
 */
export function verifyHostNativeVfsManifest(vfsManifest: string, target: HostTarget): void {
  const parsed = JSON.parse(vfsManifest) as unknown
  if (!isRecord(parsed) || typeof parsed.entrypoint !== 'string'
    || !parsed.entrypoint.startsWith('/snapshot/') || typeof parsed.entryIsESM !== 'boolean'
    || !isRecord(parsed.directories) || !isRecord(parsed.stats)
    || !isRecord(parsed.symlinks) || !isRecord(parsed.offsets)) {
    throw new Error('compiled SEA contains an invalid pkg VFS manifest.')
  }
  const layout = hostNativeLayout(target)
  const keys = new Set([
    ...Object.keys(parsed.directories),
    ...Object.keys(parsed.stats),
    ...Object.keys(parsed.symlinks),
    ...Object.keys(parsed.offsets),
  ])
  const allowedImg = new Set([
    layout.sharpPackage.slice('@img/'.length),
    ...(layout.sharpLibvipsPackage === undefined
      ? []
      : [layout.sharpLibvipsPackage.slice('@img/'.length)]),
  ])
  const violations = new Set<string>()
  for (const path of keys) {
    const vscode = path.match(/^\/app\/node_modules\/@vscode\/(ripgrep-[^/]+)/)?.[1]
    if (vscode !== undefined && `@vscode/${vscode}` !== layout.ripgrep.packageName) violations.add(path)
    const img = path.match(/^\/app\/node_modules\/@img\/(sharp-[^/]+)/)?.[1]
    if (img !== undefined && !allowedImg.has(img)) violations.add(path)
    const koffi = path.match(/^\/app\/node_modules\/@koromix\/(koffi-[^/]+)/)?.[1]
    if (koffi !== undefined && `@koromix/${koffi}` !== layout.koffiPackage) violations.add(path)
    const addon = path.match(/^\/app\/node_modules\/(node-addon-require-builtin-[^/]+)/)?.[1]
    if (addon !== undefined && addon !== layout.addonRequireBuiltinPackage) violations.add(path)

    const nodePtyPrebuild = path.match(/^\/app\/node_modules\/node-pty\/prebuilds\/([^/]+)/)?.[1]
    const allowedPrebuild = target.platform === 'linux' ? undefined : target.nodePtyPlatform
    if (nodePtyPrebuild !== undefined && nodePtyPrebuild !== allowedPrebuild) violations.add(path)
    if (path.startsWith('/app/node_modules/node-pty/third_party/')) violations.add(path)
    if (path.startsWith('/app/node_modules/node-pty/build/Debug/')) violations.add(path)
    if (target.platform !== 'linux' && path.startsWith('/app/node_modules/node-pty/build/Release/')) {
      violations.add(path)
    }
  }
  if (violations.size > 0) {
    throw new Error(
      `compiled SEA VFS contains non-target native payloads for ${target.platform}/${target.architecture}:\n`
      + [...violations].sort().map(path => `  ${path}`).join('\n'),
    )
  }

  requireVfsFile(parsed, layout.ripgrep.vfsPath, 'target ripgrep executable')
  requireNativeVfsFile(parsed, layout.sharpPackage, 'target sharp addon', path => path.endsWith('.node'))
  if (layout.sharpLibvipsPackage !== undefined) {
    requireNativeVfsFile(
      parsed,
      layout.sharpLibvipsPackage,
      'target sharp libvips library',
      path => path.includes('.dylib') || path.includes('.so'),
    )
  }
  requireNativeVfsFile(parsed, layout.koffiPackage, 'target koffi addon', path => path.endsWith('.node'))
  requireNativeVfsFile(
    parsed,
    layout.addonRequireBuiltinPackage,
    'target node-addon-require-builtin addon',
    path => path.endsWith('.node'),
  )
  const nodePtyAddon = `/app/${layout.nodePtyNativeDirectory}/pty.node`
  requireVfsFile(parsed, nodePtyAddon, 'target node-pty addon')
  if (target.platform !== 'win32') {
    requireVfsFile(
      parsed,
      `/app/${layout.nodePtyNativeDirectory}/spawn-helper`,
      'target node-pty spawn helper',
    )
  }
  requireVfsFile(parsed, '/app/node_modules/shiki/dist/onig.wasm', 'shiki Oniguruma wasm runtime')
}

function findForbiddenTextMarkers(text: string, markers: readonly ArtifactMarker[]): ArtifactMarker[] {
  const searchable = text.toLowerCase()
  return markers.filter(marker => searchable.includes(marker.value.toLowerCase()))
}

/** Return the first ancestor node_modules directory that could extend pkg's input graph. */
export function findAncestorNodeModules(directory: string): string | undefined {
  let ancestor = dirname(resolve(directory))
  while (true) {
    const candidate = join(ancestor, 'node_modules')
    if (existsSync(candidate)) return candidate
    const parent = dirname(ancestor)
    if (parent === ancestor) return undefined
    ancestor = parent
  }
}

/** Select a stable, non-user-specific temporary directory for pkg's generated SEA bootstrap. */
export function neutralPkgTempDirectory(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  if (platform !== 'win32') return '/tmp'
  return win32.join(environmentValue(environment, 'SystemRoot') ?? 'C:\\Windows', 'Temp')
}

function containedPackagePath(directory: string, dependency: string): string {
  const root = resolve(directory)
  const candidate = resolve(root, dependency)
  if (candidate === root || !candidate.startsWith(root + sep)) {
    throw new Error(`invalid dependency name ${JSON.stringify(dependency)}: resolved outside ${root}.`)
  }
  return candidate
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function packageName(directory: string): Promise<string | undefined> {
  const manifestPath = join(directory, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot inspect staged package manifest ${manifestPath}: ${String(error)}`)
  }
  return isRecord(manifest) && typeof manifest.name === 'string' ? manifest.name : undefined
}

async function pruneClaudePayloadDirectory(
  directory: string,
  rootDirectory: string,
  removed: string[],
): Promise<void> {
  if (directory !== rootDirectory && CLAUDE_RESTRICTED_PACKAGE.test(await packageName(directory) ?? '')) {
    await rm(directory, { recursive: true, force: true })
    removed.push(directory)
    return
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const scopedRestrictedPackage = basename(directory) === '@anthropic-ai'
      && CLAUDE_RESTRICTED_PACKAGE.test(`@anthropic-ai/${entry.name}`)
    if (scopedRestrictedPackage) {
      await rm(path, { recursive: true, force: true })
      removed.push(path)
      continue
    }
    if (entry.isDirectory()) await pruneClaudePayloadDirectory(path, rootDirectory, removed)
  }
}

/**
 * Remove Anthropic SDK and platform packages whose upstream distribution authorization is identity-scoped.
 * @param directory Staging root whose package closure may contain restricted Anthropic packages.
 * @returns Removed package directories in sorted order.
 */
export async function pruneRestrictedClaudePackages(directory: string): Promise<string[]> {
  const rootDirectory = resolve(directory)
  const removed: string[] = []
  await pruneClaudePayloadDirectory(rootDirectory, rootDirectory, removed)
  return removed.sort()
}

async function scanClaudePayloadDirectory(directory: string, violations: Set<string>): Promise<void> {
  const name = await packageName(directory)
  if (basename(dirname(directory)) === '@anthropic-ai'
    && CLAUDE_RESTRICTED_PACKAGE.test(`@anthropic-ai/${basename(directory)}`)) {
    violations.add(directory)
  }
  if (name !== undefined && CLAUDE_RESTRICTED_PACKAGE.test(name)) {
    violations.add(`${join(directory, 'package.json')} (${name})`)
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (basename(directory) === '@anthropic-ai'
      && CLAUDE_RESTRICTED_PACKAGE.test(`@anthropic-ai/${entry.name}`)) {
      violations.add(path)
    }
    if (entry.isDirectory()) {
      await scanClaudePayloadDirectory(path, violations)
      continue
    }
    if ((entry.isFile() || entry.isSymbolicLink()) && CLAUDE_EXECUTABLES.has(entry.name.toLowerCase())) {
      violations.add(path)
    }
  }
}

/**
 * Find forbidden Anthropic SDK/platform packages and Claude executables in staged SEA assets.
 * @param directory Staging root to inspect recursively.
 * @returns Sorted paths that make the desktop payload non-redistributable.
 */
export async function findRestrictedClaudePayloads(directory: string): Promise<string[]> {
  const violations = new Set<string>()
  await scanClaudePayloadDirectory(resolve(directory), violations)
  return [...violations].sort()
}

async function run(
  label: string,
  command: string,
  args: string[],
  dryRun: boolean,
  cwd = root,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const printable = formatCommand(command, args)
  if (dryRun) {
    console.log(`build-desktop-sidecar: [dry-run] ${printable}`)
    return
  }
  console.log(`build-desktop-sidecar: ${label}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: { ...environment, CI: 'true' },
    })
    child.once('error', (error) => {
      reject(new Error(`${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`${label} failed (${cause}): ${printable}`))
    })
  })
}

async function runPnpm(label: string, args: string[], dryRun: boolean): Promise<void> {
  const invocation = pnpmInvocation(args)
  await run(label, invocation.command, invocation.args, dryRun)
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const match = Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return match?.[1]
}

function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

async function prepareLinuxNodePty(cli: Cli, target: HostTarget): Promise<void> {
  if (process.platform !== 'linux') return
  const expectedArchitecture = target.nodePtyPlatform === 'linux-x64'
    ? 'x64'
    : target.nodePtyPlatform === 'linux-arm64'
      ? 'arm64'
      : undefined
  if (expectedArchitecture === undefined || expectedArchitecture !== process.arch) {
    throw new Error(
      `Linux node-pty target ${target.nodePtyPlatform} does not match host ${process.platform}/${process.arch}.`,
    )
  }

  const destinationRelease = join(STAGING, 'node_modules/node-pty/build/Release')
  const artifacts = ['pty.node', 'spawn-helper'] as const
  if (cli.dryRun) {
    for (const artifact of artifacts) {
      console.log(
        `build-desktop-sidecar: [dry-run] copy ${join(ROOT_NODE_PTY_RELEASE, artifact)} `
        + `to ${join(destinationRelease, artifact)} and chmod 0755`,
      )
    }
    return
  }

  await rm(destinationRelease, { recursive: true, force: true })
  await mkdir(destinationRelease, { recursive: true })
  for (const artifact of artifacts) {
    const source = join(ROOT_NODE_PTY_RELEASE, artifact)
    if (!regularFile(source)) throw new Error(`host-built Linux node-pty artifact is missing: ${source}`)
    const sourceArchitecture = readLinuxElfArchitecture(await readFile(source))
    if (sourceArchitecture !== expectedArchitecture) {
      throw new Error(
        `host-built Linux node-pty artifact ${source} is ${sourceArchitecture}, expected ${expectedArchitecture}.`,
      )
    }
    const destination = join(destinationRelease, artifact)
    await copyFile(source, destination)
    await chmod(destination, 0o755)
    const stagedArchitecture = readLinuxElfArchitecture(await readFile(destination))
    if (stagedArchitecture !== expectedArchitecture) {
      throw new Error(`staged Linux node-pty artifact ${destination} is not ${expectedArchitecture}.`)
    }
  }
}

function stagedPath(rootDirectory: string, relativePath: string): string {
  return join(rootDirectory, ...relativePath.split('/'))
}

async function removeNativePackageSiblings(
  rootDirectory: string,
  scope: string,
  prefix: string,
  allowedNames: ReadonlySet<string>,
  removed: string[],
): Promise<void> {
  const directory = stagedPath(rootDirectory, `node_modules/${scope}`)
  if (!existsSync(directory)) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const packageName = scope === '' ? entry.name : `${scope}/${entry.name}`
    if (allowedNames.has(packageName)) continue
    const path = join(directory, entry.name)
    await rm(path, { recursive: true, force: true })
    removed.push(path)
  }
}

async function removeFilesBySuffix(directory: string, suffix: string, removed: string[]): Promise<void> {
  if (!existsSync(directory)) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await removeFilesBySuffix(path, suffix, removed)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
      await rm(path, { force: true })
      removed.push(path)
    }
  }
}

async function findNestedFile(directory: string, accepts: (path: string) => boolean): Promise<string | undefined> {
  if (!existsSync(directory)) return undefined
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && accepts(path)) return path
    if (entry.isDirectory()) {
      const nested = await findNestedFile(path, accepts)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function verifyNativePackageManifest(
  rootDirectory: string,
  packageName: string,
  target: HostTarget,
): Promise<string> {
  const directory = containedPackagePath(join(rootDirectory, 'node_modules'), packageName)
  const manifestPath = join(directory, 'package.json')
  if (!regularFile(manifestPath)) throw new Error(`target native package is missing: ${packageName}`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  if (!isRecord(manifest) || manifest.name !== packageName
    || typeof manifest.version !== 'string' || manifest.version === ''
    || !Array.isArray(manifest.os) || manifest.os.length !== 1 || manifest.os[0] !== target.platform
    || !Array.isArray(manifest.cpu) || manifest.cpu.length !== 1 || manifest.cpu[0] !== target.architecture
    || (target.platform === 'linux' && Array.isArray(manifest.libc) && !manifest.libc.includes('glibc'))) {
    throw new Error(
      `target native package ${packageName} does not declare exactly ${target.platform}/${target.architecture}`,
    )
  }
  return directory
}

/** Validate the already-pruned staging tree before pkg can traverse it. */
export async function verifyHostNativeStaging(rootDirectory: string, target: HostTarget): Promise<void> {
  const layout = hostNativeLayout(target)
  const ripgrepDirectory = await verifyNativePackageManifest(rootDirectory, layout.ripgrep.packageName, target)
  const ripgrepBinary = stagedPath(rootDirectory, layout.ripgrep.relativePath)
  const ripgrepMetadata = await lstat(ripgrepBinary).catch(() => undefined)
  if (ripgrepMetadata === undefined || !ripgrepMetadata.isFile() || ripgrepMetadata.size <= 0) {
    throw new Error(`target ripgrep executable is missing: ${ripgrepBinary}`)
  }
  // Windows does not expose portable Unix execute bits. Release builds always
  // validate a native target on its matching host, while cross-target unit
  // fixtures may validate Darwin/Linux layouts from a Windows runner.
  if (target.platform !== 'win32' && process.platform !== 'win32' && (ripgrepMetadata.mode & 0o111) === 0) {
    throw new Error(`target ripgrep executable is not executable: ${ripgrepBinary}`)
  }
  const ripgrepBinEntries = await readdir(join(ripgrepDirectory, 'bin'), { withFileTypes: true })
  if (ripgrepBinEntries.length !== 1 || !ripgrepBinEntries[0]?.isFile()
    || ripgrepBinEntries[0].name !== layout.ripgrep.binaryName) {
    throw new Error(
      `target ripgrep package must contain exactly bin/${layout.ripgrep.binaryName}: ${layout.ripgrep.packageName}`,
    )
  }

  const sharpDirectory = await verifyNativePackageManifest(rootDirectory, layout.sharpPackage, target)
  if (await findNestedFile(sharpDirectory, path => path.endsWith('.node')) === undefined) {
    throw new Error(`target sharp package has no native addon: ${layout.sharpPackage}`)
  }
  if (layout.sharpLibvipsPackage !== undefined) {
    const libvipsDirectory = await verifyNativePackageManifest(rootDirectory, layout.sharpLibvipsPackage, target)
    if (await findNestedFile(
      libvipsDirectory,
      path => path.includes('.dylib') || path.includes('.so'),
    ) === undefined) {
      throw new Error(`target sharp libvips package has no shared library: ${layout.sharpLibvipsPackage}`)
    }
  }
  const koffiDirectory = await verifyNativePackageManifest(rootDirectory, layout.koffiPackage, target)
  if (await findNestedFile(koffiDirectory, path => path.endsWith('.node')) === undefined) {
    throw new Error(`target koffi package has no native addon: ${layout.koffiPackage}`)
  }
  const addonDirectory = await verifyNativePackageManifest(
    rootDirectory,
    layout.addonRequireBuiltinPackage,
    target,
  )
  if (await findNestedFile(addonDirectory, path => path.endsWith('.node')) === undefined) {
    throw new Error(`target node-addon-require-builtin package has no native addon: ${layout.addonRequireBuiltinPackage}`)
  }

  const nodePtyDirectory = stagedPath(rootDirectory, layout.nodePtyNativeDirectory)
  if (!regularFile(join(nodePtyDirectory, 'pty.node'))) {
    throw new Error(`target node-pty addon is missing below ${nodePtyDirectory}`)
  }
  if (target.platform !== 'win32' && !regularFile(join(nodePtyDirectory, 'spawn-helper'))) {
    throw new Error(`target node-pty spawn helper is missing below ${nodePtyDirectory}`)
  }

  // Re-enumerate each native package family. This catches a future deploy that
  // starts installing an additional architecture after the prune rules run.
  const allowedPackages = new Map<string, ReadonlySet<string>>([
    ['@vscode\0ripgrep-', new Set([layout.ripgrep.packageName])],
    ['@img\0sharp-', new Set([
      layout.sharpPackage,
      ...(layout.sharpLibvipsPackage === undefined ? [] : [layout.sharpLibvipsPackage]),
    ])],
    ['@koromix\0koffi-', new Set([layout.koffiPackage])],
    ['\0node-addon-require-builtin-', new Set([layout.addonRequireBuiltinPackage])],
  ])
  for (const [key, allowed] of allowedPackages) {
    const [scope = '', prefix = ''] = key.split('\0')
    const directory = stagedPath(rootDirectory, `node_modules/${scope}`)
    if (!existsSync(directory)) continue
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
      const packageName = scope === '' ? entry.name : `${scope}/${entry.name}`
      if (!allowed.has(packageName)) throw new Error(`non-target native package survived staging prune: ${packageName}`)
    }
  }
  if (existsSync(stagedPath(rootDirectory, 'node_modules/node-pty/third_party'))) {
    throw new Error('node-pty third_party payload survived staging prune')
  }
  const shikiWasm = stagedPath(rootDirectory, 'node_modules/shiki/dist/onig.wasm')
  const shikiWasmMetadata = await lstat(shikiWasm).catch(() => undefined)
  if (shikiWasmMetadata === undefined || !shikiWasmMetadata.isFile() || shikiWasmMetadata.size <= 0) {
    throw new Error(`shiki Oniguruma wasm runtime is missing: ${shikiWasm}`)
  }
}

/** Runtime bridge that materializes the SEA-only rg asset into a real executable cache path. */
export function ripgrepSeaEntrypointSource(target: HostTarget): string {
  const asset = ripgrepAssetForTarget(target)
  return `// Generated by build-desktop-sidecar.ts; @vscode/ripgrep remains MIT licensed.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const expectedPlatform = ${JSON.stringify(target.platform)};
const expectedArchitecture = ${JSON.stringify(target.architecture)};
const platformPackage = ${JSON.stringify(asset.packageName)};
const binaryName = ${JSON.stringify(asset.binaryName)};

if (process.platform !== expectedPlatform || process.arch !== expectedArchitecture) {
  throw new Error('Packaged ripgrep target ' + expectedPlatform + '/' + expectedArchitecture
    + ' cannot run on ' + process.platform + '/' + process.arch + '.');
}

const snapshotPath = require.resolve(platformPackage + '/bin/' + binaryName);

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validCachedFile(path, expectedDigest) {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && digest(readFileSync(path)) === expectedDigest;
  } catch {
    return false;
  }
}

function materializeRipgrep() {
  const bytes = readFileSync(snapshotPath);
  const expectedDigest = digest(bytes);
  const cacheRoot = process.env.PKG_NATIVE_CACHE_PATH || join(homedir(), '.cache');
  const directory = join(cacheRoot, 'pkg', 'ripgrep', expectedDigest);
  const destination = join(directory, binaryName);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!validCachedFile(destination, expectedDigest)) {
    rmSync(destination, { force: true });
    const temporary = destination + '.' + process.pid + '.' + Date.now() + '.tmp';
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o755 });
      renameSync(temporary, destination);
    } catch (error) {
      if (!validCachedFile(destination, expectedDigest)) throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  if (process.platform !== 'win32') chmodSync(destination, 0o755);
  return destination;
}

export const rgPath = process.pkg === undefined ? snapshotPath : materializeRipgrep();
`
}

async function installStagedRipgrepBridge(rootDirectory: string, target: HostTarget): Promise<void> {
  const entrypoint = stagedPath(rootDirectory, 'node_modules/@vscode/ripgrep/lib/index.js')
  const upstream = await readFile(entrypoint, 'utf8')
  if (!upstream.includes('export const rgPath = resolved;')
    || !upstream.includes('`@vscode/ripgrep-${process.platform}-${arch}`')) {
    throw new Error('unsupported @vscode/ripgrep entrypoint; refusing to install the SEA extraction bridge')
  }
  await writeFile(entrypoint, ripgrepSeaEntrypointSource(target))
}

/** Remove every known native sibling except the exact host target before pkg and license scanning. */
export async function pruneHostNativePayloads(rootDirectory: string, target: HostTarget): Promise<string[]> {
  const layout = hostNativeLayout(target)
  const removed: string[] = []
  await removeNativePackageSiblings(
    rootDirectory,
    '@vscode',
    'ripgrep-',
    new Set([layout.ripgrep.packageName]),
    removed,
  )
  await removeNativePackageSiblings(
    rootDirectory,
    '@img',
    'sharp-',
    new Set([
      layout.sharpPackage,
      ...(layout.sharpLibvipsPackage === undefined ? [] : [layout.sharpLibvipsPackage]),
    ]),
    removed,
  )
  await removeNativePackageSiblings(
    rootDirectory,
    '@koromix',
    'koffi-',
    new Set([layout.koffiPackage]),
    removed,
  )
  await removeNativePackageSiblings(
    rootDirectory,
    '',
    'node-addon-require-builtin-',
    new Set([layout.addonRequireBuiltinPackage]),
    removed,
  )

  const nodePty = stagedPath(rootDirectory, 'node_modules/node-pty')
  const prebuilds = join(nodePty, 'prebuilds')
  if (existsSync(prebuilds)) {
    if (target.platform === 'linux') {
      await rm(prebuilds, { recursive: true, force: true })
      removed.push(prebuilds)
    } else {
      for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === target.nodePtyPlatform) continue
        const path = join(prebuilds, entry.name)
        await rm(path, { recursive: true, force: true })
        removed.push(path)
      }
    }
  }
  const build = join(nodePty, 'build')
  if (existsSync(build)) {
    if (target.platform !== 'linux') {
      await rm(build, { recursive: true, force: true })
      removed.push(build)
    } else {
      for (const entry of await readdir(build, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'Release') continue
        const path = join(build, entry.name)
        await rm(path, { recursive: true, force: true })
        removed.push(path)
      }
    }
  }
  const thirdParty = join(nodePty, 'third_party')
  if (existsSync(thirdParty)) {
    await rm(thirdParty, { recursive: true, force: true })
    removed.push(thirdParty)
  }
  await removeFilesBySuffix(nodePty, '.pdb', removed)
  await installStagedRipgrepBridge(rootDirectory, target)
  await verifyHostNativeStaging(rootDirectory, target)
  const rootPrefix = `${resolve(rootDirectory)}${sep}`
  return removed.map(path => resolve(path).startsWith(rootPrefix)
    ? resolve(path).slice(rootPrefix.length).split(sep).join('/')
    : resolve(path)).sort()
}

async function prepareHostNativePayloads(cli: Cli, target: HostTarget): Promise<void> {
  if (cli.dryRun) {
    const layout = hostNativeLayout(target)
    console.log(
      `build-desktop-sidecar: [dry-run] retain only ${target.platform}/${target.architecture} native payloads; `
      + `embed and materialize ${layout.ripgrep.relativePath}`,
    )
    return
  }
  const removed = await pruneHostNativePayloads(STAGING, target)
  console.log(
    `build-desktop-sidecar: removed ${String(removed.length)} non-target native payload(s); `
    + `verified ${target.platform}/${target.architecture} staging closure`,
  )
}

async function removeWindowsSignature(cli: Cli, executable: string): Promise<void> {
  if (process.platform !== 'win32') return
  if (cli.dryRun) {
    console.log(`build-desktop-sidecar: [dry-run] clear the 8-byte PE Security Directory in ${executable}`)
    console.log(`build-desktop-sidecar: [dry-run] verify ${executable} has an empty PE certificate table`)
    return
  }
  const signed = await readFile(executable)
  const unsigned = clearPeSecurityDirectory(signed)
  await writeFile(executable, unsigned)
  const persisted = await readFile(executable)
  if (persisted.byteLength !== signed.byteLength || !persisted.equals(unsigned)) {
    throw new Error(
      `clearing the PE Security Directory did not preserve ${executable} byte-for-byte `
      + `outside its 8-byte directory entry (${String(signed.byteLength)} input bytes, `
      + `${String(persisted.byteLength)} output bytes).`,
    )
  }
  const certificateTable = readPeCertificateTable(persisted)
  if (certificateTable.fileOffset !== 0 || certificateTable.size !== 0) {
    throw new Error(
      `clearing the PE Security Directory left a certificate table in ${executable} `
      + `(offset ${String(certificateTable.fileOffset)}, size ${String(certificateTable.size)}).`,
    )
  }
  console.log(`build-desktop-sidecar: cleared the PE Security Directory without changing image length: ${executable}`)
}

async function removeBinDirectories(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name === '.bin') {
      await rm(path, { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) await removeBinDirectories(path)
  }
}

async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

const DEPLOY_METADATA_PATHS = [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'node_modules/.package-map.json',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm',
  'node_modules/.pnpm-workspace-state-v1.json',
] as const

async function removeDeployMetadata(directory: string): Promise<void> {
  for (const relativePath of DEPLOY_METADATA_PATHS) {
    await rm(join(directory, ...relativePath.split('/')), { recursive: true, force: true })
  }
  const remaining = DEPLOY_METADATA_PATHS
    .map(relativePath => join(directory, ...relativePath.split('/')))
    .filter(existsSync)
  if (remaining.length > 0) {
    throw new Error(`staged production closure still contains pnpm deploy metadata: ${remaining.join(', ')}`)
  }
}

function validateNpmPackageVersion(row: StagedNpmPackageVersion): void {
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(row.name)) {
    throw new Error(`staged npm audit found an invalid package name: ${JSON.stringify(row.name)}`)
  }
  if (row.version === '' || row.version.length > 128 || /[\s\0]/.test(row.version)) {
    throw new Error(`staged npm audit found an invalid version for ${row.name}: ${JSON.stringify(row.version)}`)
  }
}

/** Collect the exact physical npm package name/version set below a deployed staging root. */
export async function collectStagedNpmPackageVersions(directory: string): Promise<StagedNpmPackageVersion[]> {
  const rootDirectory = resolve(directory)
  const packageIds = new Map<string, StagedNpmPackageVersion>()
  const visitedNodeModules = new Set<string>()

  const addPackage = async (packageDirectory: string): Promise<void> => {
    const manifestPath = join(packageDirectory, 'package.json')
    if (!existsSync(manifestPath)) return
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`staged npm audit found incomplete package identity: ${manifestPath}`)
    }
    const row = { name: manifest.name, version: manifest.version }
    validateNpmPackageVersion(row)
    packageIds.set(`${row.name}\0${row.version}`, row)
    await visitNodeModules(join(packageDirectory, 'node_modules'))
  }

  const visitNodeModules = async (nodeModules: string): Promise<void> => {
    if (!existsSync(nodeModules)) return
    const metadata = await lstat(nodeModules)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`staged npm audit requires a physical node_modules directory: ${nodeModules}`)
    }
    const canonical = await realpath(nodeModules)
    if (visitedNodeModules.has(canonical)) return
    visitedNodeModules.add(canonical)
    for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
      if (entry.name === '.bin') continue
      const candidate = join(nodeModules, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`staged npm audit found a symbolic-link package entry: ${candidate}`)
      }
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('@')) {
        for (const child of await readdir(candidate, { withFileTypes: true })) {
          const packageDirectory = join(candidate, child.name)
          if (child.isSymbolicLink()) {
            throw new Error(`staged npm audit found a symbolic-link package entry: ${packageDirectory}`)
          }
          if (child.isDirectory()) await addPackage(packageDirectory)
        }
      } else {
        await addPackage(candidate)
      }
    }
  }

  await addPackage(rootDirectory)
  return [...packageIds.values()].sort((left, right) => (
    `${left.name}\0${left.version}`.localeCompare(`${right.name}\0${right.version}`)
  ))
}

function npmAdvisory(value: unknown, packageName: string): NpmAdvisory {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`staged npm audit received a malformed advisory for ${packageName}`)
  }
  const row = value as Record<string, unknown>
  const validId = typeof row.id === 'string' || (typeof row.id === 'number' && Number.isSafeInteger(row.id))
  const validSeverity = row.severity === 'low' || row.severity === 'moderate'
    || row.severity === 'high' || row.severity === 'critical'
  if (!validId || typeof row.url !== 'string' || row.url === ''
    || typeof row.title !== 'string' || row.title === '' || !validSeverity
    || typeof row.vulnerable_versions !== 'string' || row.vulnerable_versions === '') {
    throw new Error(`staged npm audit received an incomplete advisory for ${packageName}`)
  }
  return {
    id: row.id as string | number,
    url: row.url,
    title: row.title,
    severity: row.severity as NpmAdvisory['severity'],
    vulnerable_versions: row.vulnerable_versions,
  }
}

/** Query npm's bulk advisory service for an already-collected physical package set. */
export async function auditStagedNpmPackageVersions(
  packages: readonly StagedNpmPackageVersion[],
  request: typeof fetch = fetch,
): Promise<StagedNpmAuditResult> {
  if (packages.length === 0) throw new Error('staged npm audit package set is empty')
  const versionsByName = new Map<string, Set<string>>()
  const packageIds = new Set<string>()
  for (const row of packages) {
    validateNpmPackageVersion(row)
    const id = `${row.name}\0${row.version}`
    if (packageIds.has(id)) {
      throw new Error(`staged npm audit input repeats ${row.name}@${row.version}`)
    }
    packageIds.add(id)
    const versions = versionsByName.get(row.name) ?? new Set<string>()
    versions.add(row.version)
    versionsByName.set(row.name, versions)
  }
  const payload = Object.fromEntries([...versionsByName]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, versions]) => [name, [...versions].sort()]))

  let response: Response
  try {
    response = await request('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new Error(`staged npm audit request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new Error(`staged npm audit request failed: HTTP ${String(response.status)}`)
  }
  const contentType = response.headers.get('content-type')
  if (contentType !== null && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new Error(`staged npm audit response is not JSON: ${JSON.stringify(contentType)}`)
  }
  const body = await response.text()
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
    throw new Error('staged npm audit response exceeds 16 MiB')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('staged npm audit response contains invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('staged npm audit response is not an advisory object')
  }

  const advisories: NpmAdvisory[] = []
  for (const [packageName, value] of Object.entries(parsed)) {
    if (!versionsByName.has(packageName) || !Array.isArray(value)) {
      throw new Error(`staged npm audit response contains an unexpected package or value: ${packageName}`)
    }
    const advisoryIds = new Set<string>()
    for (const raw of value) {
      const advisory = npmAdvisory(raw, packageName)
      const id = String(advisory.id)
      if (advisoryIds.has(id)) {
        throw new Error(`staged npm audit response repeats advisory ${id} for ${packageName}`)
      }
      advisoryIds.add(id)
      advisories.push(advisory)
    }
  }
  const blockingAdvisories = advisories.filter(row => row.severity === 'high' || row.severity === 'critical')
  if (blockingAdvisories.length > 0) {
    throw new Error(
      'staged npm audit found high/critical advisories:\n'
      + blockingAdvisories.map(row => `  ${String(row.id)} [${row.severity}] ${row.title} (${row.url})`).join('\n'),
    )
  }
  return {
    packageCount: packageIds.size,
    advisoryCount: advisories.length,
    blockingAdvisories,
  }
}

async function auditStagedNpmPackages(cli: Cli): Promise<void> {
  if (cli.dryRun) {
    console.log(
      'build-desktop-sidecar: [dry-run] collect the physical staged npm name/version set; '
      + 'POST it to npm bulk advisories; reject malformed responses and high/critical advisories',
    )
    return
  }
  const packages = await collectStagedNpmPackageVersions(STAGING)
  const result = await auditStagedNpmPackageVersions(packages)
  console.log(
    `build-desktop-sidecar: audited ${String(result.packageCount)} staged npm package versions; `
    + `${String(result.advisoryCount)} non-blocking advisories`,
  )
}

async function deploy(cli: Cli): Promise<void> {
  if (STAGING === root || root.startsWith(STAGING + sep)) {
    throw new Error(`refusing to clear staging directory ${STAGING}: it contains the repository root.`)
  }
  if (cli.dryRun) console.log(`build-desktop-sidecar: [dry-run] clear ${STAGING}`)
  else await rm(STAGING, { recursive: true, force: true })
  // pnpm deploy records its production-only settings in the repository's
  // workspace state even though it writes packages into STAGING. Preserve the
  // existing state so later `pnpm run` commands do not attempt to reinstall
  // the root workspace as production-only.
  const workspaceState = !cli.dryRun && existsSync(WORKSPACE_STATE)
    ? await readFile(WORKSPACE_STATE)
    : undefined
  try {
    await runPnpm('deploy', [
      '--ignore-scripts',
      '--filter',
      DEPLOY_PACKAGE,
      'deploy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.inject-workspace-packages=true',
      '--config.link-workspace-packages=true',
      STAGING,
    ], cli.dryRun)
  } finally {
    if (!cli.dryRun) {
      if (workspaceState === undefined) await rm(WORKSPACE_STATE, { force: true })
      else await writeFile(WORKSPACE_STATE, workspaceState)
    }
  }
  if (cli.dryRun) {
    console.log(`build-desktop-sidecar: [dry-run] restore the dependency and required-peer closure from ${WORKSPACE_MODULES}`)
  } else {
    await restoreRuntimeClosure()
  }
  if (cli.dryRun) {
    console.log(`build-desktop-sidecar: [dry-run] prune restricted Anthropic packages below ${STAGING}`)
    console.log(`build-desktop-sidecar: [dry-run] remove .bin directories below ${STAGING}`)
    return
  }
  const removedClaudePayloads = await pruneRestrictedClaudePackages(STAGING)
  if (removedClaudePayloads.length > 0) {
    console.log(`build-desktop-sidecar: removed ${removedClaudePayloads.length} restricted Anthropic package(s)`)
  }
  await removeBinDirectories(STAGING)
  await removeDeployMetadata(STAGING)
  const link = await findSymlink(STAGING)
  if (link !== undefined) throw new Error(`staged production closure still contains a symbolic link: ${link}`)
}

async function restoreRuntimeClosure(): Promise<void> {
  const queue = [STAGING]
  const visited = new Set<string>()
  const restored: string[] = []
  for (let packageDir = queue.shift(); packageDir !== undefined; packageDir = queue.shift()) {
    const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as PackageManifest
    const required = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {})
        .filter(name => manifest.peerDependenciesMeta?.[name]?.optional !== true),
    ])
    for (const dependency of [...required].sort()) {
      if (visited.has(dependency)) continue
      visited.add(dependency)
      const destination = containedPackagePath(join(STAGING, 'node_modules'), dependency)
      if (!existsSync(destination)) {
        const source = containedPackagePath(WORKSPACE_MODULES, dependency)
        if (!existsSync(source)) {
          throw new Error(`required runtime package ${dependency} is absent from the deployed closure and ${WORKSPACE_MODULES}.`)
        }
        await mkdir(dirname(destination), { recursive: true })
        const nestedNodeModules = join(source, 'node_modules')
        await cp(source, destination, {
          recursive: true,
          dereference: true,
          filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
        })
        restored.push(dependency)
      }
      queue.push(destination)
    }
  }
  if (restored.length > 0) {
    console.log(`build-desktop-sidecar: restored ${restored.length} dependency-closure packages`)
  }
}

async function installedPackageVersion(
  directory: string,
  dependency: string,
  optional: boolean,
): Promise<string | undefined> {
  const packageDirectory = containedPackagePath(join(directory, 'node_modules'), dependency)
  const manifestPath = join(packageDirectory, 'package.json')
  if (!existsSync(manifestPath)) {
    if (optional) return undefined
    throw new Error(`required staged runtime dependency ${dependency} has no package.json.`)
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`staged runtime dependency ${dependency} has no concrete version.`)
  }
  return manifest.version
}

async function exactDependencySection(
  directory: string,
  dependencies: Record<string, string> | undefined,
  optionalNames: ReadonlySet<string>,
): Promise<Record<string, string> | undefined> {
  if (dependencies === undefined) return undefined
  const result: Record<string, string> = {}
  for (const dependency of Object.keys(dependencies).sort()) {
    const version = await installedPackageVersion(directory, dependency, optionalNames.has(dependency))
    if (version !== undefined) result[dependency] = version
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/** Replace pnpm's deploy manifest with the exact runtime-only package metadata consumed by pkg. */
export async function normalizeStagedRootManifest(directory: string, target: HostTarget): Promise<void> {
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
  const optionalPeers = new Set(Object.entries(manifest.peerDependenciesMeta ?? {})
    .filter(([, metadata]) => metadata.optional === true)
    .map(([name]) => name))
  const dependencies = await exactDependencySection(directory, manifest.dependencies, new Set())
  const optionalDependencies = await exactDependencySection(
    directory,
    manifest.optionalDependencies,
    new Set(Object.keys(manifest.optionalDependencies ?? {})),
  )
  const peerDependencies = await exactDependencySection(directory, manifest.peerDependencies, optionalPeers)
  const normalized: Record<string, unknown> = {}
  for (const key of [
    'name', 'description', 'version', 'type', 'license', 'repository', 'homepage',
    'author', 'contributors', 'engines', 'main', 'module', 'exports', 'imports',
  ]) {
    if (manifest[key] !== undefined) normalized[key] = manifest[key]
  }
  normalized.bin = ENTRY_BIN
  if (dependencies !== undefined) normalized.dependencies = dependencies
  if (optionalDependencies !== undefined) normalized.optionalDependencies = optionalDependencies
  if (peerDependencies !== undefined) normalized.peerDependencies = peerDependencies
  if (peerDependencies !== undefined && optionalPeers.size > 0) {
    normalized.peerDependenciesMeta = Object.fromEntries(
      [...optionalPeers]
        .filter(name => peerDependencies[name] !== undefined)
        .sort()
        .map(name => [name, { optional: true }]),
    )
  }
  normalized.pkg = { assets: [...PORTABLE_ASSET_GLOBS, ...nativeAssetGlobsForTarget(target)] }
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`
  if (/\bfile:\/\//i.test(serialized)) {
    throw new Error('normalized staged root manifest still contains an absolute file URL.')
  }
  await writeFile(manifestPath, serialized)
}

async function injectPkgConfig(cli: Cli, target: HostTarget): Promise<void> {
  const manifestPath = join(STAGING, 'package.json')
  if (cli.dryRun) {
    console.log(`build-desktop-sidecar: [dry-run] normalize ${manifestPath} to exact runtime-only dependencies and pkg assets`)
    return
  }
  if (!existsSync(join(STAGING, ENTRY_BIN))) {
    throw new Error(`${join(STAGING, ENTRY_BIN)} is missing; run without --skip-build so compiled artifacts exist.`)
  }
  await normalizeStagedRootManifest(STAGING, target)
}

async function verifyRedistributableAssets(cli: Cli): Promise<void> {
  if (cli.dryRun) {
    console.log(`build-desktop-sidecar: [dry-run] reject Anthropic SDK/platform payloads below ${STAGING}`)
    return
  }
  const violations = await findRestrictedClaudePayloads(STAGING)
  if (violations.length > 0) {
    throw new Error(
      'staged SEA assets contain Anthropic SDK/platform payloads that this derivative cannot redistribute:\n'
      + violations.map(path => `  ${path}`).join('\n'),
    )
  }
}

function isolatedPkgEnvironment(cwd: string): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const lower = key.toLowerCase()
    return lower !== 'node_options' && lower !== 'node_path' && lower !== 'init_cwd' && lower !== 'oldpwd'
      && !lower.startsWith('npm_') && !lower.startsWith('pnpm_')
  }))
  const temporaryDirectory = neutralPkgTempDirectory(process.platform, environment)
  return {
    ...environment,
    CI: 'true',
    PWD: cwd,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
  }
}

async function verifyArtifactIsolation(
  executable: string,
  target: HostTarget,
  isolationRoots: readonly string[],
): Promise<void> {
  const markers = sidecarArtifactForbiddenMarkers({
    repositoryRoot: root,
    userHome: homedir(),
    isolationRoots,
    ...process.env.GITHUB_WORKSPACE === undefined
      ? {}
      : { githubWorkspace: process.env.GITHUB_WORKSPACE },
  })
  const wholeArtifactMarkers = wholeArtifactSidecarForbiddenMarkers(markers)
  const wholeArtifactViolations = await findForbiddenSidecarArtifactMarkers(executable, wholeArtifactMarkers)
  const vfsManifest = extractPkgVfsManifest(await readFile(executable))
  verifyHostNativeVfsManifest(vfsManifest, target)
  const vfsViolations = findForbiddenTextMarkers(vfsManifest, markers)
  const keyed = new Map<string, ArtifactMarker>()
  for (const marker of [...wholeArtifactViolations, ...vfsViolations]) {
    keyed.set(`${marker.label}\0${marker.value.toLowerCase()}`, marker)
  }
  const violations = [...keyed.values()].sort((left, right) => (
    left.label.localeCompare(right.label) || left.value.localeCompare(right.value)
  ))
  if (violations.length > 0) {
    throw new Error(
      'compiled SEA contains host/build-only strings outside its licensed staging closure:\n'
      + violations.map(marker => `  ${marker.label}: ${marker.value}`).join('\n'),
    )
  }
  console.log(
    `build-desktop-sidecar: verified SEA bytes/VFS against ${String(markers.length)} forbidden path/asset markers; `
    + `native closure is exactly ${target.platform}/${target.architecture}`,
  )
}

async function buildSidecar(cli: Cli, target: HostTarget): Promise<string[]> {
  const executable = join(BINARIES, `dsh-backend-${target.rustTriple}${target.executableSuffix}`)
  if (!cli.dryRun) await mkdir(BINARIES, { recursive: true })
  if (cli.dryRun) {
    const placeholderRoot = join(tmpdir(), `${ISOLATED_BUILD_PREFIX}<random>`)
    const placeholderInput = join(placeholderRoot, 'app')
    console.log(`build-desktop-sidecar: [dry-run] copy ${STAGING} to ${placeholderInput}`)
    await run('pkg', process.execPath, [
      PKG_CLI,
      placeholderInput,
      '--sea',
      '--targets',
      target.pkgTarget,
      '--output',
      executable,
    ], true, placeholderRoot)
    await removeWindowsSignature(cli, executable)
    console.log(`build-desktop-sidecar: [dry-run] reject host paths and undeclared build-tool assets in ${executable}`)
  } else {
    if (!regularFile(PKG_CLI)) throw new Error(`pinned @yao-pkg/pkg CLI is missing: ${PKG_CLI}`)
    const isolationRoot = await mkdtemp(join(tmpdir(), ISOLATED_BUILD_PREFIX))
    let physicalIsolationRoot = isolationRoot
    try {
      physicalIsolationRoot = await realpath(isolationRoot)
      const ancestorModules = findAncestorNodeModules(physicalIsolationRoot)
      if (ancestorModules !== undefined) {
        throw new Error(`isolated pkg working directory has an ancestor node_modules directory: ${ancestorModules}`)
      }
      const isolatedInput = join(physicalIsolationRoot, 'app')
      await cp(STAGING, isolatedInput, { recursive: true })
      await run('pkg', process.execPath, [
        PKG_CLI,
        isolatedInput,
        '--sea',
        '--targets',
        target.pkgTarget,
        '--output',
        executable,
      ], false, physicalIsolationRoot, isolatedPkgEnvironment(physicalIsolationRoot))
      await removeWindowsSignature(cli, executable)
      await verifyArtifactIsolation(executable, target, [isolationRoot, physicalIsolationRoot])
    } finally {
      await rm(isolationRoot, { recursive: true, force: true })
    }
  }
  const products = [executable]
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const source = process.platform === 'linux'
      ? join(STAGING, 'node_modules/node-pty/build/Release/spawn-helper')
      : join(STAGING, 'node_modules/node-pty/prebuilds', target.nodePtyPlatform, 'spawn-helper')
    const helper = join(BINARIES, `dsh-backend-spawn-helper-${target.rustTriple}`)
    if (cli.dryRun) console.log(`build-desktop-sidecar: [dry-run] copy ${source} to ${helper}`)
    else {
      if (!existsSync(source)) throw new Error(`node-pty spawn helper is missing: ${source}`)
      await copyFile(source, helper)
      await chmod(helper, 0o755)
    }
    products.push(helper)
  }
  return products
}

/** Call one unary sidecar RPC and fail closed on its transport or envelope. */
async function callSidecarRpc(baseUrl: URL, method: string, payload: unknown): Promise<unknown> {
  const rpcId = `desktop-sidecar-${method.replaceAll('.', '-')}`
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`sidecar ${method} returned HTTP ${String(response.status)}: ${body.slice(0, 1_000)}`)
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(body)
  } catch (error) {
    throw new Error(`sidecar ${method} returned invalid JSON: ${String(error)}`)
  }
  if (!isRecord(envelope) || envelope.type !== 'server-response'
    || envelope.rpcId !== rpcId || !isRecord(envelope.result)) {
    throw new Error(`sidecar ${method} returned an invalid response envelope`)
  }
  const result = envelope.result
  if (result.ok !== true) {
    const error = isRecord(result.error) && typeof result.error.message === 'string'
      ? `: ${result.error.message}`
      : ''
    throw new Error(`sidecar ${method} failed${error}`)
  }
  return result.value
}

/** Verify the roster read that backs every Agent-preset Web surface. */
async function verifyAgentPresetRoster(baseUrl: URL): Promise<AgentPresetRosterSmoke> {
  const value = await callSidecarRpc(baseUrl, 'agentPreset.list', {})
  const presets = isRecord(value) && Array.isArray(value.presets) ? value.presets : undefined
  if (presets === undefined || presets.length === 0) {
    throw new Error('sidecar agentPreset.list returned no shipped presets')
  }
  const ids = new Set<string>()
  for (const preset of presets) {
    if (!isRecord(preset)
      || typeof preset.id !== 'string' || preset.id === ''
      || (preset.trust !== 'system' && preset.trust !== 'user')
      || typeof preset.isDefault !== 'boolean') {
      throw new Error('sidecar agentPreset.list returned an invalid preset row')
    }
    if (ids.has(preset.id)) throw new Error(`sidecar agentPreset.list returned duplicate preset ${preset.id}`)
    ids.add(preset.id)
  }
  const defaults = presets.filter(preset => isRecord(preset) && preset.isDefault === true)
  if (defaults.length !== 1 || !isRecord(defaults[0]) || typeof defaults[0].id !== 'string') {
    throw new Error('sidecar agentPreset.list returned no valid default preset')
  }
  return { count: presets.length, defaultPresetId: defaults[0].id }
}

/** Whether one DeepSeek wire request contains the complete distinctive badge body. */
export function requestContainsBundledBadgeBody(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.messages)) return false
  return value.messages.some((message) => {
    if (!isRecord(message) || message.role !== 'user' || typeof message.content !== 'string') return false
    const content = message.content
    return BADGE_BODY_MARKERS.every(marker => content.includes(marker))
  })
}

/** Whether a DeepSeek wire request carries one completed tool result with all expected markers. */
export function requestContainsToolResult(
  value: unknown,
  toolCallId: string,
  markers: readonly string[],
): boolean {
  if (!isRecord(value) || !Array.isArray(value.messages)) return false
  return value.messages.some((message) => {
    if (!isRecord(message) || message.role !== 'tool'
      || message.tool_call_id !== toolCallId || typeof message.content !== 'string') return false
    const content = message.content
    return markers.every(marker => content.includes(marker))
  })
}

function smokeToolResultDiagnostic(value: unknown, toolCallId: string): string {
  if (!isRecord(value) || !Array.isArray(value.messages)) return 'request has no messages array'
  const messages: unknown[] = value.messages
  const message = messages.find(candidate => isRecord(candidate)
    && candidate.role === 'tool' && candidate.tool_call_id === toolCallId)
  if (!isRecord(message)) {
    const descriptors = messages.map((candidate) => {
      if (!isRecord(candidate)) return typeof candidate
      const role = typeof candidate.role === 'string' ? candidate.role : '<no-role>'
      const id = typeof candidate.tool_call_id === 'string' ? candidate.tool_call_id : '<no-tool-id>'
      return `${role}/${id}`
    })
    return `request has no tool result for ${toolCallId}; messages: ${descriptors.join(', ')}`
  }
  if (typeof message.content !== 'string') return `tool result for ${toolCallId} has non-text content`
  return message.content.slice(0, 1_000)
}

function requestExposesTools(value: unknown, expectedNames: readonly string[]): boolean {
  if (!isRecord(value) || !Array.isArray(value.tools)) return false
  const names = new Set(value.tools.flatMap((tool) => {
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)
      || typeof tool.function.name !== 'string') return []
    return [tool.function.name]
  }))
  return expectedNames.every(name => names.has(name))
}

function writeSmokeToolCall(
  response: import('node:http').ServerResponse,
  id: string,
  name: string,
  argumentsValue: Record<string, unknown>,
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":""},"finish_reason":null}]}\n\n')
  response.write(`data: ${JSON.stringify({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(argumentsValue) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`)
  response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
  response.end('data: [DONE]\n\n')
}

function writeSmokeText(response: import('node:http').ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":""},"finish_reason":null}]}\n\n')
  response.write('data: {"choices":[{"index":0,"delta":{"content":"sidecar smoke complete"},"finish_reason":null}]}\n\n')
  response.write('data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
  response.end('data: [DONE]\n\n')
}

/** Local-only DeepSeek stand-in used to observe the real prompt assembled by the closed runtime. */
export async function startSmokeLlmServer(): Promise<SmokeLlmServer> {
  let resolveBadgeRequest: (value: unknown) => void = () => {}
  let rejectBadgeRequest: (reason: unknown) => void = () => {}
  let resolveSearchCompleted: () => void = () => {}
  let rejectSearchCompleted: (reason: unknown) => void = () => {}
  const badgeRequest = new Promise<unknown>((resolveRequest, rejectRequest) => {
    resolveBadgeRequest = resolveRequest
    rejectBadgeRequest = rejectRequest
  })
  const searchCompleted = new Promise<void>((resolveSearch, rejectSearch) => {
    resolveSearchCompleted = resolveSearch
    rejectSearchCompleted = rejectSearch
  })
  // The request can reject before the smoke reaches its await; attach a handler
  // immediately while preserving the original promise's rejection for the caller.
  void badgeRequest.catch(() => {})
  void searchCompleted.catch(() => {})
  let stage: 'badge' | 'glob-result' | 'grep-result' | 'complete' = 'badge'
  const failSmoke = (reason: unknown): void => {
    rejectBadgeRequest(reason)
    rejectSearchCompleted(reason)
  }
  const server: Server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    let oversized = false
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > SIDECAR_SMOKE_REQUEST_MAX_BYTES) {
        oversized = true
        chunks.length = 0
      } else if (!oversized) {
        chunks.push(chunk)
      }
    })
    request.once('error', failSmoke)
    request.once('end', () => {
      if (oversized) {
        failSmoke(new Error('sidecar model request exceeded the smoke-test size limit'))
        response.writeHead(413).end()
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        failSmoke(new Error(`sidecar model request was not JSON: ${String(error)}`))
        response.writeHead(400).end()
        return
      }
      if (stage === 'badge') {
        if (!requestExposesTools(payload, ['glob', 'grep'])) {
          // Session-title and other optional model consumers may race the
          // Agent's first request. They do not carry the Agent tool catalog.
          writeSmokeText(response)
          return
        }
        if (!requestContainsBundledBadgeBody(payload)) {
          failSmoke(new Error('sidecar model request omitted the complete bundled dsh-badge body'))
          response.writeHead(400).end()
          return
        }
        if (!requestExposesTools(payload, ['glob', 'grep'])) {
          failSmoke(new Error('sidecar default preset did not expose both glob and grep to the model'))
          response.writeHead(400).end()
          return
        }
        resolveBadgeRequest(payload)
        stage = 'glob-result'
        writeSmokeToolCall(response, SIDECAR_GLOB_CALL_ID, 'glob', { pattern: SIDECAR_SEARCH_SMOKE_FILE })
        return
      }
      if (stage === 'glob-result') {
        if (!requestContainsToolResult(payload, SIDECAR_GLOB_CALL_ID, [])) {
          // Session-title and other optional model consumers can run beside the
          // Agent turn. They have no matching tool result and must not advance
          // the controlled glob -> grep smoke sequence.
          writeSmokeText(response)
          return
        }
        if (!requestContainsToolResult(payload, SIDECAR_GLOB_CALL_ID, [SIDECAR_SEARCH_SMOKE_FILE])) {
          failSmoke(new Error(
            'sidecar glob tool did not return the ripgrep smoke fixture: '
            + smokeToolResultDiagnostic(payload, SIDECAR_GLOB_CALL_ID),
          ))
          response.writeHead(400).end()
          return
        }
        stage = 'grep-result'
        writeSmokeToolCall(response, SIDECAR_GREP_CALL_ID, 'grep', {
          pattern: SIDECAR_SEARCH_SMOKE_MARKER,
          path: SIDECAR_SEARCH_SMOKE_FILE,
        })
        return
      }
      if (stage === 'grep-result') {
        if (!requestContainsToolResult(payload, SIDECAR_GREP_CALL_ID, [])) {
          writeSmokeText(response)
          return
        }
        if (!requestContainsToolResult(
          payload,
          SIDECAR_GREP_CALL_ID,
          [SIDECAR_SEARCH_SMOKE_FILE, SIDECAR_SEARCH_SMOKE_MARKER],
        )) {
          failSmoke(new Error('sidecar grep tool did not execute the packaged ripgrep fixture search'))
          response.writeHead(400).end()
          return
        }
        stage = 'complete'
        resolveSearchCompleted()
      }
      writeSmokeText(response)
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('sidecar smoke LLM server has no TCP address')
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    badgeRequest,
    searchCompleted,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error === undefined) resolveClose()
        else rejectClose(error)
      })
      server.closeAllConnections()
    }),
  }
}

/** Mount the default preset and force the bundled badge body through its real pre-step path. */
async function verifyClosedRuntimeAgent(
  baseUrl: URL,
  runtimeRoot: string,
  defaultPresetId: string,
  badgeRequest: Promise<unknown>,
  searchCompleted: Promise<void>,
): Promise<void> {
  const created = await callSidecarRpc(baseUrl, 'session.create', {
    sessionId: SIDECAR_SMOKE_SESSION_ID,
    cwd: runtimeRoot,
  })
  if (!isRecord(created)
    || created.sessionId !== SIDECAR_SMOKE_SESSION_ID
    || created.agentPreset !== defaultPresetId) {
    throw new Error('sidecar session.create did not instantiate the advertised default preset')
  }
  const catalog = await callSidecarRpc(baseUrl, 'skill.list', { sessionId: SIDECAR_SMOKE_SESSION_ID })
  const skills = isRecord(catalog) && Array.isArray(catalog.skills) ? catalog.skills : undefined
  if (skills === undefined || !skills.some(skill => isRecord(skill) && skill.name === 'dsh-badge')) {
    throw new Error('sidecar default-preset Agent cannot see the bundled dsh-badge skill')
  }
  const prompted = await callSidecarRpc(baseUrl, 'session.prompt', {
    sessionId: SIDECAR_SMOKE_SESSION_ID,
    mode: 'queue',
    content: [{ type: 'text', text: '/dsh-badge verify the packaged skill body' }],
  })
  if (!isRecord(prompted) || prompted.accepted !== true) {
    throw new Error('sidecar session.prompt did not accept the dsh-badge invocation')
  }
  await Promise.race([
    Promise.all([badgeRequest, searchCompleted]),
    delay(SIDECAR_AGENT_SMOKE_TIMEOUT_MS, undefined, { ref: false }).then(() => {
      throw new Error(
        'sidecar did not load the bundled dsh-badge body and execute its packaged glob/grep tools before the smoke timeout',
      )
    }),
  ])
}

async function verifyMaterializedRipgrep(runtimeRoot: string): Promise<string> {
  const cacheRoot = join(runtimeRoot, 'native-cache', 'pkg', 'ripgrep')
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const executable = await findNestedFile(cacheRoot, path => basename(path) === binaryName)
  if (executable === undefined) {
    throw new Error('sidecar glob/grep smoke produced no materialized ripgrep executable')
  }
  const metadata = await lstat(executable)
  if (!metadata.isFile() || metadata.size <= 0
    || (process.platform !== 'win32' && (metadata.mode & 0o111) === 0)) {
    throw new Error(`sidecar materialized ripgrep path is not an executable file: ${executable}`)
  }
  return executable
}

function smokeEnvironment(runtimeRoot: string, llmBaseUrl: string): NodeJS.ProcessEnv {
  const allowed = [
    'APPDATA', 'COMSPEC', 'DYLD_LIBRARY_PATH', 'HOME', 'LANG', 'LC_ALL',
    'LD_LIBRARY_PATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'PROGRAMDATA',
    'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR',
  ] as const
  const env: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return {
    ...env,
    DEEPSEEK_API_KEY: 'desktop-sidecar-smoke-key',
    DEEPSEEK_BASE_URL: llmBaseUrl,
    DSH_AGENTS_HOME: join(runtimeRoot, 'agents'),
    DSH_CLOSED_RUNTIME: '1',
    DSH_HOME: join(runtimeRoot, 'dsh'),
    DSH_TELEMETRY_DISABLED: '1',
    PKG_NATIVE_CACHE_PATH: join(runtimeRoot, 'native-cache'),
  }
}

/** Verify that the compiled executable can discover and serve its shipped browser plugins. */
export async function verifySidecar(executable: string): Promise<void> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-sidecar-'))
  const smokePatch = join(runtimeRoot, 'enable-badge.patch.yml')
  await writeFile(smokePatch, '- id: skill-badge\n  disabled: false\n')
  await writeFile(
    join(runtimeRoot, SIDECAR_SEARCH_SMOKE_FILE),
    `${SIDECAR_SEARCH_SMOKE_MARKER}\n`,
  )
  const smokeLlm = await startSmokeLlmServer()
  const child = spawn(executable, [
    'web',
    '--patch', smokePatch,
    '--host', '127.0.0.1',
    '--port', '0',
  ], {
    cwd: runtimeRoot,
    env: smokeEnvironment(runtimeRoot, smokeLlm.baseUrl),
    stdio: ['ignore', 'pipe', 'pipe'] as const,
  })
  let diagnosticBytes = 0
  let diagnosticEvents = 0
  let stdout = ''
  const appendDiagnostics = (chunk: Buffer): void => {
    diagnosticEvents += 1
    diagnosticBytes = Math.min(16_384, diagnosticBytes + chunk.byteLength)
  }
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString('utf8')}`.slice(-16_384)
    appendDiagnostics(chunk)
  })
  child.stderr.on('data', appendDiagnostics)

  const closed = new Promise<void>(resolveClose => child.once('close', () => { resolveClose() }))
  try {
    const baseUrl = await new Promise<URL>((resolveReady, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(
          `sidecar did not become ready within ${String(SIDECAR_READY_TIMEOUT_MS)} ms `
          + `(diagnostics: ${String(diagnosticEvents)} event(s), ${String(diagnosticBytes)} byte(s))`,
        ))
      }, SIDECAR_READY_TIMEOUT_MS)
      const inspect = (): void => {
        const match = stdout.match(/(?:^|\n)dsh web: (http:\/\/127\.0\.0\.1:\d+)\r?(?:\n|$)/)
        if (match?.[1] === undefined) return
        clearTimeout(timeout)
        resolveReady(new URL(match[1]))
      }
      child.stdout.on('data', inspect)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('close', (code, signal) => {
        clearTimeout(timeout)
        const status = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${String(code)}`
        reject(new Error(
          `sidecar stopped before readiness (${status}; diagnostics: `
          + `${String(diagnosticEvents)} event(s), ${String(diagnosticBytes)} byte(s))`,
        ))
      })
      inspect()
    })

    const indexResponse = await fetch(baseUrl, { signal: AbortSignal.timeout(30_000) })
    if (!indexResponse.ok) {
      throw new Error(`sidecar index returned HTTP ${String(indexResponse.status)}`)
    }
    const html = await indexResponse.text()
    const marker = '<script>window.__DSH_BOOT__ = '
    const start = html.indexOf(marker)
    const end = start === -1 ? -1 : html.indexOf('</script>', start)
    if (start === -1 || end === -1) throw new Error('sidecar index contains no boot manifest')
    const parsed = JSON.parse(html.slice(start + marker.length, end)) as { entries?: unknown }
    if (!Array.isArray(parsed.entries)) throw new Error('sidecar boot manifest has no entries array')

    const seen = new Set<string>()
    for (const candidate of parsed.entries) {
      if (!isRecord(candidate)
        || typeof candidate.id !== 'string' || candidate.id === ''
        || typeof candidate.url !== 'string') {
        throw new Error('sidecar boot manifest contains an invalid plugin row')
      }
      if (seen.has(candidate.id)) throw new Error(`sidecar boot manifest contains duplicate plugin ${candidate.id}`)
      seen.add(candidate.id)
      const bundleUrl = new URL(candidate.url, baseUrl)
      if (bundleUrl.origin !== baseUrl.origin) {
        throw new Error(`sidecar boot manifest points ${candidate.id} outside the local runtime origin`)
      }
      const bundleResponse = await fetch(bundleUrl, { signal: AbortSignal.timeout(30_000) })
      if (!bundleResponse.ok) {
        throw new Error(`${candidate.id} returned HTTP ${String(bundleResponse.status)}`)
      }
      await bundleResponse.arrayBuffer()
    }
    for (const id of REQUIRED_CLIENT_PACKAGES) {
      if (!seen.has(id)) throw new Error(`sidecar boot manifest is missing ${id}`)
    }
    const roster = await verifyAgentPresetRoster(baseUrl)
    await verifyClosedRuntimeAgent(
      baseUrl,
      runtimeRoot,
      roster.defaultPresetId,
      smokeLlm.badgeRequest,
      smokeLlm.searchCompleted,
    )
    await verifyMaterializedRipgrep(runtimeRoot)
    console.log(
      `build-desktop-sidecar: verified all ${String(parsed.entries.length)} browser plugin bundles and `
      + `${String(roster.count)} agent presets; instantiated default preset ${roster.defaultPresetId} `
      + 'and loaded the dsh-badge body; packaged ripgrep executed default-agent glob and grep',
    )
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await Promise.race([closed, delay(5_000, undefined, { ref: false })])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    await smokeLlm.close()
    await rm(runtimeRoot, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const cli = parseSidecarCli(process.argv.slice(2))
  const target = resolveHostTarget(process.platform, process.arch)
  console.log(`build-desktop-sidecar: native target ${target.rustTriple} (${target.pkgTarget})`)
  if (!cli.skipBuild) await runPnpm('build', ['run', 'build'], cli.dryRun)
  await deploy(cli)
  await prepareLinuxNodePty(cli, target)
  await prepareHostNativePayloads(cli, target)
  await auditStagedNpmPackages(cli)
  await injectPkgConfig(cli, target)
  await verifyRedistributableAssets(cli)
  const products = await buildSidecar(cli, target)
  if (cli.dryRun) console.log(`build-desktop-sidecar: [dry-run] generate desktop license bundle for ${target.rustTriple}`)
  else {
    const licenseEntries = await generateDesktopLicensesForTarget(target.rustTriple)
    console.log(`build-desktop-sidecar: recorded ${String(licenseEntries.length)} npm, Rust, runtime, and build-tool license records`)
  }
  const executable = products[0]
  if (executable === undefined) throw new Error('desktop sidecar build produced no executable')
  if (cli.dryRun) console.log(`build-desktop-sidecar: [dry-run] verify ${executable}`)
  else await verifySidecar(executable)
  console.log(cli.dryRun ? 'build-desktop-sidecar: [dry-run] would produce:' : 'build-desktop-sidecar: products:')
  for (const path of products) {
    if (cli.dryRun) console.log(`  ${path}`)
    else console.log(`  ${path} (${(statSync(path).size / (1024 * 1024)).toFixed(1)} MB)`)
  }
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) await main()
