/** A shell-free pnpm invocation that works on Windows and Unix hosts. */
export interface PnpmInvocation {
  readonly command: string
  readonly args: string[]
}

/**
 * Run pnpm through the JavaScript entrypoint provided by the parent package script.
 * Windows cannot spawn the `pnpm.cmd` shim with `shell: false`.
 * @param args Arguments to pass to pnpm.
 * @param entrypoint pnpm's JavaScript entrypoint, normally `npm_execpath`.
 * @param nodeExecutable Node.js executable used to launch the entrypoint.
 * @returns A command and arguments safe to pass to `spawn` without a shell.
 */
export function pnpmInvocation(
  args: readonly string[],
  entrypoint = process.env.npm_execpath,
  nodeExecutable = process.execPath,
): PnpmInvocation {
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('npm_execpath is unavailable; invoke the desktop build through a pnpm package script.')
  }
  return { command: nodeExecutable, args: [entrypoint, ...args] }
}
