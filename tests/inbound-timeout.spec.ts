/**
 * The inbound-handler timeout: the bound that keeps a hung handler from
 * wedging the transport's per-chat delivery pipeline forever.
 */

import { describe, expect, it, vi } from 'vitest'
import { raceInboundHandler } from '../src/bridge.ts'

describe('raceInboundHandler', () => {
  it('resolves with the work and cancels the deadline timer', async () => {
    vi.useFakeTimers()
    try {
      let timedOut = false
      const result = raceInboundHandler(Promise.resolve('done'), {
        timeoutMs: 60_000,
        onTimeout: () => { timedOut = true },
      })
      await vi.runAllTimersAsync()
      await expect(result).resolves.toBe('done')
      expect(timedOut).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects at the deadline when the handler hangs, and reports it', async () => {
    vi.useFakeTimers()
    try {
      let timedOut = false
      const never = new Promise<string>(() => {})
      const result = raceInboundHandler(never, {
        timeoutMs: 60_000,
        onTimeout: () => { timedOut = true },
      })
      const assertion = expect(result).rejects.toThrow('inbound handler timed out')
      await vi.advanceTimersByTimeAsync(60_000)
      await assertion
      expect(timedOut).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire the deadline once the work settles first', async () => {
    vi.useFakeTimers()
    try {
      let timedOut = false
      const result = raceInboundHandler(Promise.resolve('fast'), {
        timeoutMs: 60_000,
        onTimeout: () => { timedOut = true },
      })
      await expect(result).resolves.toBe('fast')
      await vi.advanceTimersByTimeAsync(120_000)
      expect(timedOut).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
