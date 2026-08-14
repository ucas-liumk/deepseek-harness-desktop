import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditStagedNpmPackageVersions,
  collectStagedNpmPackageVersions,
  compareWindowsSdkVersionsDescending,
  extractPkgVfsManifest,
  findAncestorNodeModules,
  findForbiddenSidecarArtifactMarkers,
  findRestrictedClaudePayloads,
  hostNativeLayout,
  locateWindowsSignTool,
  nativeAssetGlobsForTarget,
  neutralPkgTempDirectory,
  normalizeStagedRootManifest,
  parseSidecarCli,
  pruneHostNativePayloads,
  pruneRestrictedClaudePackages,
  readLinuxElfArchitecture,
  readPeCertificateTable,
  requestContainsBundledBadgeBody,
  requestContainsToolResult,
  ripgrepAssetForTarget,
  ripgrepSeaEntrypointSource,
  resolveHostTarget,
  sidecarArtifactForbiddenMarkers,
  startSmokeLlmServer,
  verifyHostNativeStaging,
  verifyHostNativeVfsManifest,
} from './build-desktop-sidecar.ts'
import { parseBuildCli } from './build-desktop.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

describe('shell-free pnpm invocation', () => {
  it('uses Node and the pnpm JavaScript entrypoint on Windows-compatible builds', () => {
    expect(pnpmInvocation(['run', 'build'], 'C:\\pnpm\\pnpm.cjs', 'C:\\node\\node.exe')).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['C:\\pnpm\\pnpm.cjs', 'run', 'build'],
    })
    expect(() => pnpmInvocation(['run', 'build'], '', 'node')).toThrow('npm_execpath is unavailable')
  })

  it('accepts the pnpm argument separator for direct sidecar builds', () => {
    expect(parseSidecarCli(['--', '--skip-build', '--dry-run'])).toEqual({
      skipBuild: true,
      dryRun: true,
    })
  })
})

describe('isolated SEA build inputs', () => {
  it('recognizes only a model request carrying the complete bundled badge body', () => {
    expect(requestContainsBundledBadgeBody({
      messages: [{
        role: 'user',
        content: '<skill_instructions>\n# dsh Badge\nPreserve the badge\'s 121×20 dimensions\n</skill_instructions>',
      }],
    })).toBe(true)
    expect(requestContainsBundledBadgeBody({
      messages: [{ role: 'user', content: '/dsh-badge verify the packaged skill body' }],
    })).toBe(false)
    expect(requestContainsBundledBadgeBody({
      messages: [{ role: 'system', content: '# dsh Badge\nPreserve the badge\'s 121×20 dimensions' }],
    })).toBe(false)
  })

  it('recognizes only the matching completed glob/grep tool result', () => {
    const request = {
      messages: [{
        role: 'tool',
        tool_call_id: 'grep-call',
        content: 'sidecar-ripgrep-smoke.txt\nLine 1: SEA_RIPGREP_EXECUTION_CONFIRMED',
      }],
    }
    expect(requestContainsToolResult(request, 'grep-call', [
      'sidecar-ripgrep-smoke.txt',
      'SEA_RIPGREP_EXECUTION_CONFIRMED',
    ])).toBe(true)
    expect(requestContainsToolResult(request, 'grep-call', [])).toBe(true)
    expect(requestContainsToolResult(request, 'glob-call', ['sidecar-ripgrep-smoke.txt'])).toBe(false)
    expect(requestContainsToolResult({
      messages: [{ role: 'user', content: 'independent title request' }],
    }, 'grep-call', [])).toBe(false)
    expect(requestContainsToolResult({
      messages: [{ role: 'assistant', tool_call_id: 'grep-call', content: 'SEA_RIPGREP_EXECUTION_CONFIRMED' }],
    }, 'grep-call', ['SEA_RIPGREP_EXECUTION_CONFIRMED'])).toBe(false)
  })

  it('keeps concurrent title requests outside the badge, glob, and grep smoke sequence', async () => {
    const smoke = await startSmokeLlmServer()
    const post = async (payload: unknown): Promise<string> => {
      const response = await fetch(`${smoke.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(response.status).toBe(200)
      return response.text()
    }
    const titleRequest = {
      messages: [
        { role: 'system', content: 'Generate a title.' },
        { role: 'user', content: '/dsh-badge verify the packaged skill body' },
      ],
    }
    try {
      expect(await post(titleRequest)).toContain('sidecar smoke complete')
      expect(await post({
        messages: [{
          role: 'user',
          content: '<skill_instructions>\n# dsh Badge\nPreserve the badge\'s 121×20 dimensions\n</skill_instructions>',
        }],
        tools: ['glob', 'grep'].map(name => ({ type: 'function', function: { name } })),
      })).toContain('desktop-sidecar-glob-smoke')

      expect(await post(titleRequest)).toContain('sidecar smoke complete')
      expect(await post({
        messages: [{
          role: 'tool',
          tool_call_id: 'desktop-sidecar-glob-smoke',
          content: 'sidecar-ripgrep-smoke.txt',
        }],
      })).toContain('desktop-sidecar-grep-smoke')

      expect(await post(titleRequest)).toContain('sidecar smoke complete')
      expect(await post({
        messages: [{
          role: 'tool',
          tool_call_id: 'desktop-sidecar-grep-smoke',
          content: 'sidecar-ripgrep-smoke.txt\nLine 1: SEA_RIPGREP_EXECUTION_CONFIRMED',
        }],
      })).toContain('sidecar smoke complete')
      await expect(smoke.badgeRequest).resolves.toBeDefined()
      await expect(smoke.searchCompleted).resolves.toBeUndefined()
    } finally {
      await smoke.close()
    }
  })

  it('awaits the same exported verifier from the formal non-dry-run build path', async () => {
    const source = await readFile(join(import.meta.dirname, 'build-desktop-sidecar.ts'), 'utf8')
    const main = source.slice(source.indexOf('async function main()'))
    const built = main.indexOf('const products = await buildSidecar(cli, target)')
    const verified = main.indexOf('else await verifySidecar(executable)')
    const reported = main.indexOf("console.log(cli.dryRun ? 'build-desktop-sidecar: [dry-run] would produce:'")
    expect(built).toBeGreaterThanOrEqual(0)
    expect(verified).toBeGreaterThan(built)
    expect(reported).toBeGreaterThan(verified)
  })

  it('normalizes pnpm deploy metadata to exact runtime-only dependencies', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-manifest-'))
    try {
      const dependency = join(fixture, 'node_modules', '@deepseek-ai', 'runtime')
      await mkdir(dependency, { recursive: true })
      await writeFile(join(dependency, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/runtime',
        version: '1.2.3',
      }))
      await writeFile(join(fixture, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        description: 'runtime',
        version: '0.1.0',
        type: 'module',
        license: 'MIT',
        publishConfig: { access: 'public' },
        files: ['lib'],
        dependencies: {
          '@deepseek-ai/runtime': '@deepseek-ai/runtime@file:///Users/builder/work/runtime',
        },
        optionalDependencies: { 'missing-native-package': 'file:///Users/builder/native' },
        devDependencies: { tsx: '4.22.4', esbuild: '0.28.1' },
        pnpm: { injectedDeps: true },
      }))

      const target = resolveHostTarget('darwin', 'arm64')
      await normalizeStagedRootManifest(fixture, target)
      const serialized = await readFile(join(fixture, 'package.json'), 'utf8')
      const manifest = JSON.parse(serialized) as Record<string, unknown>
      expect(manifest).toMatchObject({
        name: '@deepseek-ai/dsh',
        description: 'runtime',
        version: '0.1.0',
        type: 'module',
        license: 'MIT',
        bin: 'lib/bin.js',
        dependencies: { '@deepseek-ai/runtime': '1.2.3' },
      })
      expect(manifest).not.toHaveProperty('devDependencies')
      expect(manifest).not.toHaveProperty('optionalDependencies')
      expect(manifest).not.toHaveProperty('publishConfig')
      expect(manifest).not.toHaveProperty('files')
      expect(manifest).not.toHaveProperty('pnpm')
      const serializedPkg = JSON.stringify(manifest.pkg)
      expect(serializedPkg).toContain(ripgrepAssetForTarget(target).relativePath)
      expect(serializedPkg).not.toContain('ripgrep-darwin-x64/bin/rg')
      expect(serializedPkg).not.toContain('node_modules/**/*.node')
      expect(serializedPkg).not.toContain('node_modules/**/*.dll')
      expect(serializedPkg).not.toContain('node_modules/**/*.exe')
      expect(serialized).not.toContain('file://')
      expect(serialized).not.toContain('/Users/builder')
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('detects ancestor node_modules directories before invoking pkg', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-ancestor-'))
    try {
      const nested = join(fixture, 'isolated', 'build')
      await mkdir(join(fixture, 'node_modules'), { recursive: true })
      await mkdir(nested, { recursive: true })
      expect(findAncestorNodeModules(nested)).toBe(join(fixture, 'node_modules'))
      await rm(join(fixture, 'node_modules'), { recursive: true, force: true })
      expect(findAncestorNodeModules(nested)).toBeUndefined()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('uses a stable pkg temporary directory outside user and CI workspaces', () => {
    expect(neutralPkgTempDirectory('darwin', { TMPDIR: '/var/folders/random/user-temp' })).toBe('/tmp')
    expect(neutralPkgTempDirectory('linux', { TMPDIR: '/home/runner/work/_temp' })).toBe('/tmp')
    expect(neutralPkgTempDirectory('win32', { SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\Temp')
    expect(neutralPkgTempDirectory('win32', {})).toBe('C:\\Windows\\Temp')
  })

  it('rejects host paths and undeclared build-tool assets across binary chunks', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-artifact-'))
    try {
      const executable = join(fixture, 'sidecar.bin')
      const markers = sidecarArtifactForbiddenMarkers({
        repositoryRoot: '/workspace/deepseek-harness-desktop',
        userHome: '/Users/builder',
        isolationRoots: ['/tmp/dsh-desktop-sea-build-fixture'],
        githubWorkspace: '/home/runner/work/project/project',
      })
      await writeFile(executable, Buffer.concat([
        Buffer.alloc(64 * 1024 - 7, 0x78),
        Buffer.from('/WORKSPACE/DEEPSEEK-HARNESS-DESKTOP'),
        Buffer.from('/node_modules/.pnpm/tsx@4.22.4/'),
        Buffer.from('/tmp/dsh-desktop-sea-build-fixture', 'utf16le'),
        Buffer.from('/private/var/folders/random/T/pkg-sea-fixture/sea-main.js'),
      ]))
      const violations = await findForbiddenSidecarArtifactMarkers(executable, markers)
      expect(violations.map(row => row.label)).toEqual(expect.arrayContaining([
        'repository root',
        'isolated build root',
        'host temporary directory',
        'undeclared build-tool asset',
      ]))
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('extracts exactly one structurally valid pkg VFS manifest and fails closed', () => {
    const manifest = JSON.stringify({
      entrypoint: '/snapshot/app/lib/bin.js',
      entryIsESM: true,
      directories: { '/app': ['lib', 'node_modules'] },
      stats: { '/app/lib/bin.js': { isFile: true, size: 2 } },
      symlinks: {},
      offsets: { '/app/lib/bin.js': [1, 2] },
      quotedBrace: 'not the end: }',
    })
    expect(extractPkgVfsManifest(Buffer.from(`prefix\0${manifest}\0suffix`))).toBe(manifest)
    expect(() => extractPkgVfsManifest(Buffer.from('no manifest'))).toThrow('no pkg VFS manifest')
    expect(() => extractPkgVfsManifest(Buffer.from(manifest.slice(0, -1)))).toThrow('truncated pkg VFS manifest')
    expect(() => extractPkgVfsManifest(Buffer.from(`${manifest}${manifest}`))).toThrow('multiple pkg VFS manifests')
    expect(() => extractPkgVfsManifest(Buffer.from(
      '{"entrypoint":"/snapshot/app/lib/bin.js","entryIsESM":true,"directories":[],"stats":{},"symlinks":{},"offsets":{}}',
    ))).toThrow('invalid pkg VFS manifest')
  })
})

describe('physical staged npm advisory audit', () => {
  it('collects the physical name/version set and collapses repeated physical package IDs', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-audit-'))
    try {
      await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'root-package', version: '1.0.0' }))
      for (const directory of [
        join(fixture, 'node_modules', '@scope', 'first'),
        join(fixture, 'node_modules', 'parent', 'node_modules', 'shared'),
        join(fixture, 'node_modules', 'other', 'node_modules', 'shared'),
      ]) {
        await mkdir(directory, { recursive: true })
      }
      await writeFile(join(fixture, 'node_modules', '@scope', 'first', 'package.json'), JSON.stringify({
        name: '@scope/first',
        version: '2.0.0',
      }))
      for (const name of ['parent', 'other']) {
        await writeFile(join(fixture, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '3.0.0' }))
        await writeFile(join(fixture, 'node_modules', name, 'node_modules', 'shared', 'package.json'), JSON.stringify({
          name: 'shared',
          version: '4.0.0',
        }))
      }
      await expect(collectStagedNpmPackageVersions(fixture)).resolves.toEqual([
        { name: '@scope/first', version: '2.0.0' },
        { name: 'other', version: '3.0.0' },
        { name: 'parent', version: '3.0.0' },
        { name: 'root-package', version: '1.0.0' },
        { name: 'shared', version: '4.0.0' },
      ])
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('posts only supplied physical versions and permits low/moderate advisories', async () => {
    let requestBody = ''
    const request = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body !== 'string') throw new Error('expected string request body')
      requestBody = init.body
      return Response.json({
        alpha: [{
          id: 101,
          url: 'https://github.com/advisories/GHSA-fixture',
          title: 'Fixture advisory',
          severity: 'moderate',
          vulnerable_versions: '<2.0.0',
        }],
      })
    }
    await expect(auditStagedNpmPackageVersions([
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '2.0.0' },
      { name: '@scope/beta', version: '3.0.0' },
    ], request)).resolves.toEqual({
      packageCount: 3,
      advisoryCount: 1,
      blockingAdvisories: [],
    })
    expect(JSON.parse(requestBody)).toEqual({
      '@scope/beta': ['3.0.0'],
      alpha: ['1.0.0', '2.0.0'],
    })
  })

  it('fails closed for duplicate input, network/response faults, and high advisories', async () => {
    const packages = [{ name: 'alpha', version: '1.0.0' }] as const
    await expect(auditStagedNpmPackageVersions([...packages, ...packages])).rejects.toThrow(
      'input repeats alpha@1.0.0',
    )
    await expect(auditStagedNpmPackageVersions(packages, (async () => {
      throw new Error('offline')
    }))).rejects.toThrow('request failed: offline')
    await expect(auditStagedNpmPackageVersions(packages, (async () => new Response('unavailable', {
      status: 503,
    })))).rejects.toThrow('HTTP 503')
    await expect(auditStagedNpmPackageVersions(packages, (async () => new Response('{}', {
      headers: { 'content-type': 'text/plain' },
    })))).rejects.toThrow('response is not JSON')
    await expect(auditStagedNpmPackageVersions(packages, (async () => Response.json({
      unexpected: [],
    })))).rejects.toThrow('unexpected package or value')
    const high = {
      id: 'GHSA-high',
      url: 'https://github.com/advisories/GHSA-high',
      title: 'High fixture',
      severity: 'high',
      vulnerable_versions: '<2.0.0',
    }
    await expect(auditStagedNpmPackageVersions(packages, (async () => Response.json({
      alpha: [high],
    })))).rejects.toThrow('GHSA-high [high] High fixture')
    await expect(auditStagedNpmPackageVersions(packages, (async () => Response.json({
      alpha: [high, high],
    })))).rejects.toThrow('repeats advisory GHSA-high')
  })

  it('accepts strict JSON when the npm bulk endpoint omits Content-Type', async () => {
    const responseWithoutContentType = new Response('{}')
    responseWithoutContentType.headers.delete('content-type')
    await expect(auditStagedNpmPackageVersions([
      { name: 'alpha', version: '1.0.0' },
    ], async () => responseWithoutContentType)).resolves.toEqual({
      packageCount: 1,
      advisoryCount: 0,
      blockingAdvisories: [],
    })
  })

  it('audits the exact post-prune staging closure before packaging or license generation', async () => {
    const source = await readFile(join(import.meta.dirname, 'build-desktop-sidecar.ts'), 'utf8')
    const deploy = source.slice(source.indexOf('async function deploy('), source.indexOf('async function restoreRuntimeClosure('))
    const main = source.slice(source.indexOf('async function main()'))
    expect(deploy).not.toContain('auditStagedNpmPackages')
    expect(main.indexOf('await prepareHostNativePayloads(cli, target)')).toBeGreaterThanOrEqual(0)
    expect(main.indexOf('await auditStagedNpmPackages(cli)')).toBeGreaterThan(
      main.indexOf('await prepareHostNativePayloads(cli, target)'),
    )
    expect(main.indexOf('await auditStagedNpmPackages(cli)')).toBeLessThan(
      main.indexOf('await injectPkgConfig(cli, target)'),
    )
    expect(main.indexOf('await auditStagedNpmPackages(cli)')).toBeLessThan(
      main.indexOf('await generateDesktopLicensesForTarget(target.rustTriple)'),
    )
  })
})

describe('desktop native targets', () => {
  it.each([
    ['darwin', 'arm64', 'node24.19.0-macos-arm64', 'aarch64-apple-darwin', 'darwin-arm64', ''],
    ['win32', 'x64', 'node24.19.0-win-x64', 'x86_64-pc-windows-msvc', 'win32-x64', '.exe'],
    ['linux', 'x64', 'node24.19.0-linux-x64', 'x86_64-unknown-linux-gnu', 'linux-x64', ''],
  ] as const)('maps native %s/%s without a target override', (
    platform,
    architecture,
    pkgTarget,
    rustTriple,
    nodePtyPlatform,
    executableSuffix,
  ) => {
    expect(resolveHostTarget(platform, architecture)).toEqual({
      platform,
      architecture,
      pkgTarget,
      rustTriple,
      nodePtyPlatform,
      executableSuffix,
    })
  })

  it('rejects unsupported hosts instead of manufacturing a cross-target build', () => {
    expect(() => resolveHostTarget('darwin', 'x64')).toThrow('unsupported desktop build host darwin/x64')
    expect(() => resolveHostTarget('win32', 'arm64')).toThrow('unsupported desktop build host win32/arm64')
    expect(() => resolveHostTarget('linux', 'arm64')).toThrow('unsupported desktop build host linux/arm64')
    expect(() => resolveHostTarget('linux', 'riscv64')).toThrow('unsupported desktop build host linux/riscv64')
    expect(() => resolveHostTarget('freebsd', 'x64')).toThrow('unsupported desktop build host freebsd/x64')
  })

  it('uses target-specific native globs without architecture-wide executable wildcards', () => {
    expect(nativeAssetGlobsForTarget(resolveHostTarget('linux', 'x64'))).toEqual([
      'node_modules/@vscode/ripgrep-linux-x64/bin/rg',
      'node_modules/@img/sharp-linux-x64/**/*',
      'node_modules/@img/sharp-libvips-linux-x64/**/*',
      'node_modules/@koromix/koffi-linux-x64/**/*',
      'node_modules/node-addon-require-builtin-linux-x64-gnu/**/*',
      'node_modules/node-pty/build/Release/**/*',
    ])
    expect(nativeAssetGlobsForTarget(resolveHostTarget('win32', 'x64'))).toEqual([
      'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
      'node_modules/@img/sharp-win32-x64/**/*',
      'node_modules/@koromix/koffi-win32-x64/**/*',
      'node_modules/node-addon-require-builtin-win32-x64-msvc/**/*',
      'node_modules/node-pty/prebuilds/win32-x64/**/*',
    ])
  })

  it.each([
    ['darwin', 'arm64', '@vscode/ripgrep-darwin-arm64', 'rg'],
    ['linux', 'x64', '@vscode/ripgrep-linux-x64', 'rg'],
    ['win32', 'x64', '@vscode/ripgrep-win32-x64', 'rg.exe'],
  ] as const)('selects exactly one ripgrep asset for %s/%s', (platform, architecture, packageName, binaryName) => {
    const asset = ripgrepAssetForTarget(resolveHostTarget(platform, architecture))
    expect(asset).toEqual({
      packageName,
      binaryName,
      relativePath: `node_modules/${packageName}/bin/${binaryName}`,
      vfsPath: `/app/node_modules/${packageName}/bin/${binaryName}`,
    })
  })

  it.each([
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'x64'],
  ] as const)('accepts only the complete %s/%s native VFS closure', (platform, architecture) => {
    const target = resolveHostTarget(platform, architecture)
    const layout = hostNativeLayout(target)
    const stats: Record<string, { size: number; isFile: boolean; isDirectory: boolean }> = {}
    const offsets: Record<string, [number, number]> = {}
    const addFile = (path: string): void => {
      stats[path] = { size: 1, isFile: true, isDirectory: false }
      offsets[path] = [1, 1]
    }
    addFile(layout.ripgrep.vfsPath)
    addFile(`/app/node_modules/${layout.sharpPackage}/lib/sharp.node`)
    if (layout.sharpLibvipsPackage !== undefined) {
      addFile(`/app/node_modules/${layout.sharpLibvipsPackage}/lib/libvips.${platform === 'darwin' ? 'dylib' : 'so.1'}`)
    }
    addFile(`/app/node_modules/${layout.koffiPackage}/native/koffi.node`)
    addFile(`/app/node_modules/${layout.addonRequireBuiltinPackage}/native/addon.node`)
    addFile(`/app/${layout.nodePtyNativeDirectory}/pty.node`)
    if (platform !== 'win32') addFile(`/app/${layout.nodePtyNativeDirectory}/spawn-helper`)
    addFile('/app/node_modules/shiki/dist/onig.wasm')
    const manifest = {
      entrypoint: '/snapshot/app/lib/bin.js',
      entryIsESM: true,
      directories: { '/app': [] },
      stats,
      symlinks: {},
      offsets,
    }
    expect(() => {
      verifyHostNativeVfsManifest(JSON.stringify(manifest), target)
    }).not.toThrow()

    const alien = platform === 'darwin' && architecture === 'arm64'
      ? '/app/node_modules/node-pty/prebuilds/darwin-x64/pty.node'
      : '/app/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
    addFile(alien)
    expect(() => {
      verifyHostNativeVfsManifest(JSON.stringify(manifest), target)
    }).toThrow(
      'non-target native payloads',
    )
    const missingRipgrepManifest = {
      ...manifest,
      stats: Object.fromEntries(Object.entries(stats)
        .filter(([path]) => path !== alien && path !== layout.ripgrep.vfsPath)),
      offsets: Object.fromEntries(Object.entries(offsets)
        .filter(([path]) => path !== alien && path !== layout.ripgrep.vfsPath)),
    }
    expect(() => {
      verifyHostNativeVfsManifest(JSON.stringify(missingRipgrepManifest), target)
    }).toThrow(
      'missing the complete target ripgrep executable',
    )
    const missingWasmManifest = {
      ...manifest,
      stats: Object.fromEntries(Object.entries(stats)
        .filter(([path]) => path !== alien && path !== '/app/node_modules/shiki/dist/onig.wasm')),
      offsets: Object.fromEntries(Object.entries(offsets)
        .filter(([path]) => path !== alien && path !== '/app/node_modules/shiki/dist/onig.wasm')),
    }
    expect(() => {
      verifyHostNativeVfsManifest(JSON.stringify(missingWasmManifest), target)
    }).toThrow('missing the complete shiki Oniguruma wasm runtime')
    if (platform !== 'win32') {
      const spawnHelper = `/app/${layout.nodePtyNativeDirectory}/spawn-helper`
      const missingSpawnHelperManifest = {
        ...manifest,
        stats: Object.fromEntries(Object.entries(stats)
          .filter(([path]) => path !== alien && path !== spawnHelper)),
        offsets: Object.fromEntries(Object.entries(offsets)
          .filter(([path]) => path !== alien && path !== spawnHelper)),
      }
      expect(() => {
        verifyHostNativeVfsManifest(JSON.stringify(missingSpawnHelperManifest), target)
      }).toThrow('missing the complete target node-pty spawn helper')
    }
  })

  it('generates a target-locked SEA extraction bridge for executable rg assets', () => {
    const source = ripgrepSeaEntrypointSource(resolveHostTarget('win32', 'x64'))
    expect(source).toContain('const platformPackage = "@vscode/ripgrep-win32-x64"')
    expect(source).toContain('const binaryName = "rg.exe"')
    expect(source).toContain('process.env.PKG_NATIVE_CACHE_PATH || join(homedir(), \'.cache\')')
    expect(source).toContain('writeFileSync(temporary, bytes')
    expect(source).toContain('export const rgPath = process.pkg === undefined ? snapshotPath : materializeRipgrep()')
    expect(source).not.toContain('ripgrep-win32-arm64')
  })

  it('prunes every non-target native sibling while preserving target addons and shiki wasm', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-native-prune-'))
    const target = resolveHostTarget('darwin', 'arm64')
    const layout = hostNativeLayout(target)
    const addPackage = async (name: string, files: readonly string[]): Promise<void> => {
      const directory = join(fixture, 'node_modules', ...name.split('/'))
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({
        name,
        version: '1.0.0',
        os: ['darwin'],
        cpu: ['arm64'],
      }))
      for (const file of files) {
        const path = join(directory, ...file.split('/'))
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, 'native fixture')
      }
    }
    try {
      await addPackage(layout.ripgrep.packageName, [`bin/${layout.ripgrep.binaryName}`])
      await chmod(join(fixture, ...layout.ripgrep.relativePath.split('/')), 0o755)
      await addPackage(layout.sharpPackage, ['lib/sharp.node'])
      if (layout.sharpLibvipsPackage === undefined) throw new Error('darwin fixture requires libvips')
      await addPackage(layout.sharpLibvipsPackage, ['lib/libvips.dylib'])
      await addPackage(layout.koffiPackage, ['native/koffi.node'])
      await addPackage(layout.addonRequireBuiltinPackage, ['native/addon.node'])

      const ripgrepLoader = join(fixture, 'node_modules', '@vscode', 'ripgrep', 'lib')
      await mkdir(ripgrepLoader, { recursive: true })
      await writeFile(join(ripgrepLoader, 'index.js'), [
        'const arch = process.env.npm_config_arch || process.arch;',
        'const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;',
        'export const rgPath = resolved;',
      ].join('\n'))

      const targetNodePty = join(fixture, ...layout.nodePtyNativeDirectory.split('/'))
      await mkdir(targetNodePty, { recursive: true })
      await writeFile(join(targetNodePty, 'pty.node'), 'target pty')
      await writeFile(join(targetNodePty, 'spawn-helper'), 'target helper')
      for (const alien of [
        'node_modules/@vscode/ripgrep-darwin-x64/bin/rg',
        'node_modules/@img/sharp-win32-x64/lib/sharp.node',
        'node_modules/@koromix/koffi-linux-x64/native/koffi.node',
        'node_modules/node-addon-require-builtin-win32-x64-msvc/native/addon.node',
        'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
        'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
        'node_modules/node-pty/third_party/conpty/win10-x64/conpty.dll',
        'node_modules/node-pty/prebuilds/darwin-arm64/pty.pdb',
      ]) {
        const path = join(fixture, ...alien.split('/'))
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, 'alien payload')
      }
      const shikiWasm = join(fixture, 'node_modules', 'shiki', 'dist', 'onig.wasm')
      await mkdir(join(shikiWasm, '..'), { recursive: true })
      await writeFile(shikiWasm, 'licensed wasm fixture')

      const removed = await pruneHostNativePayloads(fixture, target)
      expect(removed).toEqual(expect.arrayContaining([
        'node_modules/@vscode/ripgrep-darwin-x64',
        'node_modules/@img/sharp-win32-x64',
        'node_modules/@koromix/koffi-linux-x64',
        'node_modules/node-addon-require-builtin-win32-x64-msvc',
        'node_modules/node-pty/prebuilds/darwin-x64',
        'node_modules/node-pty/prebuilds/win32-x64',
        'node_modules/node-pty/third_party',
        'node_modules/node-pty/prebuilds/darwin-arm64/pty.pdb',
      ]))
      await expect(verifyHostNativeStaging(fixture, target)).resolves.toBeUndefined()
      expect(await readFile(shikiWasm, 'utf8')).toBe('licensed wasm fixture')
      const bridge = await readFile(join(ripgrepLoader, 'index.js'), 'utf8')
      expect(bridge).toBe(ripgrepSeaEntrypointSource(target))
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('ships the Linux PTY helper beside the backend', async () => {
    const config = JSON.parse(await readFile(
      new URL('../src-tauri/tauri.linux.conf.json', import.meta.url),
      'utf8',
    )) as { bundle?: { externalBin?: unknown } }
    expect(config.bundle?.externalBin).toEqual([
      'binaries/dsh-backend',
      'binaries/dsh-backend-spawn-helper',
    ])
  })

  it('declares the real macOS runtime floor and numeric bundle versions', async () => {
    const config = JSON.parse(await readFile(
      new URL('../src-tauri/tauri.macos.conf.json', import.meta.url),
      'utf8',
    )) as {
      bundle?: {
        macOS?: {
          bundleVersion?: unknown
          infoPlist?: unknown
          minimumSystemVersion?: unknown
        }
      }
    }
    expect(config.bundle?.macOS).toMatchObject({
      bundleVersion: '108',
      infoPlist: 'Info.plist',
      minimumSystemVersion: '15.0',
    })
    const infoPlist = await readFile(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8')
    expect(infoPlist).toContain('<key>CFBundleShortVersionString</key>')
    expect(infoPlist).toContain('<string>0.1.0</string>')
  })
})

describe('desktop native-binary validation', () => {
  it('recognizes only supported 64-bit little-endian Linux ELF machines', () => {
    const elf = (machine: number): Uint8Array => {
      const bytes = new Uint8Array(64)
      bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
      new DataView(bytes.buffer).setUint16(18, machine, true)
      return bytes
    }
    expect(readLinuxElfArchitecture(elf(0x3e))).toBe('x64')
    expect(readLinuxElfArchitecture(elf(0xb7))).toBe('arm64')
    expect(() => readLinuxElfArchitecture(elf(0x28))).toThrow('unsupported machine 0x28')
    expect(() => readLinuxElfArchitecture(new Uint8Array(64))).toThrow('not an ELF image')
  })

  it('reads the PE certificate table and rejects malformed images', () => {
    const pe = (certificateOffset: number, certificateSize: number): Uint8Array => {
      const bytes = new Uint8Array(512)
      const view = new DataView(bytes.buffer)
      bytes.set([0x4d, 0x5a])
      view.setUint32(0x3c, 0x80, true)
      view.setUint32(0x80, 0x0000_4550, true)
      view.setUint16(0x80 + 20, 240, true)
      const optionalHeader = 0x80 + 24
      view.setUint16(optionalHeader, 0x20b, true)
      view.setUint32(optionalHeader + 108, 16, true)
      const certificateEntry = optionalHeader + 112 + 4 * 8
      view.setUint32(certificateEntry, certificateOffset, true)
      view.setUint32(certificateEntry + 4, certificateSize, true)
      return bytes
    }
    expect(readPeCertificateTable(pe(0, 0))).toEqual({ fileOffset: 0, size: 0 })
    expect(readPeCertificateTable(pe(400, 32))).toEqual({ fileOffset: 400, size: 32 })
    expect(() => readPeCertificateTable(pe(400, 0))).toThrow('malformed certificate-table entry')
    expect(() => readPeCertificateTable(new Uint8Array(64))).toThrow('not a PE image')
  })

  it('finds PATH signtool first and otherwise selects the newest Windows SDK', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-signtool-'))
    try {
      const pathDirectory = join(fixture, 'path-bin')
      const sdkBin = join(fixture, 'Windows Kits', '10', 'bin')
      const older = join(sdkBin, '10.0.22621.0', 'x64')
      const newer = join(sdkBin, '10.0.26100.0', 'x64')
      await mkdir(pathDirectory, { recursive: true })
      await mkdir(older, { recursive: true })
      await mkdir(newer, { recursive: true })
      const pathTool = join(pathDirectory, 'signtool.exe')
      const olderTool = join(older, 'signtool.exe')
      const newerTool = join(newer, 'signtool.exe')
      await writeFile(pathTool, '')
      await writeFile(olderTool, '')
      await writeFile(newerTool, '')

      expect(await locateWindowsSignTool({
        PATH: pathDirectory,
        'ProgramFiles(x86)': fixture,
      })).toBe(pathTool)
      await rm(pathTool)
      expect(await locateWindowsSignTool({
        PATH: '',
        'ProgramFiles(x86)': fixture,
      })).toBe(newerTool)
      expect([
        '10.0.22621.0',
        'preview',
        '10.0.26100.0',
      ].sort(compareWindowsSdkVersionsDescending)).toEqual([
        '10.0.26100.0',
        '10.0.22621.0',
        'preview',
      ])
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

describe('desktop build phases and bundles', () => {
  it('accepts native bundle formats and preserves the ordinary all-in-one build', () => {
    expect(parseBuildCli([], 'linux')).toEqual({
      help: false,
      prepareOnly: false,
      skipPrepare: false,
      tauriArgs: ['--bundles', 'deb'],
    })
    expect(parseBuildCli(['--skip-prepare', '--bundles', 'deb'], 'linux')).toEqual({
      help: false,
      prepareOnly: false,
      skipPrepare: true,
      tauriArgs: ['--bundles', 'deb'],
    })
    expect(parseBuildCli(['--bundles', 'dmg'], 'darwin').tauriArgs).toEqual(['--bundles', 'dmg'])
    expect(parseBuildCli(['--', '--bundles', 'dmg'], 'darwin').tauriArgs).toEqual(['--bundles', 'dmg'])
    expect(parseBuildCli(['--bundles', 'nsis'], 'win32').tauriArgs).toEqual(['--bundles', 'nsis'])
    expect(parseBuildCli([], 'win32').tauriArgs).toEqual(['--bundles', 'nsis'])
    expect(parseBuildCli([], 'darwin').tauriArgs).toEqual(['--bundles', 'app,dmg'])
  })

  it('keeps preparation separate from bundling and rejects cross-platform formats', () => {
    expect(parseBuildCli(['--prepare-only'], 'linux')).toMatchObject({ prepareOnly: true, skipPrepare: false })
    expect(() => parseBuildCli(['--prepare-only', '--bundles', 'deb'], 'linux')).toThrow(
      '--prepare-only does not accept --bundles',
    )
    expect(() => parseBuildCli(['--prepare-only', '--skip-prepare'], 'linux')).toThrow('mutually exclusive')
    expect(() => parseBuildCli(['--bundles', 'dmg'], 'linux')).toThrow('unsupported linux bundle format dmg')
    expect(() => parseBuildCli(['--bundles', 'appimage'], 'linux')).toThrow('unsupported linux bundle format appimage')
    expect(() => parseBuildCli(['--bundles', 'msi'], 'win32')).toThrow('unsupported win32 bundle format msi')
  })
})

describe('desktop Anthropic redistribution boundary', () => {
  it('removes the restricted SDK and platform packages and rejects any Claude executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-claude-payload-'))
    try {
      const anthropic = join(root, 'node_modules', '@anthropic-ai')
      const sdk = join(anthropic, 'claude-agent-sdk')
      const platform = join(anthropic, 'claude-agent-sdk-linux-x64')
      const unrelated = join(root, 'node_modules', 'unrelated')
      await mkdir(sdk, { recursive: true })
      await mkdir(platform, { recursive: true })
      await mkdir(unrelated, { recursive: true })
      await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk' }))
      await writeFile(join(sdk, 'sdk.mjs'), 'export {}\n')
      await writeFile(join(platform, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk-linux-x64' }))
      await writeFile(join(platform, 'claude'), 'official payload\n')
      await writeFile(join(unrelated, 'claude.exe'), 'official payload\n')

      expect(await findRestrictedClaudePayloads(root)).toEqual([
        sdk,
        `${join(sdk, 'package.json')} (@anthropic-ai/claude-agent-sdk)`,
        platform,
        join(platform, 'claude'),
        `${join(platform, 'package.json')} (@anthropic-ai/claude-agent-sdk-linux-x64)`,
        join(unrelated, 'claude.exe'),
      ].sort())
      expect(await pruneRestrictedClaudePackages(root)).toEqual([platform, sdk].sort())
      expect(await findRestrictedClaudePayloads(root)).toEqual([join(unrelated, 'claude.exe')])
      await rm(join(unrelated, 'claude.exe'))
      expect(await findRestrictedClaudePayloads(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
