/** Browser download state shared by the Session Header button and `/export`. */

import { createSnapshotStore, type SessionId, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Download phases presented by the shared modal. */
export type SessionLogDownloadStatus = 'downloading' | 'success' | 'error'

/** One Session's current download-dialog state. */
export interface SessionLogDownloadEntry {
  readonly open: boolean
  readonly status: SessionLogDownloadStatus
  readonly error: string | null
  readonly filename?: string
}

/** Download states keyed by the Session whose Header owns the dialog. */
export interface SessionLogDownloadState {
  bySession: Record<string, SessionLogDownloadEntry | undefined>
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type Save = (url: string, filename: string, signal?: AbortSignal) => void | string | Promise<void | string>

const INITIAL: SessionLogDownloadState = { bySession: {} }
const DESKTOP_DOWNLOAD_EVENT = 'dsh:desktop-download'
const DESKTOP_DOWNLOAD_COMPLETION_TIMEOUT_MS = 120_000
const DESKTOP_DOWNLOAD_TICKET_HEADER = 'x-dsh-desktop-download-ticket'
const DESKTOP_DOWNLOAD_TICKET_PARAMETER = 'desktopDownloadTicket'
const DESKTOP_DOWNLOAD_TICKET_PATTERN = /^[0-9a-f]{64}$/

interface DesktopDownloadEvent {
  readonly url: string
  readonly phase: 'finished'
  readonly filename?: string
  readonly success: boolean
}

/**
 * Collapse an untrusted Session id into the filename convention owned by the host endpoint.
 * @param sessionId - Session whose archive is downloaded.
 * @returns one safe browser download filename.
 */
export function sessionLogZipFilename(sessionId: SessionId): string {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
}

/**
 * Hand a Host URL to the browser download manager or the macOS desktop completion bridge.
 * @param url - same-origin Host download URL.
 * @param filename - browser download filename.
 * @param signal - optional lifecycle cancellation for the desktop completion bridge.
 * @returns the actual desktop filename after bounded native completion, or immediately in a browser.
 */
export function downloadUrl(url: string, filename: string, signal?: AbortSignal): void | Promise<string> {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  const desktop = (globalThis as typeof globalThis & {
    __DSH_DESKTOP_PLATFORM__?: unknown
  }).__DSH_DESKTOP_PLATFORM__ === 'macos'
  if (!desktop) {
    anchor.click()
    return
  }
  return new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(completionTimer)
      window.removeEventListener(DESKTOP_DOWNLOAD_EVENT, onDownload)
      signal?.removeEventListener('abort', onAbort)
    }
    const settle = (action: () => void): void => {
      cleanup()
      action()
    }
    const onAbort = (): void => {
      settle(() => { reject(new Error('Session download cancelled.')) })
    }
    const onDownload = (event: Event): void => {
      if (!(event instanceof CustomEvent) || !isDesktopDownloadEvent(event.detail)) return
      const detail = event.detail
      if (detail.url !== anchor.href) return
      settle(() => {
        if (detail.success && detail.filename !== undefined) resolve(detail.filename)
        else reject(new Error('Desktop Session download failed.'))
      })
    }
    const completionTimer = setTimeout(() => {
      settle(() => { reject(new Error('Desktop Session download did not complete.')) })
    }, DESKTOP_DOWNLOAD_COMPLETION_TIMEOUT_MS)
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    window.addEventListener(DESKTOP_DOWNLOAD_EVENT, onDownload)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      anchor.click()
    } catch (error: unknown) {
      settle(() => { reject(error instanceof Error ? error : new Error(String(error))) })
    }
  })
}

function isDesktopDownloadEvent(value: unknown): value is DesktopDownloadEvent {
  if (value === null || typeof value !== 'object') return false
  const detail = value as Partial<DesktopDownloadEvent>
  if (typeof detail.url !== 'string') return false
  return detail.phase === 'finished'
    && typeof detail.success === 'boolean'
    && (!detail.success
      || (typeof detail.filename === 'string' && detail.filename.length !== 0))
}

/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

/** Native shell fact set by the immutable authentication bootstrap. */
function desktopApiAuthenticationEnabled(): boolean {
  return (globalThis as typeof globalThis & {
    __DSH_DESKTOP_API_AUTH__?: unknown
  }).__DSH_DESKTOP_API_AUTH__ === true
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns one in-flight browser download per Session and publishes modal state. */
export class SessionLogDownloadController {
  /** uSES-safe state source shared by every Session-scoped modal contribution. */
  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  /**
   * @param fetcher - HTTP carrier used to read the host-streamed ZIP.
   * @param save - browser save operation.
   */
  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly save: Save = downloadUrl,
  ) {}

  /**
   * Download one Session tree; concurrent gestures for the same Session share one operation.
   * @param sessionId - root Session whose ZIP includes descendants and attachments.
   * @returns after browser handoff, bounded native completion, an error state, or a late post-disposal no-op.
   */
  download(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, abort.signal).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, { abort, done })
    return done
  }

  /**
   * Close one Session's dialog without cancelling an in-flight browser download.
   * @param sessionId - Session whose modal closes.
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  /**
   * Abort active fetches and reach quiescence.
   * @returns after every active operation settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async run(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, { open: true, status: 'downloading', error: null })
    try {
      const url = new URL('/api/session.export', hostBase())
      url.searchParams.set('sessionId', sessionId)
      url.searchParams.set('includeDescendants', 'true')
      const desktopApiAuthentication = desktopApiAuthenticationEnabled()
      const response = await this.fetcher(url, {
        method: 'HEAD',
        signal,
        ...(desktopApiAuthentication ? { cache: 'no-store' } : {}),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
      }
      if (desktopApiAuthentication) {
        const ticket = response.headers.get(DESKTOP_DOWNLOAD_TICKET_HEADER)
        if (ticket === null || !DESKTOP_DOWNLOAD_TICKET_PATTERN.test(ticket)) {
          throw new Error('Export failed: desktop download ticket is missing or invalid.')
        }
        url.searchParams.set(DESKTOP_DOWNLOAD_TICKET_PARAMETER, ticket)
      }
      const filename = await this.save(url.toString(), sessionLogZipFilename(sessionId), signal)
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, {
        open, status: 'success', error: null,
        ...(typeof filename === 'string' ? { filename } : {}),
      })
    } catch (error: unknown) {
      if (signal.aborted) return
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'error', error: messageOf(error) })
    }
  }

  private publish(sessionId: SessionId, entry: SessionLogDownloadEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }
}
