import { describe, expect, it } from 'vitest'
import { consumeDesktopApiAuthorizer } from '../src/desktop-api-auth.ts'

describe('desktop API authentication bootstrap', () => {
  it('removes the secret and returns only a frozen equality oracle', () => {
    const token = 'a'.repeat(64)
    const environment = { DSH_DESKTOP_API_TOKEN: token }
    const authorizer = consumeDesktopApiAuthorizer(environment)

    expect(environment).not.toHaveProperty('DSH_DESKTOP_API_TOKEN')
    expect(authorizer).toBeDefined()
    expect(Object.isFrozen(authorizer)).toBe(true)
    expect(Reflect.ownKeys(authorizer!)).toEqual(['authorize'])
    expect(authorizer!.authorize('http', undefined)).toBe(false)
  })

  it('accepts only one exact HTTP Bearer credential', () => {
    const token = 'a'.repeat(64)
    const authorizer = consumeDesktopApiAuthorizer({ DSH_DESKTOP_API_TOKEN: token })!

    expect(authorizer.authorize('http', `Bearer ${token}`)).toBe(true)
    for (const credential of [
      token,
      `bearer ${token}`,
      `Bearer  ${token}`,
      `Bearer ${'b'.repeat(64)}`,
      `Bearer ${token}, Bearer ${token}`,
      `Bearer ${token} `,
    ]) {
      expect(authorizer.authorize('http', credential)).toBe(false)
    }
  })

  it('accepts only the ordered pair of exact WebSocket subprotocols', () => {
    const token = 'a'.repeat(64)
    const authorizer = consumeDesktopApiAuthorizer({ DSH_DESKTOP_API_TOKEN: token })!

    expect(authorizer.authorize('websocket', `dsh-v1, dsh-auth-${token}`)).toBe(true)
    expect(authorizer.authorize('websocket', `dsh-v1,dsh-auth-${token}`)).toBe(true)
    expect(authorizer.authorize('websocket', ` dsh-v1 , dsh-auth-${token} `)).toBe(true)
    for (const protocols of [
      `dsh-auth-${token}`,
      `dsh-v1, dsh-auth-${'b'.repeat(64)}`,
      `dsh-auth-${token}, dsh-v1`,
      `dsh-v1, dsh-v1, dsh-auth-${token}`,
      `dsh-v1, dsh-auth-${token}, dsh-auth-${token}`,
      `dsh-v1, dsh-auth- ${token}`,
      `dsh-v1, dsh-auth-${token}\n`,
    ]) {
      expect(authorizer.authorize('websocket', protocols)).toBe(false)
    }
  })

  it('keeps ordinary invocations unchanged and rejects malformed native input', () => {
    expect(consumeDesktopApiAuthorizer({})).toBeUndefined()
    const malformed = { DSH_DESKTOP_API_TOKEN: 'not-a-token' }
    expect(() => consumeDesktopApiAuthorizer(malformed)).toThrow(/32 random bytes/)
    expect(malformed).not.toHaveProperty('DSH_DESKTOP_API_TOKEN')
  })
})
