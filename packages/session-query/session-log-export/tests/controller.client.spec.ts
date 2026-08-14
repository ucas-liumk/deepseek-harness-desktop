// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  downloadUrl, SessionLogDownloadController, sessionLogZipFilename,
} from '../src/client/controller.ts'

const SID = 'session-export-controller' as SessionId

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SessionLogDownloadController', () => {
  it('downloads the host ZIP and publishes one shared success state', async () => {
    const fetcher = vi.fn(async () => new Response('zip', { status: 200 }))
    const save = vi.fn()
    const controller = new SessionLogDownloadController(fetcher, save)

    await controller.download(SID)

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.pathname).toBe('/api/session.export')
    expect(url.searchParams.get('sessionId')).toBe(SID)
    expect(url.searchParams.get('includeDescendants')).toBe('true')
    expect(init.method).toBe('HEAD')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(save).toHaveBeenCalledWith(
      url.toString(),
      'dsh-session-session-export-controller.zip',
      expect.any(AbortSignal),
    )
    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      open: true, status: 'success', error: null,
    })
  })

  it('passes a valid desktop HEAD ticket only to the save URL', async () => {
    vi.stubGlobal('__DSH_DESKTOP_API_AUTH__', true)
    const ticket = 'a'.repeat(64)
    let headUrl = ''
    const fetcher = vi.fn(async (input: string | URL) => {
      headUrl = input.toString()
      return new Response(null, {
        status: 200,
        headers: { 'x-dsh-desktop-download-ticket': ticket },
      })
    })
    const save = vi.fn()
    const controller = new SessionLogDownloadController(fetcher, save)

    await controller.download(SID)

    expect(new URL(headUrl).searchParams.has('desktopDownloadTicket')).toBe(false)
    const savedUrl = new URL(String(save.mock.calls[0]?.[0]))
    expect(savedUrl.searchParams.get('desktopDownloadTicket')).toBe(ticket)
    expect(savedUrl.searchParams.get('sessionId')).toBe(SID)
    expect(controller.store.getSnapshot().bySession[SID]?.status).toBe('success')
  })

  it('fails closed when a desktop HEAD response omits or malforms its ticket', async () => {
    vi.stubGlobal('__DSH_DESKTOP_API_AUTH__', true)
    for (const ticket of [undefined, 'not-a-ticket', 'A'.repeat(64)]) {
      const save = vi.fn()
      const controller = new SessionLogDownloadController(
        async () => new Response(null, {
          status: 200,
          ...(ticket === undefined
            ? {}
            : { headers: { 'x-dsh-desktop-download-ticket': ticket } }),
        }),
        save,
      )

      await controller.download(SID)

      expect(save).not.toHaveBeenCalled()
      expect(controller.store.getSnapshot().bySession[SID]?.error)
        .toBe('Export failed: desktop download ticket is missing or invalid.')
    }
  })

  it('keeps the ordinary web save URL unchanged even if a server sends a ticket header', async () => {
    const save = vi.fn()
    const controller = new SessionLogDownloadController(
      async () => new Response(null, {
        status: 200,
        headers: { 'x-dsh-desktop-download-ticket': 'a'.repeat(64) },
      }),
      save,
    )

    await controller.download(SID)

    const savedUrl = new URL(String(save.mock.calls[0]?.[0]))
    expect(savedUrl.searchParams.has('desktopDownloadTicket')).toBe(false)
  })

  it('collapses concurrent gestures and preserves a dismissed dialog', async () => {
    const response = Promise.withResolvers<Response>()
    const fetcher = vi.fn(() => response.promise)
    const controller = new SessionLogDownloadController(fetcher, vi.fn())

    const first = controller.download(SID)
    const second = controller.download(SID)
    expect(first).toBe(second)
    controller.dismiss(SID)
    response.resolve(new Response('zip', { status: 200 }))
    await first

    expect(fetcher).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().bySession[SID]?.open).toBe(false)
    controller.dismiss(SID)
  })

  it('waits for native desktop completion and publishes the actual filename', async () => {
    const saved = Promise.withResolvers<string>()
    const save = vi.fn(() => saved.promise)
    const controller = new SessionLogDownloadController(
      async () => new Response('zip', { status: 200 }), save,
    )

    const download = controller.download(SID)
    await vi.waitFor(() => { expect(save).toHaveBeenCalledOnce() })
    expect(controller.store.getSnapshot().bySession[SID]?.status).toBe('downloading')
    saved.resolve('dsh-session-session-export-controller (1).zip')
    await download

    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      open: true,
      status: 'success',
      error: null,
      filename: 'dsh-session-session-export-controller (1).zip',
    })
  })

  it('publishes HTTP and transport failures without leaking rejections', async () => {
    const http = new SessionLogDownloadController(
      async () => new Response('backend unavailable', { status: 500 }), vi.fn(),
    )
    await http.download(SID)
    expect(http.store.getSnapshot().bySession[SID]).toEqual({
      open: true,
      status: 'error',
      error: 'Export failed: HTTP 500 backend unavailable',
    })

    const transport = new SessionLogDownloadController(async () => { throw 'offline' }, vi.fn())
    await transport.download(SID)
    expect(transport.store.getSnapshot().bySession[SID]?.error).toBe('offline')

    transport.dismiss('absent' as SessionId)

    const emptyDetail = new SessionLogDownloadController(
      async () => ({
        ok: false, status: 503, text: async () => { throw new Error('body unavailable') },
      }) as unknown as Response,
      vi.fn(),
    )
    await emptyDetail.download(SID)
    expect(emptyDetail.store.getSnapshot().bySession[SID]?.error).toBe('Export failed: HTTP 503')
  })

  it('aborts active fetches on disposal and rejects later requests', async () => {
    let signal: AbortSignal | undefined
    const fetcher = vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined
      signal?.addEventListener('abort', () => {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      }, { once: true })
    }))
    const controller = new SessionLogDownloadController(fetcher, vi.fn())
    const pending = controller.download(SID)

    await controller.dispose()

    await expect(pending).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
    await expect(controller.download(SID)).resolves.toBeUndefined()
    await controller.dispose()
  })

  it('uses the null-origin fallback and default browser operations', async () => {
    vi.stubGlobal('location', { origin: 'null' })
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('zip'))
    vi.stubGlobal('fetch', fetcher)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const controller = new SessionLogDownloadController()

    await controller.download(SID)

    expect((fetcher.mock.calls[0]?.[0] as URL).origin).toBe('http://dsh.internal')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD' })
    expect(click).toHaveBeenCalledOnce()
  })

  it('defaults dialog openness when state is externally cleared before settlement', async () => {
    const success = Promise.withResolvers<Response>()
    const successful = new SessionLogDownloadController(() => success.promise, vi.fn())
    const successRun = successful.download(SID)
    successful.store.set({ bySession: {} })
    success.resolve(new Response('zip'))
    await successRun
    expect(successful.store.getSnapshot().bySession[SID]?.open).toBe(true)

    const failure = Promise.withResolvers<Response>()
    const failing = new SessionLogDownloadController(() => failure.promise, vi.fn())
    const failureRun = failing.download(SID)
    failing.store.set({ bySession: {} })
    failure.reject(new Error('failed after clear'))
    await failureRun
    expect(failing.store.getSnapshot().bySession[SID]?.open).toBe(true)
  })
})

describe('browser download helpers', () => {
  it('sanitizes the archive filename and hands the URL to a download anchor', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    expect(sessionLogZipFilename('a/b' as SessionId)).toBe('dsh-session-a_b.zip')
    const result = downloadUrl('http://host/api/session.export?sessionId=a', 'archive.zip')
    expect(result).toBeUndefined()
    expect(click).toHaveBeenCalledOnce()
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.href).toBe('http://host/api/session.export?sessionId=a')
    expect(anchor.download).toBe('archive.zip')
  })

  it('waits for the macOS download bridge and returns its collision-safe filename', async () => {
    vi.stubGlobal('__DSH_DESKTOP_PLATFORM__', 'macos')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const result = downloadUrl('http://host/api/session.export?sessionId=a', 'archive.zip')
    if (!(result instanceof Promise)) throw new Error('desktop download did not return a completion promise')
    expect(click).toHaveBeenCalledOnce()

    window.dispatchEvent(new CustomEvent('dsh:desktop-download', { detail: {
      url: 'http://host/api/session.export?sessionId=a',
      phase: 'finished',
      success: true,
      filename: 'archive (1).zip',
    } }))

    await expect(result).resolves.toBe('archive (1).zip')
  })

  it('ignores malformed and mismatched native download events before completion', async () => {
    vi.stubGlobal('__DSH_DESKTOP_PLATFORM__', 'macos')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const result = downloadUrl('http://host/api/session.export?sessionId=a', 'archive.zip')
    if (!(result instanceof Promise)) throw new Error('desktop download did not return a completion promise')

    window.dispatchEvent(new CustomEvent('dsh:desktop-download', { detail: {
      url: 'http://host/api/session.export?sessionId=b',
      phase: 'finished',
      success: true,
      filename: 'other.zip',
    } }))
    window.dispatchEvent(new CustomEvent('dsh:desktop-download', { detail: {
      url: 'http://host/api/session.export?sessionId=a', phase: 'finished', success: 'yes',
    } }))
    window.dispatchEvent(new CustomEvent('dsh:desktop-download', { detail: {
      url: 'http://host/api/session.export?sessionId=a', phase: 'finished', success: false,
    } }))

    await expect(result).rejects.toThrow('Desktop Session download failed.')
  })

  it('ignores legacy request and incomplete success events until authoritative completion', async () => {
    vi.stubGlobal('__DSH_DESKTOP_PLATFORM__', 'macos')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const result = downloadUrl('http://host/api/session.export?sessionId=a', 'archive.zip')
    if (!(result instanceof Promise)) throw new Error('desktop download did not return a completion promise')

    window.dispatchEvent(new CustomEvent('dsh:desktop-download', { detail: {
      url: 'http://host/api/session.export?sessionId=a',
      phase: 'finished',
      success: true,
    } }))
    window.dispatchEvent(new CustomEvent('dsh:desktop-download', { detail: {
      url: 'http://host/api/session.export?sessionId=a',
      phase: 'requested',
      filename: 'stale.zip',
    } }))
    window.dispatchEvent(new CustomEvent('dsh:desktop-download', { detail: {
      url: 'http://host/api/session.export?sessionId=a',
      phase: 'finished',
      success: true,
      filename: 'archive (2).zip',
    } }))

    await expect(result).resolves.toBe('archive (2).zip')
  })

  it('bounds the macOS completion wait even after a legacy request event', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('__DSH_DESKTOP_PLATFORM__', 'macos')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const result = downloadUrl('http://host/api/session.export?sessionId=a', 'archive.zip')
    if (!(result instanceof Promise)) throw new Error('desktop download did not return a completion promise')
    const rejection = expect(result).rejects.toThrow('Desktop Session download did not complete.')

    window.dispatchEvent(new CustomEvent('dsh:desktop-download', { detail: {
      url: 'http://host/api/session.export?sessionId=a',
      phase: 'requested',
      filename: 'archive (1).zip',
    } }))
    await vi.advanceTimersByTimeAsync(120_000)

    await rejection
  })

  it('cancels the macOS completion wait when the operation aborts', async () => {
    vi.stubGlobal('__DSH_DESKTOP_PLATFORM__', 'macos')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const abort = new AbortController()
    const result = downloadUrl(
      'http://host/api/session.export?sessionId=a', 'archive.zip', abort.signal,
    )
    if (!(result instanceof Promise)) throw new Error('desktop download did not return a completion promise')
    abort.abort()
    await expect(result).rejects.toThrow('Session download cancelled.')
  })
})
