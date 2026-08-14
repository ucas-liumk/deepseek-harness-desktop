/** Bounded, one-use authorization for native browser download navigations. */

import { randomBytes } from 'node:crypto'

export const DESKTOP_DOWNLOAD_TICKET_HEADER = 'x-dsh-desktop-download-ticket'
export const DESKTOP_DOWNLOAD_TICKET_PARAMETER = 'desktopDownloadTicket'
export const DESKTOP_DOWNLOAD_TICKET_TTL_MS = 30_000
export const DESKTOP_DOWNLOAD_TICKET_LIMIT = 32

const TICKET_PATTERN = /^[0-9a-f]{64}$/
const URL_BASE = 'http://dsh.internal'

interface TicketEntry {
  readonly expiresAt: number
  readonly target: string
}

interface ParsedTarget {
  readonly target: string
  readonly tickets: readonly string[]
}

interface RawResource {
  readonly pathname: string
  readonly query: string
}

export type DesktopDownloadTicketAuthorization = 'absent' | 'accepted' | 'rejected'

/** Decode only a query key; malformed percent-encoding remains a non-ticket key. */
function decodedQueryName(name: string): string | undefined {
  try {
    return decodeURIComponent(name.replace(/\+/g, ' '))
  } catch {
    return undefined
  }
}

/** Preserve Node's origin-form request path; issued absolute URLs are already canonical Fetch URLs. */
function rawResource(input: string | URL): RawResource {
  if (typeof input !== 'string' || !input.startsWith('/')) {
    const url = new URL(input, URL_BASE)
    return {
      pathname: url.pathname,
      query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
    }
  }
  const fragment = input.indexOf('#')
  const resource = fragment < 0 ? input : input.slice(0, fragment)
  const separator = resource.indexOf('?')
  return separator < 0
    ? { pathname: resource, query: '' }
    : { pathname: resource.slice(0, separator), query: resource.slice(separator + 1) }
}

/** Parse the URL while preserving every non-ticket query component verbatim. */
function parseTarget(input: string | URL): ParsedTarget {
  const resource = rawResource(input)
  if (resource.query === '') return { target: resource.pathname, tickets: [] }
  const kept: string[] = []
  const tickets: string[] = []
  for (const component of resource.query.split('&')) {
    const separator = component.indexOf('=')
    const name = separator < 0 ? component : component.slice(0, separator)
    if (name === DESKTOP_DOWNLOAD_TICKET_PARAMETER
      || decodedQueryName(name) === DESKTOP_DOWNLOAD_TICKET_PARAMETER) {
      tickets.push(separator < 0 ? '' : component.slice(separator + 1))
    } else {
      kept.push(component)
    }
  }
  return {
    target: `${resource.pathname}${kept.length === 0 ? '' : `?${kept.join('&')}`}`,
    tickets,
  }
}

/** Whether a request explicitly selected the desktop-ticket authentication path. */
export function hasDesktopDownloadTicket(input: string | URL): boolean {
  return parseTarget(input).tickets.length !== 0
}

/** Return the bound path/query after removing every exact ticket component. */
export function withoutDesktopDownloadTicket(input: string | URL): string {
  return parseTarget(input).target
}

/** In-memory ticket issuer owned by one mounted Connection plugin instance. */
export class DesktopDownloadTickets {
  private readonly entries = new Map<string, TicketEntry>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly mint: () => string = () => randomBytes(32).toString('hex'),
  ) {}

  /** Mint one 256-bit ticket bound to the exact path and non-ticket query. */
  issue(input: string | URL): string {
    const parsed = parseTarget(input)
    if (parsed.tickets.length !== 0) throw new Error('desktop download ticket target already contains a ticket')
    const now = this.now()
    this.prune(now)
    while (this.entries.size >= DESKTOP_DOWNLOAD_TICKET_LIMIT) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    for (let attempt = 0; attempt < DESKTOP_DOWNLOAD_TICKET_LIMIT; attempt += 1) {
      const ticket = this.mint()
      if (!TICKET_PATTERN.test(ticket)) throw new Error('desktop download ticket generator returned an invalid token')
      if (this.entries.has(ticket)) continue
      this.entries.set(ticket, {
        expiresAt: now + DESKTOP_DOWNLOAD_TICKET_TTL_MS,
        target: parsed.target,
      })
      return ticket
    }
    throw new Error('desktop download ticket generator exhausted collision retries')
  }

  /** Validate and consume the ticket selected by one incoming request. */
  authorize(method: string | undefined, input: string | URL): DesktopDownloadTicketAuthorization {
    const parsed = parseTarget(input)
    if (parsed.tickets.length === 0) return 'absent'
    if (method !== 'GET' || parsed.tickets.length !== 1) return 'rejected'
    const ticket = parsed.tickets[0]
    if (ticket === undefined || !TICKET_PATTERN.test(ticket)) return 'rejected'
    const now = this.now()
    this.prune(now)
    const entry = this.entries.get(ticket)
    if (entry === undefined) return 'rejected'
    this.entries.delete(ticket)
    return entry.target === parsed.target && now < entry.expiresAt ? 'accepted' : 'rejected'
  }

  private prune(now: number): void {
    for (const [ticket, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(ticket)
    }
  }
}
