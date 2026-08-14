/** Desktop-only API authentication captured before environment snapshotting. */

const DESKTOP_API_TOKEN_ENV = 'DSH_DESKTOP_API_TOKEN'
const DESKTOP_API_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const DESKTOP_API_PROTOCOL_PATTERN = /^[\t ]*dsh-v1[\t ]*,[\t ]*dsh-auth-([0-9a-f]{64})[\t ]*$/

/** The two wire forms the native WebView wrapper attaches. */
export type DesktopApiTransport = 'http' | 'websocket'

/** Boolean-only oracle exposed to the Connection host plugin. */
export interface DesktopApiAuthorizer {
  readonly authorize: (
    transport: DesktopApiTransport,
    credentialHeader: string | undefined,
  ) => boolean
}

/** Compare one already-shaped token without returning at its first mismatch. */
function tokenEquals(candidate: string, expected: string): boolean {
  if (!DESKTOP_API_TOKEN_PATTERN.test(candidate) || candidate.length !== expected.length) return false
  let mismatch = 0
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= candidate.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return mismatch === 0
}

/**
 * Consume the native secret before the launch-environment snapshot or dynamic
 * plugin imports. The returned frozen object reveals only a 256-bit equality
 * oracle; the token remains private to its closure.
 * @param environment - inherited process environment.
 * @returns the authorizer, or undefined for an ordinary `dsh web` invocation.
 */
export function consumeDesktopApiAuthorizer(
  environment: NodeJS.ProcessEnv = process.env,
): DesktopApiAuthorizer | undefined {
  const token = environment[DESKTOP_API_TOKEN_ENV]
  delete environment.DSH_DESKTOP_API_TOKEN
  if (token === undefined) return undefined
  if (!DESKTOP_API_TOKEN_PATTERN.test(token)) {
    throw new Error(`dsh: ${DESKTOP_API_TOKEN_ENV} must contain 32 random bytes as lowercase hex`)
  }
  return Object.freeze({
    authorize(transport: DesktopApiTransport, credentialHeader: string | undefined): boolean {
      if (credentialHeader === undefined) return false
      if (transport === 'http') {
        const prefix = 'Bearer '
        return credentialHeader.startsWith(prefix)
          && tokenEquals(credentialHeader.slice(prefix.length), token)
      }
      const protocolMatch = DESKTOP_API_PROTOCOL_PATTERN.exec(credentialHeader)
      const authToken = protocolMatch?.[0] === credentialHeader ? protocolMatch[1] : undefined
      return authToken !== undefined && tokenEquals(authToken, token)
    },
  })
}
