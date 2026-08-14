import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('node-pty desktop patch', () => {
  it('builds spawn-helper on macOS and Linux with macOS-only Xcode settings', async () => {
    const patchUrl = new URL('../patches/node-pty@1.1.0.patch', import.meta.url)
    const patchBytes = await readFile(patchUrl)
    const patch = patchBytes.toString('utf8')
    expect(patch).toContain([
      '-    [\'OS=="mac"\', {',
      '+    [\'OS=="mac" or OS=="linux"\', {',
    ].join('\n'))
    expect(patch).toContain([
      '+          \'conditions\': [',
      '+            [\'OS=="mac"\', {',
      '+              "xcode_settings": {',
      '+                "MACOSX_DEPLOYMENT_TARGET":"10.7"',
      '+              }',
      '+            }]',
      '+          ]',
    ].join('\n'))
    expect(patch).not.toContain('+          "xcode_settings": {')

    const patchHash = createHash('sha256').update(patchBytes).digest('hex')
    const lockfile = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
    expect(lockfile).toContain(`node-pty@1.1.0: ${patchHash}`)
    expect(lockfile.match(new RegExp(`patch_hash=${patchHash}`, 'g'))).toHaveLength(2)
  })
})
