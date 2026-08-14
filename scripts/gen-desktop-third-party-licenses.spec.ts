import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
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
const CARGO_REGISTRY_SOURCE = 'registry+https://github.com/rust-lang/crates.io-index'
const DLOPEN2_COMMIT = 'cc80e4a0a90d499b677fdf7743699b4b3a43a989'
const DLOPEN2_LICENSE_NAME = `dlopen2-${DLOPEN2_COMMIT}-LICENSE`
const DLOPEN2_LICENSE = `MIT License

Copyright (c) 2017 Szymon Wieloch
Copyright (C) 2019 Ahmed Masud <ahmed.masud@saf.ai>
Copyright (C) 2022 OpenByte <development.openbyte@gmail.com>

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

// Exact eafd1e3 LICENSE-APACHE bytes, Brotli-compressed to keep this fixture compact.
const LIBAPPINDICATOR_APACHE_LICENSE = brotliDecompressSync(Buffer.from(`
G14qAKwGbFtoPdg0pbkNJg+uoJ9jq1UjsJ1P6G800YGMAinuLgr+/9XpXC+Tj6YibyGSQzC98C/oBrAUQMxUdf9l+qTjDpKzZ5qb
CqzQhcwBdEG6gMAQapt/o96gHamsuI3g19ssD0xQubOQOEzd3a+7SrOzPEujkQwI3f1nz5JRJ5NONkcH8QWJASt3Fm+QpV6GqjtJ
5+6dBIQQQs+A7fXj217dKy1/xlVC3xUQarpnz0xFI3PfafQAVOHVlAlXJVD4cOzg7IUspHz2PKXiLcYvXCBBfmRY0fCPI0+uOcGr
ICYXOseSNZl3OVDS8UTMThvq4mHVa1g/ebL7gBq7mqfq7il+RWQ4pYMI1fzmd6s9FpRH4Fj5Eyk4X3h8Bk+BlMtNuyt1O8WbyJ4t
TFUu4QACnwAnyBC4Q/JpgYDK/zYsFhljHsqfF6Nx/mGNr9yZCe11wHJFk9pKdvVox9Qe01Bp9VvpC1a/xtJ2e2my7E2ZGOwZ0Prn
V+sdnIh/j4FMvAAGyFCDBViNPj9oKhE8D+Ct48L+5NKKKHBYP3+d9vNXXb59PMKBcQCLl7qEHyNJurtOJyQfoUQNv23A98hL/E+L
/ig/ohhyBkgOlIIepojjMNgBG1JvRlOyxjrSMrKbiTQ0CRGktrgeu7HUXDBopw6qFCP6DO3DHHeHaHiEW+5u7OWYawNqYak3MlTz
75Pe2rHvJUDAWgLu7S1o4duHaNmWgld/sgoaW0XVS0zbtYIa5aOEOq6WtEoW7LjHQXEp6jNv6BBVwVVoT3Usf0NKAAIXfPGN9jU1
8dH1qJhJeqzhuvt+rAOjki7N7pmDdxaGEoX1LKCUHz/+FH15W2q1srqWu3e8ltL/UnamXKderkZETMf9BjV7lB1bB94rzHaIsafh
kQdXiuTFFWSaGhq46bsqN91/dx3+OPSspvibwgBBsanQLduVn/GNabp3VFtGoYoLTHUMXq0CU7Th1gW6b4QnExfB7KfAHE9EFYQP
LsHm/0yjJHGIEUbLXySZ5fgaq54lHs/UHTGZg8SyWNP2lTzO0N44reAymVtjRG6GtUxhVig4tVgLIyK0pYrvFQiRp30xwO3oKO4i
N8bgdCob8GcGmoG7j/Vzx+fenyuVe6j+nH6C4+9J/iFup490cQr65d1uqN0OfTLeOkMu6hOh/tXzdNJwakU9hWjdMD1hCKLbvI2o
3t7dyE+BWVAcRBQqRM/mwUl8X2OyCoRw48OsjKs2jmN0bmSVhRCDwvAo4A6x0hPVFqo6pU9Z4nqrKD3YarWl89bCx2Ia4bklYr9v
ubRLnJIzOYeJZBYwJht0hj4kdxRq6DxL3bY4b3xsn5mUqyW2FtZfJolYIxtzkuWHMxhVl18ZMjoTuEiCdiR+dkXp0yM8GxRrhgRJ
qdDjxnzqp0OgGUXuSlYZjxgK3NqeU7r6z8EdHPBRdzXzf+uX6aRaGNLjgToM7TIMDJPVs4560HMY3uVlxu3alP6k98UatVS3qW3u
3px1gSfLdWPHfPL2t1gwwJVbLWvUklTMNp4qImuaX7H75e3HI7xUyf91XWt1wxUokEUTMXjQ/YfCVTG1vrAGCdL9WQBjcFhB5TFK
abQm+Z0YRaQqrHmrT0JpXQpFRZda0TzhdoNxkj0cAEysIXi8lmvrnFOJKFUW6N0yB9b9gVwKTzm3OGjP7XuId0a6ssT+Ic9Ltxa1
Y3uZ4qR3ClrMY3xUHAriZmle3Y8Dw41MWDUMe9kAgIdqpKY67KxAEHKf3rSIAUsdMZgDD05Za3CdVqgjKGNMKejowBMG159defem
qLFIaGJSHXWWCDUgyi2NZUMfAslBLoS6h5YAKT+0IfRVEHvA33WMj1d3A7Z0QCNSg8oMpVs2+tiV6zmvas4mpOCMF/6VfCpjK+aP
BIM5lPS1TSuwWL/g2oF/pWo9aKaPcq69+NKOXrEHaIhCA83Y7o6yb4UisyIlPNhH9/mZu8gsl1o43dSMlhewEntPxfjBJ/yS423G
sHnQF/Ud8CDG7OcxeyK0tNXIHE42K7B3s3NCPt/bTjCZcK3SKxCqkiDDk5YL2Vp2vuYH2nZsXWNCvTN61BmuOaTi/cwokyjzJWgi
X5wiToEFIhH54Fdsf7CaeQlb7iiNDr/jCpF3qgFTV0wnSxWtC8BYcf/jm8lXSxh20QK7tmgK7QZtuojVIjq5hjQtHPL2w5vZtGpx
3mdSxqV5PpAOmJM0dSkDQ/+JFZlIpw9Oyx+YqoKRXD/Oe2mEclm9FMham0ewYcZKFHBerkqkmFOTNdc4QvOuhWsk/rlCBsugqK0V
yBciv0vYWUtL0E5+eDV/ZQdDNbgftTbUxymngFydOAluQ/UOKV2BP5HQUF4gQjhgUN/Cf6bTKG0s/0Dv+udznPyV9JCMQg3MHJ7Y
13RvEisOqy5xpudnra6Xs/wYqQPMApzBKjBwKMGqc02VG4t5g231HoHQgJCikb6MFy/M2xjv/JjYhQH5nArgD9DuIq4EnX9ZfP42
wBuyNDyvBVjooUiH23VZ/I9mLECMglPey/Sae2Fil2lSrz9XL6AZNWpY+VIZ3FdB9aZaYBDueBQxmOqHqsm57SRJBwJsBNOZQGL7
8Vs/Yw9kbMovs4FA8qrHVthTqAJ5j7gnDqQxi9tgfDkY9lm6RwQPTgqHJ+tQTamAsffz1WGrEZS+CMCEBKBeTiNEc1iyF978wfCs
r63iviLCAt3iF4C/4N0lqZhsf7AdrjgCxs2mAP+QyBctWGOhG+EW4VP4qwbx17xHtqs0cHZTAUPonht1R9y77eQJyxIrx5w6naAS
VbCtteDRyswLTJyI/YoPF+F+/H098an2pHNdPLaLOCBtBq3bJiTACnO02BrvZoAOLu+kgUf1Lzx8iW3U5b8KKVW6VCsutZyL9jvS
eTk/Wi/VbKZ8u5RrxUnTa/ySJB+n/ODq3yLEC+52FAJRVN50qC0EX9CNs01ZUDSnWDuBLZ2vuO1LfeLvSj5/yEJ8xTX1iITwdo/X
gVfNgP3aP0pFncB0vLkhYzgDxKWlnnwfPwXS8O79qha0SlAiE5pxTjzLaEdGiqSStiAUNo0XE7asgxgEF6EyoshNr/isq3iU903V
zv3My0ohDnCgIklkKxD7KLEYXNPeQ/OTHd6V7z8Ms+1UNquLiS7Rch6Y8Sf7JB3mZndDdT2z2LQIO71mOOh7gF5YCDYBMMLYATzc
nONK2ryWLbpurkmJBQnGa3463NXecY1gG/WV6nzxsJ6HZfqMynRKFZzWYj5xAWAe1cHNmSqRC0S8abX/2xDj69znaNn9fbeAiUuM
2GMKa6FIF6llSgeHJj+aNhsGFxE04phfPQ2ADZEiDUhwYbqaL26dhaydJrVYLQBDMqYBKkTjy9ORPvUxV3zJBGVUeuWgC0RAtNG9
BmAlbRGd42EdSCoXykpe2QZo3gg5cwlb8xmPiHudY81P4GVVEtgzdq6lNzZtOjv8A9vtls2yxXDXPCQtC8AlKhoDDuCj9AUY7apD
yq5oHE/R9GT3N8kXDgAuJf6JeWIyh81swI8FtmwWllDlLEVydi0tIPCEVMDJNXs7IqBqfQoFXOeWY7oeNSrlGvbQUMcXd/+PWlCx
0pPG1rPeld+b8VksQFk4eMwQ6eTpySPZ3UbX/zVwHSeKQVUviqTq9dzfdP3v8+jxnqpJ8NeQOwChGWT546exnlGrWz/Rzlm4fZpy
Mg+AhNYk/a+cJO8hZz23roOxo+2o1oNu9PWoCOHVM9X4QOAQLP38ZZa++bLR+izp9kGoALMWaMGTBgVE89DNdmAPwNdsz7VPdy+e
6MmS/cHI3lR+tga5h3V4MAhkK2LAwSQ0Fbo1waQHHAc+TKHbtdvBgib+XEaN206OJNjWlLEEhAdDvQ62Ap10eQb8YW8ZnTPzi6PR
hzLnYPcF1IC+vUQnUxo3uMnLB1mY3kg+6QBdoPc4sBuvcPWkouUxizPSMQFEWYtEqUZ7qT3yolCLuAhIxIWduMh3z+MgG/fZdA0G
1gNEDOE6LIUHlcXfD3LTrRmxA0Nm29eJMzVK3KKTo+R3hSYRy4oixboA
`.replace(/\s/g, ''), 'base64')).toString('utf8')
const LIBAPPINDICATOR_MIT_LICENSE = `MIT License

Copyright (c) 2017-2021 qDot
Copyright (c) 2021 Tauri Apps Contributors

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

interface CargoLockFixturePackage {
  readonly name: string
  readonly version: string
  readonly checksum: string
  readonly source?: string
}

function cargoLock(packages: readonly CargoLockFixturePackage[]): string {
  return [
    'version = 4',
    ...packages.flatMap(row => [
      '',
      '[[package]]',
      `name = ${JSON.stringify(row.name)}`,
      `version = ${JSON.stringify(row.version)}`,
      `source = ${JSON.stringify(row.source ?? CARGO_REGISTRY_SOURCE)}`,
      `checksum = ${JSON.stringify(row.checksum)}`,
    ]),
    '',
  ].join('\n')
}

async function cargoVcsInfo(directory: string, commit: string, pathInVcs: string): Promise<void> {
  await writeFile(join(directory, '.cargo_vcs_info.json'), `${JSON.stringify({
    git: { sha1: commit },
    path_in_vcs: pathInVcs,
  }, null, 2)}\n`)
}

const FIXTURE_RUST_TARGET = 'aarch64-apple-darwin'
const FIXTURE_SOURCE_ARTIFACT = 'fixture-sharp-source.tar'

function tarFixture(name: string, text: string): Buffer {
  const content = Buffer.from(text)
  const header = Buffer.alloc(512)
  const field = (offset: number, length: number, value: string): void => {
    header.write(value, offset, length, 'ascii')
  }
  field(0, 100, name)
  field(100, 8, '0000644\0')
  field(108, 8, '0000000\0')
  field(116, 8, '0000000\0')
  field(124, 12, `${content.length.toString(8).padStart(11, '0')}\0`)
  field(136, 12, '00000000000\0')
  header.fill(0x20, 148, 156)
  field(156, 1, '0')
  field(257, 6, 'ustar\0')
  field(263, 2, '00')
  field(265, 32, 'fixture')
  field(297, 32, 'fixture')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  field(148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([header, content, padding, Buffer.alloc(1024)])
}

async function rewriteChecksumInventory(output: string): Promise<void> {
  const files: string[] = []
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(path, relativePath)
      else if (entry.isFile() && relativePath !== 'SHA256SUMS.txt') files.push(relativePath)
    }
  }
  await walk(output)
  const inventory = await Promise.all(files.sort().map(async path => (
    `${createHash('sha256').update(await readFile(join(output, ...path.split('/')))).digest('hex')}  ${path}`
  )))
  await writeFile(join(output, 'SHA256SUMS.txt'), `${inventory.join('\n')}\n`)
}

interface Fixture {
  readonly root: string
  readonly npm: string
  readonly cargo: string
  readonly output: string
  readonly cargoLock: string
  readonly projectLicense: string
  readonly sourceArtifactCache: string
  readonly sourceArtifactSha256: string
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-licenses-'))
  const npm = join(root, 'npm')
  const cargo = join(root, 'cargo-dependency')
  const output = join(root, 'output')
  const cargoLock = join(root, 'Cargo.lock')
  const projectLicense = join(root, 'LICENSE')
  const sourceArtifactCache = join(root, 'source-cache')
  const sourceArtifact = tarFixture('fixture/LICENSE', 'fixture source license\n')
  await mkdir(npm, { recursive: true })
  await mkdir(cargo, { recursive: true })
  await mkdir(sourceArtifactCache, { recursive: true })
  await writeFile(join(npm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', license: 'MIT' }))
  await writeFile(cargoLock, 'version = 4\n')
  await writeFile(projectLicense, MIT)
  await writeFile(join(sourceArtifactCache, FIXTURE_SOURCE_ARTIFACT), sourceArtifact)
  return {
    root,
    npm,
    cargo,
    output,
    cargoLock,
    projectLicense,
    sourceArtifactCache,
    sourceArtifactSha256: createHash('sha256').update(sourceArtifact).digest('hex'),
  }
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

type GenerateOptions = Parameters<typeof generateDesktopLicenseBundle>[0]
type GenerateOverrides = Pick<GenerateOptions, 'pinnedTextCache' | 'pinnedTextFetch'>
  & Partial<Pick<GenerateOptions, 'rustTarget'>>

function fixtureSourceArtifact(row: Fixture): NonNullable<
  Parameters<typeof generateDesktopLicenseBundle>[0]['sourceArtifacts']
>[number] {
  return {
    name: FIXTURE_SOURCE_ARTIFACT,
    version: '1.0.0',
    repository: 'https://example.test/fixture-source',
    revision: 'fixture-revision',
    url: 'https://example.test/fixture-source.tar',
    expectedSha256: row.sourceArtifactSha256,
    purpose: 'unit-test source closure',
    relatedPackages: ['npm:@deepseek-ai/dsh@1.0.0'],
    requiredMembers: ['fixture/LICENSE'],
    components: sharpLibvipsSourceComponentNames(FIXTURE_RUST_TARGET),
    licenseMembers: ['fixture/LICENSE'],
  }
}

async function generate(
  row: Fixture,
  metadata = cargoMetadata(row.cargo),
  overrides: GenerateOverrides = {},
): Promise<LicenseManifestEntry[]> {
  const { rustTarget = FIXTURE_RUST_TARGET, ...otherOverrides } = overrides
  return await generateDesktopLicenseBundle({
    npmRoot: row.npm,
    cargoMetadata: metadata,
    cargoLock: row.cargoLock,
    projectLicense: row.projectLicense,
    output: row.output,
    rustTarget,
    sourceArtifactCache: row.sourceArtifactCache,
    sourceArtifacts: [fixtureSourceArtifact(row)],
    ...otherOverrides,
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

  it('requires the Linux reviewed closure and rejects an unknown Rust target', async () => {
    const row = await fixture()
    try {
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE'), MIT)
      await generate(row)
      const manifestPath = join(row.output, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { rustTarget: string }
      manifest.rustTarget = 'x86_64-unknown-linux-gnu'
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      await rewriteChecksumInventory(row.output)
      await expect(verifyDesktopLicenseBundle(row.output)).rejects.toThrow(
        'x86_64-unknown-linux-gnu is missing required reviewed Cargo packages: '
        + 'cargo:dlopen2@0.8.2, cargo:dlopen2_derive@0.4.3, '
        + 'cargo:libappindicator@0.9.0, cargo:libappindicator-sys@0.9.0',
      )

      manifest.rustTarget = 'fixture-unknown-target'
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      await rewriteChecksumInventory(row.output)
      await expect(verifyDesktopLicenseBundle(row.output)).rejects.toThrow(
        'unsupported reviewed Cargo target fixture-unknown-target',
      )
    } finally {
      await rm(row.root, { recursive: true, force: true })
    }
  })

  it('copies fixed source artifacts into the offline checksum inventory', async () => {
    const row = await fixture()
    try {
      const source = await readFile(join(row.sourceArtifactCache, FIXTURE_SOURCE_ARTIFACT))
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE'), MIT)
      await generateDesktopLicenseBundle({
        npmRoot: row.npm,
        cargoMetadata: cargoMetadata(row.cargo),
        cargoLock: row.cargoLock,
        projectLicense: row.projectLicense,
        output: row.output,
        rustTarget: FIXTURE_RUST_TARGET,
        sourceArtifactCache: row.sourceArtifactCache,
        sourceArtifacts: [fixtureSourceArtifact(row)],
      })
      const manifest = JSON.parse(await readFile(join(row.output, 'manifest.json'), 'utf8')) as {
        sourceArtifactCount: number
        sourceArtifacts: { path: string; sha256: string }[]
      }
      expect(manifest.sourceArtifactCount).toBe(1)
      expect(manifest.sourceArtifacts[0]?.path).toBe(`source-artifacts/${FIXTURE_SOURCE_ARTIFACT}`)
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
      await cargoVcsInfo(macroDirectory, 'dffa41a8a46d3f5565eefbff2de57d38d399f158', 'crates/callback-macros')
      await writeFile(row.cargoLock, cargoLock([{
        name: 'webview2-com-macros',
        version: '0.8.1',
        checksum: '67a921c1b6914c367b2b823cd4cde6f96beec77d30a939c8199bb377cf9b9b54',
      }]))
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
        rustTarget: 'x86_64-pc-windows-msvc',
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
      expect(entry?.reviewedCargoProvenance).toEqual({
        source: CARGO_REGISTRY_SOURCE,
        checksum: '67a921c1b6914c367b2b823cd4cde6f96beec77d30a939c8199bb377cf9b9b54',
        vcsCommit: 'dffa41a8a46d3f5565eefbff2de57d38d399f158',
        pathInVcs: 'crates/callback-macros',
      })
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

      await writeFile(cachedLicense, WEBVIEW2_COM_MACROS_LICENSE)
      await generate(row, metadataForVersion('0.8.1'), {
        pinnedTextCache,
        rustTarget: 'x86_64-pc-windows-msvc',
      })
      const manifestPath = join(row.output, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        packageCount: number
        cargoPackageCount: number
        packages: LicenseManifestEntry[]
      }
      manifest.packages = manifest.packages.filter(candidate => candidate.name !== 'webview2-com-macros')
      manifest.packageCount = manifest.packages.length
      manifest.cargoPackageCount = manifest.packages.filter(candidate => candidate.ecosystem === 'cargo').length
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      await rm(join(row.output, 'packages/cargo/webview2-com-macros/0.8.1'), { recursive: true })
      await rewriteChecksumInventory(row.output)
      await expect(verifyDesktopLicenseBundle(row.output)).rejects.toThrow(
        'x86_64-pc-windows-msvc is missing required reviewed Cargo packages: cargo:webview2-com-macros@0.8.1',
      )
    } finally {
      await rm(row.root, { recursive: true, force: true })
    }
  })

  it('packages the exact dlopen2 root LICENSE only for its locked registry crates', async () => {
    const row = await fixture()
    const pinnedTextCache = join(row.root, 'pinned-text')
    const cachedLicense = join(pinnedTextCache, DLOPEN2_LICENSE_NAME)
    const dlopenDirectory = join(row.root, 'dlopen2')
    const deriveDirectory = join(row.root, 'dlopen2-derive')
    const packages = [
      {
        name: 'dlopen2',
        version: '0.8.2',
        checksum: '5e2c5bd4158e66d1e215c49b837e11d62f3267b30c92f1d171c4d3105e3dc4d4',
        pathInVcs: 'dlopen2',
        directory: dlopenDirectory,
        authors: [
          'Szymon Wieloch <szymon.wieloch@gmail.com>',
          'Ahmed Masud <ahmed.masud@saf.ai>',
          'OpenByte <development.openbyte@gmail.com>',
        ],
      },
      {
        name: 'dlopen2_derive',
        version: '0.4.3',
        checksum: '0fbbb781877580993a8707ec48672673ec7b81eeba04cfd2310bd28c08e47c8f',
        pathInVcs: 'dlopen2-derive',
        directory: deriveDirectory,
        authors: [
          'Szymon Wieloch <szymon.wieloch@gmail.com>',
          'OpenByte <development.openbyte@gmail.com>',
        ],
      },
    ] as const
    type CargoOverride = Partial<{
      version: string
      license: string
      repository: string
      source: string
    }>
    const metadataFor = (
      overrides: Readonly<Record<string, CargoOverride>> = {},
    ): Parameters<typeof generateDesktopLicenseBundle>[0]['cargoMetadata'] => {
      const metadata = cargoMetadata(row.cargo)
      const cargoPackages = packages.map((spec) => {
        const override = overrides[spec.name] ?? {}
        const version = override.version ?? spec.version
        const id = `${spec.name} ${version} (${override.source ?? CARGO_REGISTRY_SOURCE})`
        return {
          id,
          name: spec.name,
          version,
          license: override.license ?? 'MIT',
          license_file: null,
          authors: [...spec.authors],
          repository: override.repository ?? 'https://github.com/OpenByteDev/dlopen2',
          homepage: null,
          source: override.source ?? CARGO_REGISTRY_SOURCE,
          manifest_path: join(spec.directory, 'Cargo.toml'),
        }
      })
      return {
        ...metadata,
        resolve: {
          nodes: [
            ...(metadata.resolve?.nodes ?? []),
            ...cargoPackages.map(({ id }) => ({ id })),
          ],
        },
        packages: [...metadata.packages, ...cargoPackages],
      }
    }
    const writeValidLock = async (): Promise<void> => {
      await writeFile(row.cargoLock, cargoLock(packages))
    }
    const writeValidVcs = async (): Promise<void> => {
      await Promise.all(packages.map(async (spec) => {
        await cargoVcsInfo(spec.directory, DLOPEN2_COMMIT, spec.pathInVcs)
      }))
    }

    try {
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE'), MIT)
      await Promise.all(packages.map(async (spec) => {
        await mkdir(spec.directory, { recursive: true })
        await writeFile(
          join(spec.directory, 'Cargo.toml'),
          `[package]\nname = ${JSON.stringify(spec.name)}\nversion = ${JSON.stringify(spec.version)}\n`,
        )
      }))
      await writeValidLock()
      await writeValidVcs()
      await mkdir(pinnedTextCache, { recursive: true })
      await writeFile(cachedLicense, DLOPEN2_LICENSE)
      expect(createHash('sha256').update(DLOPEN2_LICENSE).digest('hex')).toBe(
        '39fa265207450e77c62e90c5594a06c085b655d8374c7ced4bf7894b6bd95dd2',
      )

      let offlineFetchCalls = 0
      const entries = await generate(row, metadataFor(), {
        pinnedTextCache,
        pinnedTextFetch: async () => {
          offlineFetchCalls += 1
          throw new Error('offline fixture must use its verified cache')
        },
      })
      expect(offlineFetchCalls).toBe(0)
      const dlopenEntries = entries.filter(entry => entry.name.startsWith('dlopen2'))
      expect(dlopenEntries.map(entry => `${entry.name}@${entry.version}`)).toEqual([
        'dlopen2_derive@0.4.3',
        'dlopen2@0.8.2',
      ])
      for (const entry of dlopenEntries) {
        const spec = packages.find(candidate => candidate.name === entry.name)
        expect(spec).toBeDefined()
        expect(entry.licenseExpression).toBe('MIT')
        expect(entry.repository).toBe('https://github.com/OpenByteDev/dlopen2')
        expect(entry.files).toHaveLength(1)
        expect(entry.files[0]).toMatchObject({
          origin: 'pinned-upstream',
          sourceName: DLOPEN2_LICENSE_NAME,
          sourcePackage: `cargo:${entry.name}@${entry.version}`,
          sha256: '39fa265207450e77c62e90c5594a06c085b655d8374c7ced4bf7894b6bd95dd2',
        })
        expect(entry.files[0]?.licenseId).toBeUndefined()
        expect(entry.reviewedCargoProvenance).toEqual({
          source: CARGO_REGISTRY_SOURCE,
          checksum: spec?.checksum,
          vcsCommit: DLOPEN2_COMMIT,
          pathInVcs: spec?.pathInVcs,
        })
        expect(entry.copyrightLines).toEqual(expect.arrayContaining([
          'Copyright (c) 2017 Szymon Wieloch',
          'Copyright (C) 2019 Ahmed Masud <ahmed.masud@saf.ai>',
          'Copyright (C) 2022 OpenByte <development.openbyte@gmail.com>',
        ]))
        expect(await readFile(join(row.output, entry.files[0]?.path ?? ''), 'utf8')).toBe(DLOPEN2_LICENSE)
      }
      await expect(verifyDesktopLicenseBundle(row.output)).resolves.toBeUndefined()

      await expect(generate(row, metadataFor({ dlopen2: { version: '0.8.3' } }), { pinnedTextCache })).rejects.toThrow(
        'cargo:dlopen2@0.8.3 needs a reviewed upstream license-text pin',
      )
      for (const override of [
        { license: 'Apache-2.0' },
        { repository: 'https://example.test/wrong-repository' },
        { source: 'git+https://github.com/OpenByteDev/dlopen2' },
      ]) {
        await expect(generate(row, metadataFor({ dlopen2: override }), { pinnedTextCache })).rejects.toThrow(
          'cargo:dlopen2@0.8.2 does not match its reviewed MIT registry provenance',
        )
      }

      await writeFile(row.cargoLock, cargoLock([
        { ...packages[0], checksum: '0'.repeat(64) },
        packages[1],
      ]))
      await expect(generate(row, metadataFor(), { pinnedTextCache })).rejects.toThrow(
        'cargo:dlopen2@0.8.2 does not match its reviewed registry checksum',
      )
      await writeFile(row.cargoLock, cargoLock([packages[0], packages[0], packages[1]]))
      await expect(generate(row, metadataFor(), { pinnedTextCache })).rejects.toThrow(
        'cargo:dlopen2@0.8.2 must have one unique Cargo.lock package record; found 2',
      )
      await writeValidLock()

      await cargoVcsInfo(dlopenDirectory, '0'.repeat(40), 'dlopen2')
      await expect(generate(row, metadataFor(), { pinnedTextCache })).rejects.toThrow(
        'cargo:dlopen2@0.8.2 does not match its reviewed VCS commit and path',
      )
      await cargoVcsInfo(dlopenDirectory, DLOPEN2_COMMIT, 'wrong-path')
      await expect(generate(row, metadataFor(), { pinnedTextCache })).rejects.toThrow(
        'cargo:dlopen2@0.8.2 does not match its reviewed VCS commit and path',
      )
      await writeValidVcs()

      await writeFile(cachedLicense, 'changed upstream text\n')
      await expect(generate(row, metadataFor(), {
        pinnedTextCache,
        pinnedTextFetch: async () => new Response('changed upstream text\n'),
      })).rejects.toThrow('pinned license source changed or was corrupted')
      await writeFile(cachedLicense, DLOPEN2_LICENSE)

      await generate(row, metadataFor(), { pinnedTextCache })
      const manifestPath = join(row.output, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        packages: LicenseManifestEntry[]
      }
      const manifestDlopen = manifest.packages.find(entry => entry.name === 'dlopen2')
      expect(manifestDlopen).toBeDefined()
      manifest.packages = manifest.packages.map(entry => entry.name === 'dlopen2'
        ? {
          ...entry,
          files: entry.files.map((file, index) => index === 0
            ? { ...file, sourcePackage: 'cargo:dlopen2_derive@0.4.3' }
            : file),
        }
        : entry)
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      const inventoryPath = join(row.output, 'SHA256SUMS.txt')
      const manifestSha256 = createHash('sha256').update(await readFile(manifestPath)).digest('hex')
      const inventory = (await readFile(inventoryPath, 'utf8')).replace(
        /^[a-f0-9]{64}  manifest\.json$/m,
        `${manifestSha256}  manifest.json`,
      )
      await writeFile(inventoryPath, inventory)
      await expect(verifyDesktopLicenseBundle(row.output)).rejects.toThrow(
        'cargo:dlopen2@0.8.2 does not contain its fixed reviewed upstream LICENSE',
      )

      const regenerated = await generate(row, metadataFor(), { pinnedTextCache })
      const outputLicense = join(
        row.output,
        regenerated.find(entry => entry.name === 'dlopen2')?.files[0]?.path ?? '',
      )
      await writeFile(outputLicense, `${DLOPEN2_LICENSE}tampered\n`)
      await expect(verifyDesktopLicenseBundle(row.output)).rejects.toThrow('checksum mismatch')
    } finally {
      await rm(row.root, { recursive: true, force: true })
    }
  })

  it('uses libappindicator only as the exact reviewed VCS sibling donor for its sys crate', async () => {
    const row = await fixture()
    const sourceDirectory = join(row.root, 'libappindicator-sys')
    const donorDirectory = join(row.root, 'libappindicator')
    const commit = 'eafd1e3682a1247f595410266091e9684021cb6f'
    const packages = [
      {
        name: 'libappindicator-sys',
        version: '0.9.0',
        checksum: '6e9ec52138abedcc58dc17a7c6c0c00a2bdb4f3427c7f63fa97fd0d859155caf',
        pathInVcs: 'sys',
        directory: sourceDirectory,
      },
      {
        name: 'libappindicator',
        version: '0.9.0',
        checksum: '03589b9607c868cc7ae54c0b2a22c8dc03dd41692d48f2d7df73615c6a95dc0a',
        pathInVcs: '',
        directory: donorDirectory,
      },
    ] as const
    type CargoOverride = Partial<{
      version: string
      license: string
      repository: string | null
      homepage: string | null
      source: string
    }>
    const metadataFor = (
      overrides: Readonly<Record<string, CargoOverride>> = {},
    ): Parameters<typeof generateDesktopLicenseBundle>[0]['cargoMetadata'] => {
      const metadata = cargoMetadata(row.cargo)
      const cargoPackages = packages.map((spec) => {
        const override = overrides[spec.name] ?? {}
        const version = override.version ?? spec.version
        const source = override.source ?? CARGO_REGISTRY_SOURCE
        const id = `${spec.name} ${version} (${source})`
        return {
          id,
          name: spec.name,
          version,
          license: override.license ?? 'Apache-2.0 OR MIT',
          license_file: null,
          authors: [],
          repository: override.repository ?? null,
          homepage: override.homepage ?? null,
          source,
          manifest_path: join(spec.directory, 'Cargo.toml'),
        }
      })
      return {
        ...metadata,
        resolve: {
          nodes: [
            ...(metadata.resolve?.nodes ?? []),
            ...cargoPackages.map(({ id }) => ({ id })),
          ],
        },
        packages: [...metadata.packages, ...cargoPackages],
      }
    }
    const writeValidLock = async (): Promise<void> => {
      await writeFile(row.cargoLock, cargoLock(packages))
    }
    const writeValidVcs = async (): Promise<void> => {
      await Promise.all(packages.map(async (spec) => {
        await cargoVcsInfo(spec.directory, commit, spec.pathInVcs)
      }))
    }
    const writeValidDonorFiles = async (): Promise<void> => {
      await writeFile(join(donorDirectory, 'LICENSE-APACHE'), LIBAPPINDICATOR_APACHE_LICENSE)
      await writeFile(join(donorDirectory, 'LICENSE-MIT'), LIBAPPINDICATOR_MIT_LICENSE)
    }

    try {
      await writeFile(join(row.cargo, 'Cargo.toml'), '[package]\nname = "dependency"\nversion = "2.0.0"\n')
      await writeFile(join(row.cargo, 'LICENSE'), MIT)
      await Promise.all(packages.map(async (spec) => {
        await mkdir(spec.directory, { recursive: true })
        await writeFile(
          join(spec.directory, 'Cargo.toml'),
          `[package]\nname = ${JSON.stringify(spec.name)}\nversion = ${JSON.stringify(spec.version)}\n`,
        )
      }))
      await writeValidLock()
      await writeValidVcs()
      await writeValidDonorFiles()
      expect(createHash('sha256').update(LIBAPPINDICATOR_APACHE_LICENSE).digest('hex')).toBe(
        'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
      )
      expect(createHash('sha256').update(LIBAPPINDICATOR_MIT_LICENSE).digest('hex')).toBe(
        'eb227437252b2a7a9c1fc342c93ade1f3d7ce38cc6dd754f613db07d53ceff0b',
      )

      const entries = await generate(row, metadataFor())
      const source = entries.find(entry => entry.name === 'libappindicator-sys')
      const donor = entries.find(entry => entry.name === 'libappindicator')
      expect(source).toMatchObject({
        version: '0.9.0',
        licenseExpression: 'Apache-2.0 OR MIT',
        reviewedCargoProvenance: {
          source: CARGO_REGISTRY_SOURCE,
          checksum: packages[0].checksum,
          vcsCommit: commit,
          pathInVcs: 'sys',
          siblingDonor: {
            name: 'libappindicator',
            version: '0.9.0',
            repository: 'https://github.com/tauri-apps/libappindicator-rs',
            source: CARGO_REGISTRY_SOURCE,
            checksum: packages[1].checksum,
            vcsCommit: commit,
            pathInVcs: '',
          },
        },
      })
      expect(source?.repository).toBeUndefined()
      expect(source?.files.map(file => ({
        origin: file.origin,
        sourceName: file.sourceName,
        sourcePackage: file.sourcePackage,
        sha256: file.sha256,
      }))).toEqual([
        {
          origin: 'repository-sibling',
          sourceName: 'LICENSE-APACHE',
          sourcePackage: 'cargo:libappindicator@0.9.0',
          sha256: 'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
        },
        {
          origin: 'repository-sibling',
          sourceName: 'LICENSE-MIT',
          sourcePackage: 'cargo:libappindicator@0.9.0',
          sha256: 'eb227437252b2a7a9c1fc342c93ade1f3d7ce38cc6dd754f613db07d53ceff0b',
        },
      ])
      expect(source?.copyrightLines).toEqual(expect.arrayContaining([
        'Copyright (c) 2017-2021 qDot',
        'Copyright (c) 2021 Tauri Apps Contributors',
      ]))
      expect(donor?.files.map(file => file.origin)).toEqual(['package', 'package'])
      expect(donor?.files.map(file => file.sourcePackage)).toEqual([
        'cargo:libappindicator@0.9.0',
        'cargo:libappindicator@0.9.0',
      ])
      await expect(verifyDesktopLicenseBundle(row.output)).resolves.toBeUndefined()

      await expect(generate(row, metadataFor({
        'libappindicator-sys': { version: '0.9.1' },
      }))).rejects.toThrow('cargo:libappindicator-sys@0.9.1 needs a reviewed VCS sibling license donor')
      for (const overrides of [
        { 'libappindicator-sys': { license: 'MIT' } },
        { 'libappindicator-sys': { repository: 'https://example.test/not-reviewed' } },
        { 'libappindicator-sys': { source: 'git+https://github.com/tauri-apps/libappindicator-rs' } },
        { libappindicator: { license: 'MIT' } },
        { libappindicator: { homepage: 'https://example.test/not-reviewed' } },
        { libappindicator: { source: 'git+https://github.com/tauri-apps/libappindicator-rs' } },
      ] satisfies Readonly<Record<string, CargoOverride>>[]) {
        await expect(generate(row, metadataFor(overrides))).rejects.toThrow(
          'does not match its reviewed registry/SPDX VCS sibling provenance',
        )
      }

      for (const index of [0, 1] as const) {
        await writeFile(row.cargoLock, cargoLock(packages.map((spec, candidate) => (
          candidate === index ? { ...spec, checksum: '0'.repeat(64) } : spec
        ))))
        await expect(generate(row, metadataFor())).rejects.toThrow(
          `cargo:${packages[index].name}@0.9.0 does not match its reviewed registry checksum`,
        )
      }
      await writeFile(row.cargoLock, cargoLock([packages[0], packages[1], packages[1]]))
      await expect(generate(row, metadataFor())).rejects.toThrow(
        'cargo:libappindicator@0.9.0 must have one unique Cargo.lock package record; found 2',
      )
      await writeValidLock()

      await cargoVcsInfo(sourceDirectory, '0'.repeat(40), 'sys')
      await expect(generate(row, metadataFor())).rejects.toThrow(
        'cargo:libappindicator-sys@0.9.0 does not match its reviewed VCS commit and path',
      )
      await cargoVcsInfo(sourceDirectory, commit, 'wrong-path')
      await expect(generate(row, metadataFor())).rejects.toThrow(
        'cargo:libappindicator-sys@0.9.0 does not match its reviewed VCS commit and path',
      )
      await cargoVcsInfo(sourceDirectory, commit, 'sys')
      await cargoVcsInfo(donorDirectory, '0'.repeat(40), '')
      await expect(generate(row, metadataFor())).rejects.toThrow(
        'cargo:libappindicator@0.9.0 does not match its reviewed VCS commit and path',
      )
      await writeValidVcs()

      await writeFile(join(donorDirectory, 'LICENSE-MIT'), 'changed donor text\n')
      await expect(generate(row, metadataFor())).rejects.toThrow(
        'reviewed VCS sibling donor LICENSE-MIT changed or is corrupted',
      )
      await writeValidDonorFiles()
      await writeFile(join(donorDirectory, 'NOTICE'), 'unexpected donor text\n')
      await expect(generate(row, metadataFor())).rejects.toThrow(
        'reviewed VCS sibling donor has an unexpected license-text closure',
      )
      await rm(join(donorDirectory, 'NOTICE'))

      await generate(row, metadataFor())
      const manifestPath = join(row.output, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        packages: LicenseManifestEntry[]
      }
      const sourceManifest = manifest.packages.find(entry => entry.name === 'libappindicator-sys')
      expect(sourceManifest).toBeDefined()
      manifest.packages = manifest.packages.map(entry => entry.name === 'libappindicator-sys'
        ? {
          ...entry,
          files: entry.files.map((file, index) => index === 0
            ? { ...file, sourcePackage: 'cargo:libappindicator-sys@0.9.0' }
            : file),
        }
        : entry)
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      const inventoryPath = join(row.output, 'SHA256SUMS.txt')
      const manifestSha256 = createHash('sha256').update(await readFile(manifestPath)).digest('hex')
      await writeFile(inventoryPath, (await readFile(inventoryPath, 'utf8')).replace(
        /^[a-f0-9]{64}  manifest\.json$/m,
        `${manifestSha256}  manifest.json`,
      ))
      await expect(verifyDesktopLicenseBundle(row.output)).rejects.toThrow(
        'cargo:libappindicator-sys@0.9.0 does not contain its fixed reviewed VCS sibling licenses',
      )
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
