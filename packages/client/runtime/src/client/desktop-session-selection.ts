import type { ObservableSnapshot } from './contract/store.ts'

const SELECTION_STORAGE_KEY = 'dsh.sessions.current'
const SELECTION_COOKIE_NAME = 'dsh.desktop.sessions.current'
const MAX_SELECTION_COOKIE_BYTES = 2_048
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

type SelectionRecord = Record<string, unknown>

function isMacDesktop(): boolean {
  return (globalThis as { __DSH_DESKTOP_PLATFORM__?: unknown })
    .__DSH_DESKTOP_PLATFORM__ === 'macos'
}

function isRecord(value: unknown): value is SelectionRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: SelectionRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length !== 0
}

function encodedSelection(raw: string): string | undefined {
  try {
    const encoded = encodeURIComponent(raw)
    return encoded.length <= MAX_SELECTION_COOKIE_BYTES ? encoded : undefined
  } catch {
    return undefined
  }
}

function isValidSelection(raw: string): boolean {
  if (encodedSelection(raw) === undefined) return false
  try {
    const selection: unknown = JSON.parse(raw)
    if (!isRecord(selection) || !hasOnlyKeys(selection, ['sessionId', 'subagentAddress'])) {
      return false
    }
    if (selection.sessionId === undefined) return selection.subagentAddress === undefined
    if (!isNonemptyString(selection.sessionId)) return false
    if (selection.subagentAddress === undefined) return true
    if (!isRecord(selection.subagentAddress)
      || !hasOnlyKeys(selection.subagentAddress, [
        'parentSessionId', 'childSessionId', 'mode',
      ])) return false
    return isNonemptyString(selection.subagentAddress.parentSessionId)
      && selection.subagentAddress.childSessionId === selection.sessionId
      && (selection.subagentAddress.mode === 'one-shot'
        || selection.subagentAddress.mode === 'continuable')
  } catch {
    return false
  }
}

function expireSelectionCookie(): void {
  try {
    document.cookie = `${SELECTION_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Strict`
  } catch {
    // The ordinary origin-local store remains usable when cookies are blocked.
  }
}

function readSelectionCookie(): string | undefined {
  if (!isMacDesktop() || typeof document === 'undefined') return undefined
  try {
    const prefix = `${SELECTION_COOKIE_NAME}=`
    const encoded = document.cookie
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(prefix))
      ?.slice(prefix.length)
    if (encoded === undefined) return undefined
    if (encoded.length > MAX_SELECTION_COOKIE_BYTES) {
      expireSelectionCookie()
      return undefined
    }
    const raw = decodeURIComponent(encoded)
    if (isValidSelection(raw)) return raw
    expireSelectionCookie()
  } catch {
    expireSelectionCookie()
  }
  return undefined
}

function writeSelectionCookie(raw: string): void {
  if (!isMacDesktop() || typeof document === 'undefined') return
  if (!isValidSelection(raw)) {
    expireSelectionCookie()
    return
  }
  const encoded = encodedSelection(raw)
  if (encoded === undefined) return
  try {
    document.cookie = `${SELECTION_COOKIE_NAME}=${encoded}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Strict`
  } catch {
    // Cookie persistence is an optional desktop migration aid. The ordinary
    // origin-scoped localStorage store remains authoritative when it fails.
  }
}

/**
 * Seed the current random-port origin from the macOS WebView's host-scoped
 * cookie. An existing same-origin localStorage value is migrated once when
 * the durable cookie does not exist yet.
 */
export function restoreMacDesktopSessionSelection(): void {
  if (!isMacDesktop() || typeof localStorage === 'undefined') return
  try {
    const durable = readSelectionCookie()
    if (durable !== undefined) {
      localStorage.setItem(SELECTION_STORAGE_KEY, durable)
      return
    }
    const local = localStorage.getItem(SELECTION_STORAGE_KEY)
    if (local === null) return
    if (isValidSelection(local)) {
      writeSelectionCookie(local)
    } else {
      localStorage.removeItem(SELECTION_STORAGE_KEY)
    }
  } catch {
    // Keep startup usable when the WebView blocks either storage mechanism.
  }
}

/**
 * Mirror later selection writes to a cookie shared by all loopback ports.
 * @param selection - current Session selection store.
 * @returns disposer that stops mirroring later selection changes.
 */
export function mirrorMacDesktopSessionSelection(
  selection: ObservableSnapshot<unknown>,
): () => void {
  if (!isMacDesktop()) return () => {}
  return selection.subscribe(() => {
    writeSelectionCookie(JSON.stringify(selection.getSnapshot()))
  })
}

/**
 * Check whether the first macOS desktop migration still needs a real Session fallback.
 * @returns true only when no durable desktop selection exists.
 */
export function needsMacDesktopSessionSelectionFallback(): boolean {
  return isMacDesktop() && readSelectionCookie() === undefined
}
