/** Build a distributable desktop bundle without exposing local source paths. */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { pnpmInvocation } from './pnpm-invocation.ts'

const root = resolve(import.meta.dirname, '..')

interface BuildCli {
  readonly help: boolean
  readonly prepareOnly: boolean
  readonly skipPrepare: boolean
  readonly tauriArgs: string[]
}

const BUNDLES: Partial<Record<NodeJS.Platform, ReadonlySet<string>>> = {
  darwin: new Set(['app', 'dmg']),
  linux: new Set(['deb']),
  win32: new Set(['nsis']),
}

const DEFAULT_BUNDLES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'app,dmg',
  linux: 'deb',
  win32: 'nsis',
}

function usage(): string {
  return [
    'Usage: pnpm run desktop:build [-- --bundles <formats> | --prepare-only | --skip-prepare]',
    '',
    '  --bundles  comma-separated native bundle formats, such as app,dmg or deb.',
    '  --prepare-only  build the Web application and verified native sidecar, then stop.',
    '  --skip-prepare  use an existing Web build and native sidecar for the Tauri build.',
    '  --help     print this help.',
    '',
    'The application and sidecar are built for the current native host only.',
  ].join('\n')
}

/**
 * Parse the desktop wrapper options and reject bundle formats from another platform.
 * @param argv Arguments passed after the package script separator.
 * @param platform Operating system reported by the Node.js host.
 * @returns Help state and arguments safe to forward to `tauri build`.
 */
export function parseBuildCli(argv: readonly string[], platform: NodeJS.Platform): BuildCli {
  let values: {
    readonly bundles?: string
    readonly help?: boolean
    readonly 'prepare-only'?: boolean
    readonly 'skip-prepare'?: boolean
  }
  try {
    // pnpm 11 preserves the conventional script-argument separator, while a
    // direct tsx invocation does not. Treat the one leading sentinel equally.
    const args = argv[0] === '--' ? argv.slice(1) : [...argv]
    values = parseArgs({
      args,
      options: {
        bundles: { type: 'string' },
        'prepare-only': { type: 'boolean', default: false },
        'skip-prepare': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      } as const,
      strict: true,
    }).values
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`)
  }
  const prepareOnly = values['prepare-only'] === true
  const skipPrepare = values['skip-prepare'] === true
  if (prepareOnly && skipPrepare) throw new Error('--prepare-only and --skip-prepare are mutually exclusive.')
  if (prepareOnly && values.bundles !== undefined) {
    throw new Error('--prepare-only does not accept --bundles because it does not invoke Tauri.')
  }
  const supported = BUNDLES[platform]
  const defaultBundles = DEFAULT_BUNDLES[platform]
  if (supported === undefined || defaultBundles === undefined) {
    throw new Error(`unsupported host platform ${platform}; desktop builds require macOS, Windows, or Linux.`)
  }
  if (values.help === true) return { help: true, prepareOnly: false, skipPrepare: false, tauriArgs: [] }
  if (values.bundles === undefined) {
    return {
      help: false,
      prepareOnly,
      skipPrepare,
      tauriArgs: prepareOnly ? [] : ['--bundles', defaultBundles],
    }
  }
  const bundles = values.bundles.split(',').map(value => value.trim()).filter(Boolean)
  if (bundles.length === 0) throw new Error('--bundles must select at least one native bundle format.')
  const unsupported = bundles.filter(bundle => !supported.has(bundle))
  if (unsupported.length > 0) {
    throw new Error(
      `unsupported ${platform} bundle format${unsupported.length === 1 ? '' : 's'} ${unsupported.join(', ')}; `
      + `supported formats are ${[...supported].join(', ')}.`,
    )
  }
  return { help: false, prepareOnly, skipPrepare, tauriArgs: ['--bundles', bundles.join(',')] }
}

async function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const invocation = pnpmInvocation(args)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(
        code === null
          ? `pnpm ${args.join(' ')} stopped by signal ${signal ?? 'unknown'}`
          : `pnpm ${args.join(' ')} failed with exit code ${code}`,
      ))
    })
  })
}

function distributableCargoEnv(): NodeJS.ProcessEnv {
  const inherited = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f')
    ?? process.env.RUSTFLAGS?.trim().split(/\s+/).filter(Boolean)
    ?? []
  const env = { ...process.env }
  delete env.RUSTFLAGS
  env.CARGO_ENCODED_RUSTFLAGS = [
    ...inherited,
    `--remap-path-prefix=${root}=dsh-source`,
    `--remap-path-prefix=${homedir()}=user-home`,
  ].join('\x1f')
  return env
}

async function main(): Promise<void> {
  const cli = parseBuildCli(process.argv.slice(2), process.platform)
  if (cli.help) {
    console.log(usage())
    return
  }
  if (!cli.skipPrepare) {
    await run(['run', 'build'])
    await run(['run', 'build:desktop-sidecar', '--skip-build'])
  }
  if (cli.prepareOnly) return
  await run(['exec', 'tauri', 'build', ...cli.tauriArgs], distributableCargoEnv())
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) await main()
