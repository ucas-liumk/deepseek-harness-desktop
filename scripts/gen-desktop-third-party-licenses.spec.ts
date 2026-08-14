import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cachedNodeVersion,
  fetchPinnedBytes,
  generateDesktopLicenseBundle,
  nodePtyNoticeRequirements,
  reviewedPkgBootstrapPackages,
  ripgrepCargoCrateIds,
  sharpLibvipsNoticeComponents,
  sharpLibvipsSourceComponentNames,
  sharpLibvipsVersions,
  verifyDesktopLicenseBundle,
  type LicenseManifestEntry,
} from './gen-desktop-third-party-licenses.ts'

const MIT = `MIT License

Copyright (c) Fixture Author

Permission is hereby granted, free of charge, to any person obtaining a copy.
`
const WEBVIEW2_COM_MACROS_LICENSE = `MIT License

Copyright (c) 2021 Bill Avery

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

interface Fixture {
  readonly root: string
  readonly npm: string
  readonly cargo: string
  readonly output: string
  readonly cargoLock: string
  readonly projectLicense: string
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-licenses-'))
  const npm = join(root, 'npm')
  const cargo = join(root, 'cargo-dependency')
  const output = join(root, 'output')
  const cargoLock = join(root, 'Cargo.lock')
  const projectLicense = join(root, 'LICENSE')
  await mkdir(npm, { recursive: true })
  await mkdir(cargo, { recursive: true })
  await writeFile(join(npm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', license: 'MIT' }))
  await writeFile(cargoLock, 'version = 4\n')
  await writeFile(projectLicense, MIT)
  return { root, npm, cargo, output, cargoLock, projectLicense }
}

async function npmPackage(root: string, name: string, manifest: Record<string, unknown>, license?: string): Promise<string> {
  const directory = name.startsWith('@')
    ? join(root, 'node_modules', ...name.split('/'))
    : join(root, 'node_modules', name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, ...manifest }))
  if (license !== undefined) await writeFile(join(directory, 'LICENSE'), license)
  return directory
}

function cargoMetadata(cargoDirectory: string, license = 'MIT'): Parameters<typeof generateDesktopLicenseBundle>[0]['cargoMetadata'] {
  return {
    workspace_members: ['desktop 1.0.0 (path+file:///desktop)'],
    resolve: {
      nodes: [
        { id: 'desktop 1.0.0 (path+file:///desktop)' },
        { id: 'dependency 2.0.0 (registry+https://github.com/rust-lang/crates.io-index)' },
      ],
    },
    packages: [
      {
        id: 'desktop 1.0.0 (path+file:///desktop)',
        name: 'desktop',
        version: '1.0.0',
        license: null,
        license_file: null,
        authors: [],
        repository: null,
        homepage: null,
        source: null,
        manifest_path: '/desktop/Cargo.toml',
      },
      {
        id: 'dependency 2.0.0 (registry+https://github.com/rust-lang/crates.io-index)',
        name: 'dependency',
        version: '2.0.0',
        license,
        license_file: null,
        authors: ['Rust Author'],
        repository: 'https://example.test/rust-dependency',
        homepage: null,
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        manifest_path: join(cargoDirectory, 'Cargo.toml'),
      },
    ],
  }
}

type GenerateOverrides = Pick<
  Parameters<typeof generateDesktopLicenseBundle>[0],
  'pinnedTextCache' | 'pinnedTextFetch'
>

async function generate(
  row: Fixture,
  metadata = cargoMetadata(row.cargo),
  overrides: GenerateOverrides = {},
): Promise<LicenseManifestEntry[]> {
  return await generateDesktopLicenseBundle({
    npmRoot: row.npm,
    cargoMetadata: metadata,
    cargoLock: row.cargoLock,
    projectLicense: row.projectLicense,
    output: row.output,
    rustTarget: 'fixture-target',
    ...overrides,
  })
}

describe('desktop third-party license bundle', () => {
  const retryPolicy = {
    maxAttempts: 4,
    attemptTimeoutMs: 12_345,
    retryDelaysMs: [10, 20, 30],
    maxResponseBytes: 32,
  } as const

  it('retries only transient HTTP and network failures with fixed limits and delays', async () => {
    const delays: number[] = []
    const signals: AbortSignal[] = []
    const results: (Response | Error)[] = [
      new TypeError('connection reset'),
      new Response('busy', { status: 429 }),
      new Response('gateway', { status: 503 }),
      new Response('fixed bytes'),
    ]
    const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
      signals.push(init.signal as AbortSignal)
      const result = results.shift()
      if (result instanceof Error) throw result
      if (result === undefined) throw new Error('unexpected extra attempt')
      return result
    }

    await expect(fetchPinnedBytes('https://example.test/source', retryPolicy, {
      fetch,
      sleep: async (delay) => { delays.push(delay) },
    })).resolves.toEqual(Buffer.from('fixed bytes'))
    expect(delays).toEqual([10, 20, 30])
    expect(signals).toHaveLength(4)
    expect(signals.every(signal => signal instanceof AbortSignal)).toBe(true)
  })

  it('retries a transient response body failure', async () => {
    let attempts = 0
    const delays: number[] = []
    const fetch = async (): Promise<Response> => {
      attempts += 1
      if (attempts === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.error(new TypeError('socket closed while reading body'))
          },
        }))
      }
      return new Response('complete')
    }
    await expect(fetchPinnedBytes('https://example.test/source', retryPolicy, {
      fetch,
      sleep: async (delay) => { delays.push(delay) },
    })).resolves.toEqual(Buffer.from('complete'))
    expect(attempts).toBe(2)
    expect(delays).toEqual([10])
  })

  it('fails fast for permanent HTTP, invalid bodies, and invalid policy', async () => {
    let attempts = 0
    const delays: number[] = []
    await expect(fetchPinnedBytes('https://example.test/missing', retryPolicy, {
      fetch: async () => {
        attempts += 1
        return new Response('missing', { status: 404 })
      },
      sleep: async (delay) => { delays.push(delay) },
    })).rejects.toThrow('HTTP 404')
    expect(attempts).toBe(1)
    expect(delays).toEqual([])

    await expect(fetchPinnedBytes('data:,', retryPolicy, {
      fetch: async () => new Response(''),
    })).rejects.toThrow('response is empty')
    await expect(fetchPinnedBytes('data:,too-large', retryPolicy, {
      fetch: async () => new Response('x'.repeat(33)),
    })).rejects.toThrow('exceeds 32 bytes')
    await expect(fetchPinnedBytes('data:,bad-policy', {
      ...retryPolicy,
      maxAttempts: 3,
    })).rejects.toThrow('invalid bounded fetch retry policy')
  })

  it('stops after the configured number of transient failures', async () => {
    let attempts = 0
    const delays: number[] = []
    await expect(fetchPinnedBytes('https://example.test/flaky', retryPolicy, {
      fetch: async () => {
        attempts += 1
        throw new DOMException('request timed out', 'TimeoutError')
      },
      sleep: async (delay) => { delays.push(delay) },
    })).rejects.toThrow('fetch failed after 4 attempts: TimeoutError: request timed out')
    expect(attempts).toBe(4)
    expect(delays).toEqual([10, 20, 30])
  })

  it('pins target-exact ripgrep Cargo closures and derives Windows terminal notices after pruning', () => {
    expect(ripgrepCargoCrateIds('aarch64-apple-darwin')).toHaveLength(40)
    expect(ripgrepCargoCrateIds('x86_64-unknown-linux-gnu')).toHaveLength(40)
    const windows = ripgrepCargoCrateIds('x86_64-pc-windows-msvc')
    expect(windows).toHaveLength(44)
    expect(new Set(windows).size).toBe(44)
    expect(windows).toContain('windows-sys@0.61.2')
    expect(nodePtyNoticeRequirements('aarch64-apple-darwin', [])).toEqual([])
    expect(nodePtyNoticeRequirements('x86_64-unknown-linux-gnu', [])).toEqual([])
    expect(nodePtyNoticeRequirements('x86_64-pc-windows-msvc', [
      'prebuilds/win32-x64/conpty/conpty.dll',
      'prebuilds/win32-x64/conpty/OpenConsole.exe',
      'prebuilds/win32-x64/winpty.dll',
      'prebuilds/win32-x64/winpty-agent.exe',
    ])).toEqual([
      'deps/winpty/LICENSE',
      'Microsoft-Terminal/LICENSE',
      'Microsoft-Terminal/NOTICE.md',
    ])
    expect(() => nodePtyNoticeRequirements('x86_64-pc-windows-msvc', [
      'prebuilds/win32-x64/conpty/conpty.dll',
    ])).toThrow('Windows node-pty native payload is incomplete')
  })

  it('parses the complete 28-component sharp-libvips version provenance fail closed', () => {
    const properties = Array.from({ length: 28 }, (_, index) => `VERSION_COMPONENT_${String(index)}=${String(index)}.0`).join('\n')
    expect(Object.keys(sharpLibvipsVersions(properties))).toHaveLength(28)
    expect(() => sharpLibvipsVersions(properties.split('\n').slice(1).join('\n'))).toThrow(
      'expected 28 sharp-libvips component versions',
    )
    expect(() => sharpLibvipsVersions(`${properties}\nnot-a-version`)).toThrow('malformed sharp-libvips versions line')
  })

  it('maps all 29 sharp-libvips notice rows to target-exact source and original terms', () => {
    const expected = [
      'aom', 'cairo', 'cgif', 'expat', 'fontconfig', 'freetype', 'fribidi', 'glib',
      'harfbuzz', 'highway', 'lcms', 'libarchive', 'libexif', 'libffi', 'libheif',
      'libimagequant', 'libnsgif', 'libpng', 'librsvg', 'libtiff', 'libultrahdr',
      'libvips', 'libwebp', 'libxml2', 'mozjpeg', 'pango', 'pixman', 'proxy-libintl',
      'zlib-ng',
    ]
    const notice = [
      '| Library | Used under the terms of |',
      '|---|---|',
      ...expected.map(component => `| ${component} | reviewed fixture |`),
    ].join('\n')
    expect(sharpLibvipsNoticeComponents(notice)).toEqual([...expected].sort())
    expect(() => sharpLibvipsNoticeComponents(notice.replace('| aom | reviewed fixture |\n', ''))).toThrow(
      'notice component closure changed',
    )
    for (const target of [
      'aarch64-apple-darwin',
      'x86_64-unknown-linux-gnu',
      'x86_64-pc-windows-msvc',
    ]) {
      const components = sharpLibvipsSourceComponentNames(target)
      expect(components).toEqual([...expected].sort())
      expect(new Set(components).size).toBe(29)
    }
  })

  it('pins every package marker embedded in the pkg SEA bootstrap', () => {
    expect(reviewedPkgBootstrapPackages([
      '// node_modules/@roberts_lando/vfs/lib/errors.js',
      '// node_modules/@roberts_lando/vfs/index.js',
    ].join('\n'))).toEqual(['@roberts_lando/vfs'])
    expect(() => reviewedPkgBootstrapPackages([
      '// node_modules/@roberts_lando/vfs/index.js',
      '// node_modules/unreviewed-runtime/index.js',
    ].join('\n'))).toThrow('unreviewed: unreviewed-runtime')
    expect(() => reviewedPkgBootstrapPackages('// prelude/sea-vfs-setup.js')).toThrow(
      'missing: @roberts_lando/vfs',
    )
    expect(() => reviewedPkgBootstrapPackages([
      '// node_modules/@roberts_lando/vfs/index.js',
      '// node_modules/',
    ].join('\n'))).toThrow('malformed pkg bootstrap package marker')
  })

  it('does not derive the embedded runtime from a different pkg-fetch patch version', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'desktop-node-cache-'))
    try {
      const archive = join(cache, 'node-v24.19.0-darwin-arm64.tar.gz')
      await writeFile(archive, 'fixture')
      await writeFile(`${archive}.ok`, '')
      await expect(cachedNodeVersion('aarch64-apple-darwin', '24.18.0', cache)).rejects.toThrow(
        'expected one verified Node 24.18.0 SEA archive',
      )
      await expect(cachedNodeVersion('aarch64-apple-darwin', '24.19.0', cache)).resolves.toBe('v24.19.0')
    }
    finally {
      await rm(cache, { recursive: true, force: true })
    }
  })

  it('records the exact npm package roots and resolved Rust closure with verifiable hashes', async () => {
    const row = await fixture()
    try {
      const packageDirectory = await npmPackage(row.npm, 'runtime-dependency', {
        version: '3.0.0',
        license: 'MIT',
        author: 'Npm Author',
      }, MIT)
      await mkdir(join(packageDirectory, 'fixtures'), { recursive: true })
      await writeFile(join(packageDirectory, 'fixtures/package.json'), JSON.stringify({
        name: 'not-a-package-root',
        version: '99.0.0',
      }))
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE-MIT'), MIT)

      const entries = await generate(row)
      expect(entries.map(entry => `${entry.ecosystem}:${entry.name}@${entry.version}`)).toEqual([
        'cargo:dependency@2.0.0',
        'npm:@deepseek-ai/dsh@1.0.0',
        'npm:runtime-dependency@3.0.0',
      ])
      expect(entries.some(entry => entry.name === 'not-a-package-root')).toBe(false)
      expect(entries.find(entry => entry.name === '@deepseek-ai/dsh')?.files[0]?.origin).toBe('project-license')
      await expect(verifyDesktopLicenseBundle(row.output)).resolves.toBeUndefined()
      const manifest = JSON.parse(await readFile(join(row.output, 'manifest.json'), 'utf8')) as { cargoLockSha256: string }
      expect(manifest.cargoLockSha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(row.root, { recursive: true, force: true })
    }
  })

  it('copies fixed source artifacts into the offline checksum inventory', async () => {
    const row = await fixture()
    try {
      const source = Buffer.from('fixed corresponding source fixture\n')
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE'), MIT)
      await generateDesktopLicenseBundle({
        npmRoot: row.npm,
        cargoMetadata: cargoMetadata(row.cargo),
        cargoLock: row.cargoLock,
        projectLicense: row.projectLicense,
        output: row.output,
        rustTarget: 'fixture-target',
        sourceArtifactCache: join(row.root, 'source-cache'),
        sourceArtifacts: [{
          name: 'fixture-source.txt',
          version: '1.0.0',
          repository: 'https://example.test/source',
          revision: 'fixture-revision',
          url: `data:application/octet-stream;base64,${source.toString('base64')}`,
          expectedSha256: createHash('sha256').update(source).digest('hex'),
          purpose: 'unit-test source artifact',
          relatedPackages: ['npm:@deepseek-ai/dsh@1.0.0'],
        }],
      })
      const manifest = JSON.parse(await readFile(join(row.output, 'manifest.json'), 'utf8')) as {
        sourceArtifactCount: number
        sourceArtifacts: { path: string; sha256: string }[]
      }
      expect(manifest.sourceArtifactCount).toBe(1)
      expect(manifest.sourceArtifacts[0]?.path).toBe('source-artifacts/fixture-source.txt')
      expect(manifest.sourceArtifacts[0]?.sha256).toBe(createHash('sha256').update(source).digest('hex'))
      await expect(verifyDesktopLicenseBundle(row.output)).resolves.toBeUndefined()
    } finally {
      await rm(row.root, { recursive: true, force: true })
    }
  })

  it('fails closed for forbidden or unknown SPDX terms', async () => {
    const row = await fixture()
    try {
      await npmPackage(row.npm, 'forbidden', { version: '1.0.0', license: 'GPL-3.0-only' }, 'GPL text\n')
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE'), MIT)
      await expect(generate(row)).rejects.toThrow('unreviewed or forbidden SPDX term GPL-3.0-only')
    } finally {
      await rm(row.root, { recursive: true, force: true })
    }
  })

  it('packages original text for the reviewed Apache-2.0 WITH LLVM-exception pair', async () => {
    const row = await fixture()
    const licenseText = `Apache License
Version 2.0, January 2004

LLVM Exceptions to the Apache 2.0 License
`
    try {
      await npmPackage(row.npm, 'llvm-exception-runtime', {
        version: '1.0.0',
        license: 'Apache-2.0 WITH LLVM-exception',
      }, licenseText)
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE'), MIT)

      const entries = await generate(row)
      const entry = entries.find(candidate => candidate.name === 'llvm-exception-runtime')
      expect(entry?.licenseExpression).toBe('Apache-2.0 WITH LLVM-exception')
      expect(entry?.files).toHaveLength(1)
      expect(entry?.files[0]?.origin).toBe('package')
      expect(await readFile(join(row.output, entry?.files[0]?.path ?? ''), 'utf8')).toBe(licenseText)
      await expect(verifyDesktopLicenseBundle(row.output)).resolves.toBeUndefined()
    } finally {
      await rm(row.root, { recursive: true, force: true })
    }
  })

  it('rejects unknown or mismatched SPDX exceptions and plus suffixes', async () => {
    const cases = [
      {
        expression: 'Apache-2.0 WITH GCC-exception-3.1',
        message: 'SPDX exception GCC-exception-3.1 for Apache-2.0',
      },
      {
        expression: 'MIT WITH LLVM-exception',
        message: 'SPDX exception LLVM-exception for MIT',
      },
      {
        expression: 'MIT+',
        message: 'SPDX term MIT+',
      },
    ]
    for (const { expression, message } of cases) {
      const row = await fixture()
      try {
        await npmPackage(row.npm, 'unreviewed-expression', {
          version: '1.0.0',
          license: expression,
        }, 'Unreviewed license text.\n')
        await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
        await writeFile(join(row.cargo, 'LICENSE'), MIT)
        await expect(generate(row)).rejects.toThrow(message)
      } finally {
        await rm(row.root, { recursive: true, force: true })
      }
    }
  })

  it('packages only the fixed upstream LICENSE for webview2-com-macros 0.8.1', async () => {
    const row = await fixture()
    const macroDirectory = join(row.root, 'webview2-com-macros')
    const pinnedTextCache = join(row.root, 'pinned-text')
    const cachedLicense = join(pinnedTextCache, 'webview2-com-macros-0.8.1-LICENSE')
    try {
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE'), MIT)
      await mkdir(macroDirectory, { recursive: true })
      await writeFile(join(macroDirectory, 'Cargo.toml'), '[package]\nname = "webview2-com-macros"\nversion = "0.8.1"\n')
      await mkdir(pinnedTextCache, { recursive: true })
      await writeFile(cachedLicense, WEBVIEW2_COM_MACROS_LICENSE)
      expect(createHash('sha256').update(WEBVIEW2_COM_MACROS_LICENSE).digest('hex')).toBe(
        '0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73',
      )

      const metadataForVersion = (
        version: string,
        license = 'MIT',
        repository = 'https://github.com/wravery/webview2-rs',
      ) => {
        const metadata = cargoMetadata(row.cargo)
        const id = `webview2-com-macros ${version} (registry+https://github.com/rust-lang/crates.io-index)`
        return {
          ...metadata,
          resolve: {
            nodes: [...(metadata.resolve?.nodes ?? []), { id }],
          },
          packages: [
            ...metadata.packages,
            {
              id,
              name: 'webview2-com-macros',
              version,
              license,
              license_file: null,
              authors: ['Bill Avery'],
              repository,
              homepage: null,
              source: 'registry+https://github.com/rust-lang/crates.io-index',
              manifest_path: join(macroDirectory, 'Cargo.toml'),
            },
          ],
        }
      }

      let offlineFetchCalls = 0
      const entries = await generate(row, metadataForVersion('0.8.1'), {
        pinnedTextCache,
        pinnedTextFetch: async () => {
          offlineFetchCalls += 1
          throw new Error('offline fixture must use its verified cache')
        },
      })
      expect(offlineFetchCalls).toBe(0)
      const entry = entries.find(candidate => candidate.name === 'webview2-com-macros')
      expect(entry?.files).toHaveLength(1)
      expect(entry?.files[0]).toMatchObject({
        origin: 'pinned-upstream',
        sourceName: 'webview2-com-macros-0.8.1-LICENSE',
        sourcePackage: 'cargo:webview2-com-macros@0.8.1',
        sha256: '0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73',
      })
      expect(entry?.files[0]?.licenseId).toBeUndefined()
      expect(entry?.copyrightLines).toContain('Copyright (c) 2021 Bill Avery')
      const outputLicense = join(row.output, entry?.files[0]?.path ?? '')
      expect(await readFile(outputLicense, 'utf8')).toBe(WEBVIEW2_COM_MACROS_LICENSE)
      await expect(verifyDesktopLicenseBundle(row.output)).resolves.toBeUndefined()

      await writeFile(outputLicense, `${WEBVIEW2_COM_MACROS_LICENSE}tampered\n`)
      await expect(verifyDesktopLicenseBundle(row.output)).rejects.toThrow('checksum mismatch')

      await expect(generate(row, metadataForVersion('0.8.2'), { pinnedTextCache })).rejects.toThrow(
        'cargo:webview2-com-macros@0.8.2 needs a reviewed upstream license-text pin',
      )
      await expect(generate(row, metadataForVersion('0.8.1', 'Apache-2.0'), { pinnedTextCache })).rejects.toThrow(
        'cargo:webview2-com-macros@0.8.1 does not match its reviewed MIT registry provenance',
      )
      await expect(generate(
        row,
        metadataForVersion('0.8.1', 'MIT', 'https://example.test/wrong-repository'),
        { pinnedTextCache },
      )).rejects.toThrow(
        'cargo:webview2-com-macros@0.8.1 does not match its reviewed MIT registry provenance',
      )

      await writeFile(cachedLicense, 'changed upstream text\n')
      let changedFetchCalls = 0
      await expect(generate(row, metadataForVersion('0.8.1'), {
        pinnedTextCache,
        pinnedTextFetch: async () => {
          changedFetchCalls += 1
          return new Response('changed upstream text\n')
        },
      })).rejects.toThrow('pinned license source changed or was corrupted')
      expect(changedFetchCalls).toBe(1)
    } finally {
      await rm(row.root, { recursive: true, force: true })
    }
  })

  it('fails when a package has neither original text nor a reviewed donor', async () => {
    const row = await fixture()
    try {
      await npmPackage(row.npm, 'missing-license-text', { version: '1.0.0', license: 'ISC' })
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE'), MIT)
      await expect(generate(row)).rejects.toThrow('has no original license/notice text or reviewed same-repository donor')
    } finally {
      await rm(row.root, { recursive: true, force: true })
    }
  })

  it('accepts reviewed weak-copyleft text but detects any post-generation mutation', async () => {
    const row = await fixture()
    try {
      await npmPackage(row.npm, 'weak-copyleft-runtime', {
        version: '1.0.0',
        license: 'LGPL-3.0-or-later',
        author: 'Sharp Author',
      }, 'Original LGPL license text.\n')
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE'), MIT)
      const entries = await generate(row)
      expect(entries.find(entry => entry.name === 'weak-copyleft-runtime')?.files[0]?.origin).toBe('package')
      await writeFile(join(row.output, 'README.md'), 'tampered\n')
      await expect(verifyDesktopLicenseBundle(row.output)).rejects.toThrow('checksum mismatch for README.md')
    } finally {
      await rm(row.root, { recursive: true, force: true })
    }
  })
})
