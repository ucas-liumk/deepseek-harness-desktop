import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflowSource = readFileSync(resolve(root, '.github/workflows/desktop-release.yml'), 'utf8')
const tauriConfig: unknown = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const linuxConfig: unknown = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.linux.conf.json'), 'utf8'))

describe('desktop release workflow', () => {
  const workflow = yaml.load(workflowSource)
  if (!isRecord(workflow) || !isRecord(workflow.on) || !isRecord(workflow.jobs)) {
    throw new TypeError('desktop release workflow must define events and jobs')
  }
  const events = workflow.on
  const jobs = workflow.jobs

  it('uses a manual safety switch or an exact version tag with minimum default permissions', () => {
    const push: unknown = events.push
    const dispatch: unknown = events.workflow_dispatch
    if (!isRecord(push) || !isRecord(dispatch)) {
      throw new TypeError('desktop release workflow must define push and manual events')
    }
    const inputs = dispatch.inputs
    if (!isRecord(inputs) || !isRecord(inputs.publish)) {
      throw new TypeError('desktop release manual event must define the publish input')
    }
    expect(push).toEqual({ tags: ['desktop-v*'] })
    expect(inputs.publish).toMatchObject({
      type: 'boolean',
      default: false,
      required: true,
    })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(jobs.plan)).toContain('publication requires the exact ${tag} tag ref')
    expect(JSON.stringify(jobs.plan)).toContain('node-version":"${{ env.PRIMARY_NODE_VERSION }}')
    expect(workflowSource).not.toMatch(/uses:\s+[^\s]+@v\d+/)
  })

  it('runs fixed desktop regressions before native builds and tests Rust after the real sidecar exists', () => {
    const build = job(jobs, 'build')
    if (!isRecord(build.strategy) || !isRecord(build.strategy.matrix) || !Array.isArray(build.strategy.matrix.include)) {
      throw new TypeError('desktop build job must define an include matrix')
    }
    expect(build.strategy.matrix.include).toEqual([
      expect.objectContaining({ id: 'macos-arm64', runner: 'macos-15', platform: 'darwin', architecture: 'arm64', bundles: 'app,dmg' }),
      expect.objectContaining({ id: 'windows-x64', runner: 'windows-2025', platform: 'win32', architecture: 'x64' }),
      expect.objectContaining({ id: 'linux-x64', runner: 'ubuntu-22.04', platform: 'linux', architecture: 'x64', bundles: 'deb' }),
    ])
    if (!Array.isArray(build.steps)) throw new TypeError('desktop build job must define steps')
    const names = build.steps.filter(isRecord).map(step => step.name)
    const regressionTests = step(build, 'Test desktop regression contracts')
    expect(stringField(regressionTests, 'run').split(/\s+/)).toEqual([
      'pnpm',
      'exec',
      'vitest',
      'run',
      'packages/client/runtime/tests/sessions-service.client.spec.ts',
      'packages/client/runtime/tests/workspaces-service.client.spec.ts',
      'packages/session-query/session-log-export/tests/controller.client.spec.ts',
      'packages/session-query/session-log-export/tests/dialog.client.spec.tsx',
      'packages/preset/agent-presets/tests/mount.spec.ts',
      'packages/typert/loader/tests/loader.spec.ts',
      'scripts/build-desktop.spec.ts',
      'scripts/node-pty-patch.spec.ts',
      'scripts/desktop-release.spec.ts',
      'scripts/gen-desktop-third-party-licenses.spec.ts',
      'apps/cli/tests/desktop-api-auth.spec.ts',
      'packages/client/connection/tests/api-request-trust.host.spec.ts',
      'packages/client/connection/tests/node-half.host.spec.ts',
      'packages/bundle/web-app/tests/web-app.spec.ts',
      'packages/client/connection/tests/desktop-download-ticket.host.spec.ts',
    ])
    expect(names.indexOf('Test desktop regression contracts')).toBeLessThan(
      names.indexOf('Build and smoke-test the native sidecar'),
    )
    expect(names.indexOf('Build and smoke-test the native sidecar')).toBeLessThan(
      names.indexOf('Test desktop Rust host against the real sidecar'),
    )
    expect(names.indexOf('Test desktop Rust host against the real sidecar')).toBeLessThan(
      names.indexOf('Build native desktop packages from verified inputs'),
    )
    expect(JSON.stringify(build.steps)).toContain('native host mismatch')
    expect(JSON.stringify(build.steps)).toContain('Node version mismatch')
    expect(JSON.stringify(build.steps)).toContain('Get-AuthenticodeSignature')
    expect(JSON.stringify(build.steps)).toContain('gen-desktop-third-party-licenses.ts')
    expect(JSON.stringify(build.steps).match(/THIRD_PARTY_LICENSES/g)?.length).toBeGreaterThanOrEqual(3)
    expect(workflow.env).toMatchObject({
      PRIMARY_NODE_VERSION: '24.19.0',
      RUST_TOOLCHAIN_VERSION: '1.94.0',
    })
    const rustInstall = step(build, 'Install pinned Rust')
    expect(stringField(rustInstall, 'run')).toContain('process.env.RUST_TOOLCHAIN_VERSION')
    expect(stringField(rustInstall, 'run')).not.toContain('install stable')
    const plan = job(jobs, 'plan')
    expect(plan['runs-on']).toBe('ubuntu-24.04')
    const rustAudit = step(plan, 'Audit Rust lockfile')
    expect(stringField(rustAudit, 'run')).toContain('cargo-audit-x86_64-unknown-linux-gnu-v0.22.2.tgz')
    expect(stringField(rustAudit, 'run')).toContain('ab28a1bdb54db4d5d8ad5981cf1f959410370b3d28250dbd35f6a44248620e39')
    expect(stringField(rustAudit, 'run')).toContain('audit --file src-tauri/Cargo.lock')
    const linuxPrerequisites = step(build, 'Install Linux desktop prerequisites')
    expect(stringField(linuxPrerequisites, 'run')).toContain('xdotool')
    expect(stringField(linuxPrerequisites, 'run')).toContain('xvfb')
    expect(step(build, 'Build native desktop packages from verified inputs')).not.toHaveProperty('env')
    expect(JSON.stringify(build)).not.toMatch(/appimage/i)
  })

  it('pins zlib NSIS compression and exposes only the deb target in the Linux bundle config', () => {
    if (!isRecord(tauriConfig) || !isRecord(tauriConfig.bundle)
      || !isRecord(linuxConfig) || !isRecord(linuxConfig.bundle)) {
      throw new TypeError('desktop Tauri configs must define bundle objects')
    }
    expect(tauriConfig.bundle.windows).toEqual({ nsis: { compression: 'zlib' } })
    expect(linuxConfig.bundle.targets).toEqual(['deb'])
  })

  it('mounts the final unsigned DMG, starts its ad-hoc app, and checks sidecar cleanup', () => {
    const source = stringField(step(job(jobs, 'build'), 'Package and verify macOS arm64 DMG'), 'run')
    expect(source).toContain('_macos-arm64_app-adhoc_dmg-unsigned.dmg')
    expect(source).toContain('codesign --verify --verbose=2 "$destination"')
    expect(source).toContain('the DMG container is unexpectedly signed')
    expect(source).toContain('hdiutil attach "$destination" -nobrowse -readonly')
    expect(source).toContain("minimum_supported_macos='15.0'")
    expect(source).toContain('plutil -extract LSMinimumSystemVersion raw -o - "$plist"')
    expect(source).toContain('plutil -extract CFBundleShortVersionString raw -o - "$plist"')
    expect(source).toContain('plutil -extract CFBundleVersion raw -o - "$plist"')
    expect(source).toContain("[ \"$short_version\" = '0.1.0' ]")
    expect(source).toContain("[ \"$bundle_version\" = '108' ]")
    expect(source).toContain('assert_bundle_metadata "$app"')
    expect(source).toContain('assert_bundle_metadata "$mounted_app"')
    expect(source.match(/assert_macos_minos "\$binary" "\$minimum_supported_macos"/g)).toHaveLength(2)
    expect(source.match(/if \(versions\.length === 0\)/g)).toHaveLength(1)
    expect(source).toContain('has no LC_BUILD_VERSION minos')
    expect(source).toContain('const parsed = JSON.parse(extractPkgVfsManifest(sea))')
    expect(source).toContain("resolveHostTarget('darwin', 'arm64')")
    for (const nativeRoot of [
      'layout.ripgrep.relativePath',
      'layout.sharpPackage',
      'layout.sharpLibvipsPackage',
      'layout.koffiPackage',
      'layout.addonRequireBuiltinPackage',
      'layout.nodePtyNativeDirectory',
    ]) expect(source).toContain(nativeRoot)
    expect(source).toContain('staged native file does not match the SEA VFS manifest')
    expect(source).toContain('staged Mach-O bytes are absent from the final SEA')
    expect(source).toContain('sea.indexOf(nativeBytes) === -1')
    expect(source).toContain('node-addon-require-builtin-darwin-arm64/prebuilt/darwin-arm64-napi-v9.node')
    expect(source).toContain('assert_macos_minos "$addon" "$minimum_supported_macos" \'15.0\'')
    expect(source).toContain('plutil -convert json -o "$expected_entitlements" src-tauri/Entitlements.plist')
    expect(source.match(/node - "\$expected_entitlements" "\$actual_json" <<'NODE'/g)).toHaveLength(1)
    expect(source.match(/assert_entitlements "\$binary"/g)).toHaveLength(2)
    expect(source).toContain('DSH_DESKTOP_SMOKE_READY_FILE="$ready" "$mounted_main"')
    expect(source).toContain('tell application id "io.github.ucas-liumk.deepseek-harness-desktop" to quit')
    expect(source).toContain('pgrep -f -- "$binary"')
    expect(source).toContain('dsh-backend-spawn-helper')
    expect(source).toContain('--verify "$mounted_app/Contents/Resources/THIRD_PARTY_LICENSES"')
  })

  it('silently installs, starts, closes, checks, and uninstalls the final NSIS package', () => {
    const source = stringField(step(job(jobs, 'build'), 'Package and verify unsigned Windows x64 installer'), 'run')
    expect(source.match(/\$sevenZip = Get-Command 7z/g)).toHaveLength(1)
    expect(source).toContain("-ArgumentList @('/S', \"/D=$installRoot\") -Wait -PassThru")
    expect(source).toContain('$env:DSH_DESKTOP_SMOKE_READY_FILE = $ready')
    expect(source).toContain('$appProcess.CloseMainWindow()')
    expect(source).toContain('Wait-NoProcessAtPath $installedBackend')
    expect(source).toContain("-ArgumentList '/S' -Wait -PassThru")
    expect(source).toContain('silent NSIS uninstall left the installed application executable behind')
  })

  it('installs, starts, closes, checks, and purges the final Linux deb', () => {
    const linuxStep = step(job(jobs, 'build'), 'Package and verify unsigned Linux x64 deb')
    const source = stringField(linuxStep, 'run')
    expect(linuxStep.shell).toBe('bash')
    expect(workflowSource.match(/^\s+shell: bash$/gm)).toHaveLength(7)
    expect(source).toContain('dpkg-deb -f "$deb" Architecture')
    expect(source.match(/deb_count="\$\(find src-tauri\/target\/release\/bundle\/deb/g)).toHaveLength(1)
    expect(source).toContain('dpkg-deb --extract "$deb" "$RUNNER_TEMP/deb"')
    expect(source).toContain('find_unique_file "$RUNNER_TEMP/deb" dsh-backend deb_backend')
    expect(source).toContain('find_unique_file "$RUNNER_TEMP/deb" dsh-backend-spawn-helper deb_helper')
    expect(source).toContain('assert_x64_elf "$deb_helper"')
    expect(source).toContain('xvfb-run -a bash -s')
    expect(source).toContain('DSH_DESKTOP_SMOKE_READY_FILE="$ready"')
    expect(source).toContain('xdotool windowclose "$window"')
    expect(source).toContain('sudo dpkg -i "$deb"')
    expect(source).toContain('sudo dpkg --purge "$deb_package"')
    expect(source).toContain('process_at_path "$binary"')
    expect(source).toContain('for binary in "$installed_main" "$installed_backend" "$installed_helper"')
    expect(source).toContain('deb purge left $binary behind')
    expect(source).toContain('deb purge left $deb_package installed')
    expect(source).toContain('gen-desktop-third-party-licenses.ts --verify "$license_bundle"')
    expect(source).not.toMatch(/appimage/i)
  })

  it('publishes only the complete verified payload with explicit signing status and checksums', () => {
    const release = job(jobs, 'release')
    expect(release).toMatchObject({
      if: "needs.plan.outputs.publish == 'true'",
      needs: ['plan', 'build'],
      environment: 'desktop-release',
      permissions: { contents: 'write' },
    })
    const source = JSON.stringify(release)
    expect(source).toContain('sha256sum -c SHA256SUMS.txt')
    expect(source).toContain('the DMG is unsigned and not notarized')
    expect(source).toContain('requires macOS 15.0 or later')
    expect(source).toContain('contained app uses an ad-hoc signature')
    expect(source).toContain('Windows x64: unsigned')
    expect(source).toContain('Linux x64: unsigned deb package')
    expect(source).toContain('_macos-arm64_app-adhoc_dmg-unsigned.dmg')
    expect(source).not.toMatch(/appimage/i)
    if (!Array.isArray(release.steps)) throw new TypeError('desktop release job must define steps')
    const verify = step(release, 'Verify complete release payload')
    expect(stringField(verify, 'run')).toContain('" = 4 ]')
    const publish = release.steps.filter(isRecord).find(step => step.name === 'Publish verified assets')
    if (!isRecord(publish)) throw new TypeError('desktop publish step is missing')
    const publishSource = stringField(publish, 'run')
    expect(publishSource).toContain('already exists, including as a draft')
    expect(publish.env).toMatchObject({ EXPECTED_SHA: '${{ github.sha }}' })
    expect(publishSource).toContain('gh api "repos/$GH_REPO/git/ref/tags/$TAG"')
    expect(publishSource).toContain('gh api "repos/$GH_REPO/git/tags/$object_sha"')
    expect(publishSource).toContain('Tag $TAG resolves to $actual_sha, but this workflow verified $EXPECTED_SHA')
    expect(publishSource.match(/assert_tag_commit/g)?.length).toBeGreaterThanOrEqual(3)
    expect(publishSource).toContain('gh api --paginate "repos/$GH_REPO/releases?per_page=100"')
    expect(publishSource).toContain('grep -Fqx -- "$TAG" "$existing_tags"')
    expect(publishSource).toContain('gh release upload "$TAG" "${assets[@]}"')
    expect(publishSource).not.toContain('--clobber')
    expect(publishSource).toContain('gh api --method POST "repos/$GH_REPO/releases"')
    expect(publishSource).toContain('-f "target_commitish=$EXPECTED_SHA"')
    expect(publishSource).toContain('-F "body=@$notes"')
    expect(publishSource).toContain('-F draft=true')
    expect(publishSource).toContain('-F "prerelease=$prerelease"')
    expect(publishSource).not.toContain('gh release create')
    expect(publishSource).toContain('gh release view "$TAG" --json databaseId --jq \'.databaseId\'')
    expect(publishSource).toContain('[ "$observed_release_id" = "$created_release_id" ]')
    expect(publishSource).toContain('gh api "repos/$GH_REPO/releases/$created_release_id"')
    expect(publishSource).toContain('[.id, .tag_name, .draft] | @tsv')
    expect(publishSource).toContain('[ "$observed_id" = "$created_release_id" ]')
    expect(publishSource).toContain('[ "$observed_tag" = "$TAG" ]')
    expect(publishSource).toContain('[ "$observed_draft" = true ]')
    expect(publishSource).toContain('gh api --method DELETE "repos/$GH_REPO/releases/$created_release_id"')
    expect(publishSource).not.toContain('gh release delete')
    expect(publishSource).not.toContain('cleanup-tag')
    expect(publishSource).toContain("gh release view \"$TAG\" --json assets --jq '.assets[].name'")
    expect(publishSource).toContain('diff -u "$expected_assets" "$remote_assets"')
    expect(publishSource.indexOf('created_release_id="$(')).toBeLessThan(
      publishSource.indexOf('trap cleanup_failed_draft EXIT'),
    )
    expect(publishSource.indexOf('diff -u "$expected_assets" "$remote_assets"')).toBeLessThan(
      publishSource.indexOf('gh api --method PATCH "repos/$GH_REPO/releases/$created_release_id"'),
    )
    expect(publishSource.lastIndexOf('assert_tag_commit')).toBeLessThan(
      publishSource.indexOf('gh api --method PATCH "repos/$GH_REPO/releases/$created_release_id"'),
    )
    expect(publishSource.lastIndexOf('trap - EXIT')).toBeGreaterThan(
      publishSource.indexOf('gh api --method PATCH "repos/$GH_REPO/releases/$created_release_id"'),
    )
    expect(publishSource.match(/dist\/release\/Unofficial-DeepSeek-Harness-Desktop_\$\{VERSION\}_/g)).toHaveLength(3)
    expect(publishSource).toContain("'dist/release/SHA256SUMS.txt'")
  })

  it('deletes only the owned draft release id after failure and leaves a published release intact', () => {
    const release = job(jobs, 'release')
    if (!Array.isArray(release.steps)) throw new TypeError('desktop release job must define steps')
    const publish = release.steps.filter(isRecord).find(candidate => candidate.name === 'Publish verified assets')
    if (!isRecord(publish)) throw new TypeError('desktop publish step is missing')
    const publishSource = stringField(publish, 'run')

    const failed = runPublishContract(publishSource, {
      failUpload: true,
      releaseState: '731\tdesktop-v1.2.3\ttrue',
    })
    expect(failed.status, failed.stderr).toBe(37)
    expect(failed.calls).toContain('api repos/example/desktop/releases/731 --jq')
    expect(failed.calls).toContain('api --method DELETE repos/example/desktop/releases/731')
    expect(failed.calls).not.toContain('DELETE repos/example/desktop/git/ref/tags/')

    for (const releaseState of [
      '932\tdesktop-v1.2.3\ttrue',
      '731\tdesktop-v9.9.9\ttrue',
      '731\tdesktop-v1.2.3\tfalse',
    ]) {
      const changed = runPublishContract(publishSource, { failUpload: true, releaseState })
      expect(changed.status, changed.stderr).toBe(37)
      expect(changed.calls).not.toContain('api --method DELETE')
      expect(changed.stdout).toContain('Refusing to remove release id 731')
    }

    const succeeded = runPublishContract(publishSource)
    expect(succeeded.status, succeeded.stderr).toBe(0)
    expect(succeeded.calls).toContain('api --method POST repos/example/desktop/releases')
    expect(succeeded.calls).toContain('api --method PATCH repos/example/desktop/releases/731 -F draft=false --silent')
    expect(succeeded.calls).not.toContain('api --method DELETE')
  }, 20_000)
})

interface PublishContractOptions {
  readonly failUpload?: boolean
  readonly releaseState?: string
}

interface PublishContractResult {
  readonly status: number | null
  readonly calls: string
  readonly stdout: string
  readonly stderr: string
}

function runPublishContract(
  publishSource: string,
  options: PublishContractOptions = {},
): PublishContractResult {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-release-contract-'))
  try {
    const bin = join(root, 'bin')
    const runnerTemp = join(root, 'runner-temp')
    const callsPath = join(root, 'gh-calls.txt')
    mkdirSync(bin)
    mkdirSync(runnerTemp)
    const gh = join(bin, 'gh')
    writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_GH_LOG"
case "\${1:-}" in
  api)
    if [[ "$*" == *'/git/ref/tags/'* ]]; then
      printf 'commit\\t%s\\n' "$EXPECTED_SHA"
    elif [[ "$*" == *'releases?per_page=100'* ]]; then
      exit 0
    elif [[ "$*" == *'--method POST repos/example/desktop/releases'* ]]; then
      printf '731\\n'
    elif [[ "$*" == 'api --method PATCH repos/example/desktop/releases/731 -F draft=false --silent' ]]; then
      exit 0
    elif [[ "$*" == 'api --method DELETE repos/example/desktop/releases/731' ]]; then
      exit 0
    elif [[ "$*" == *'repos/example/desktop/releases/731 --jq'* ]]; then
      printf '%s\\n' "$MOCK_RELEASE_STATE"
    else
      printf 'unexpected gh api call: %s\\n' "$*" >&2
      exit 91
    fi
    ;;
  release)
    case "\${2:-}" in
      upload)
        if [ "$MOCK_FAIL_UPLOAD" = 1 ]; then exit 37; fi
        ;;
      view)
        if [[ "$*" == *'--json databaseId'* ]]; then
          printf '731\\n'
        elif [[ "$*" == *'--json assets'* ]]; then
          printf '%s\\n' \\
            "Unofficial-DeepSeek-Harness-Desktop_\${VERSION}_macos-arm64_app-adhoc_dmg-unsigned.dmg" \\
            "Unofficial-DeepSeek-Harness-Desktop_\${VERSION}_windows-x64_unsigned-setup.exe" \\
            "Unofficial-DeepSeek-Harness-Desktop_\${VERSION}_linux-x64_unsigned.deb" \\
            'SHA256SUMS.txt'
        else
          printf 'unexpected gh release view call: %s\\n' "$*" >&2
          exit 92
        fi
        ;;
      *)
        printf 'unexpected gh release call: %s\\n' "$*" >&2
        exit 93
        ;;
    esac
    ;;
  *)
    printf 'unexpected gh call: %s\\n' "$*" >&2
    exit 94
    ;;
esac
`, { mode: 0o755 })
    const result = spawnSync('bash', ['-c', publishSource], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPECTED_SHA: '0123456789abcdef0123456789abcdef01234567',
        GH_REPO: 'example/desktop',
        GH_TOKEN: 'test-token',
        MOCK_FAIL_UPLOAD: options.failUpload === true ? '1' : '0',
        MOCK_GH_LOG: callsPath,
        MOCK_RELEASE_STATE: options.releaseState ?? '731\tdesktop-v1.2.3\ttrue',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: runnerTemp,
        TAG: 'desktop-v1.2.3',
        VERSION: '1.2.3',
      },
    })
    return {
      status: result.status,
      calls: readFileSync(callsPath, 'utf8'),
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

function job(jobs: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!isRecord(jobs[name])) {
    throw new TypeError(`desktop release workflow must define ${name}`)
  }
  return jobs[name]
}

function step(jobValue: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!Array.isArray(jobValue.steps)) {
    throw new TypeError('desktop workflow job must define steps')
  }
  const value = jobValue.steps.filter(isRecord).find(candidate => candidate.name === name)
  if (!isRecord(value)) {
    throw new TypeError(`desktop workflow must define the ${name} step`)
  }
  return value
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name]
  if (typeof field !== 'string') {
    throw new TypeError(`${name} must be a string`)
  }
  return field
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
