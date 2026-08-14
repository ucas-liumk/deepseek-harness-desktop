import { describe, expect, it } from 'vitest'
import {
  DESKTOP_DOWNLOAD_TICKET_LIMIT,
  DESKTOP_DOWNLOAD_TICKET_TTL_MS,
  DesktopDownloadTickets,
  hasDesktopDownloadTicket,
} from '../src/desktop-download-ticket.ts'

function token(index: number): string {
  return index.toString(16).padStart(64, '0')
}

function target(ticket: string, query = 'sessionId=root&includeDescendants=true'): string {
  return `/api/session.export?${query}&desktopDownloadTicket=${ticket}`
}

describe('DesktopDownloadTickets', () => {
  it('issues a 256-bit-looking ticket and consumes it on one exact GET', () => {
    const tickets = new DesktopDownloadTickets(() => 1_000, () => token(1))
    const issued = tickets.issue('/api/session.export?sessionId=root&includeDescendants=true')

    expect(issued).toMatch(/^[0-9a-f]{64}$/)
    expect(tickets.authorize('GET', target(issued))).toBe('accepted')
    expect(tickets.authorize('GET', target(issued))).toBe('rejected')
    expect(tickets.authorize('GET', '/api/session.export?sessionId=root')).toBe('absent')
  })

  it('rejects wrong methods, duplicates, malformed values, and exact-target changes', () => {
    let next = 1
    const tickets = new DesktopDownloadTickets(() => 1_000, () => token(next++))

    const wrongMethod = tickets.issue('/api/session.export?sessionId=root')
    expect(tickets.authorize('HEAD', target(wrongMethod, 'sessionId=root'))).toBe('rejected')

    const duplicate = tickets.issue('/api/session.export?sessionId=root')
    expect(tickets.authorize(
      'GET', `${target(duplicate, 'sessionId=root')}&desktopDownloadTicket=${duplicate}`,
    )).toBe('rejected')

    expect(tickets.authorize(
      'GET', target('not-a-ticket', 'sessionId=root'),
    )).toBe('rejected')

    const changedQuery = tickets.issue('/api/session.export?sessionId=root&includeDescendants=true')
    expect(tickets.authorize(
      'GET', target(changedQuery, 'includeDescendants=true&sessionId=root'),
    )).toBe('rejected')
    expect(tickets.authorize('GET', target(changedQuery))).toBe('rejected')

    const changedPath = tickets.issue('/api/session.export?sessionId=root')
    expect(tickets.authorize(
      'GET', `/api/session.list?sessionId=root&desktopDownloadTicket=${changedPath}`,
    )).toBe('rejected')

    const nonCanonicalPath = tickets.issue('/api/session.export?sessionId=root')
    expect(tickets.authorize(
      'GET', `/api/segment/../session.export?sessionId=root&desktopDownloadTicket=${nonCanonicalPath}`,
    )).toBe('rejected')
  })

  it('expires tickets after 30 seconds', () => {
    let now = 10_000
    const tickets = new DesktopDownloadTickets(() => now, () => token(1))
    const issued = tickets.issue('/api/session.export?sessionId=root')

    now += DESKTOP_DOWNLOAD_TICKET_TTL_MS
    expect(tickets.authorize('GET', target(issued, 'sessionId=root'))).toBe('rejected')
  })

  it('bounds live tickets at 32 by evicting the oldest insertion', () => {
    let next = 1
    const tickets = new DesktopDownloadTickets(() => 1_000, () => token(next++))
    const issued = Array.from(
      { length: DESKTOP_DOWNLOAD_TICKET_LIMIT + 1 },
      (_, index) => tickets.issue(`/api/session.export?sessionId=${String(index)}`),
    )

    expect(tickets.authorize('GET', target(issued[0]!, 'sessionId=0'))).toBe('rejected')
    expect(tickets.authorize('GET', target(issued[1]!, 'sessionId=1'))).toBe('accepted')
    expect(tickets.authorize(
      'GET', target(issued[DESKTOP_DOWNLOAD_TICKET_LIMIT]!, `sessionId=${String(DESKTOP_DOWNLOAD_TICKET_LIMIT)}`),
    )).toBe('accepted')
  })

  it('recognizes only the exact ticket query key and refuses ticket-bearing issue targets', () => {
    const tickets = new DesktopDownloadTickets(() => 1_000, () => token(1))
    expect(hasDesktopDownloadTicket('/api/session.export?desktopDownloadTicket=x')).toBe(true)
    expect(hasDesktopDownloadTicket('/api/session.export?%64esktopDownloadTicket=x')).toBe(true)
    expect(hasDesktopDownloadTicket('/api/session.export?desktopdownloadticket=x')).toBe(false)
    expect(() => tickets.issue('/api/session.export?desktopDownloadTicket=x'))
      .toThrow('target already contains a ticket')
  })
})
