import { describe, it, expect } from 'vitest'
import {
  initialToastDebounceState,
  nextToastDebounceState,
  type ToastDebounceState
} from '../src/renderer/src/lib/connectivityToasts.js'

describe('nextToastDebounceState', () => {
  it('does not toast on the first successful check', () => {
    const result = nextToastDebounceState(initialToastDebounceState(), true)
    expect(result.toast).toBeNull()
    expect(result.state.lastToasted).toBe('connected')
  })

  it('does not toast disconnected until the failure threshold is reached', () => {
    let state: ToastDebounceState = initialToastDebounceState()
    for (let i = 0; i < 2; i++) {
      const result = nextToastDebounceState(state, false)
      expect(result.toast).toBeNull()
      state = result.state
    }
    expect(state.consecutiveFailures).toBe(2)
  })

  it('toasts disconnected on the 3rd consecutive failure', () => {
    let state: ToastDebounceState = initialToastDebounceState()
    let lastToast: string | null = null
    for (let i = 0; i < 3; i++) {
      const result = nextToastDebounceState(state, false)
      state = result.state
      lastToast = result.toast
    }
    expect(lastToast).toBe('disconnected')
    expect(state.lastToasted).toBe('disconnected')
  })

  it('does not re-toast disconnected on further consecutive failures', () => {
    let state: ToastDebounceState = { consecutiveFailures: 3, lastToasted: 'disconnected' }
    const result = nextToastDebounceState(state, false)
    expect(result.toast).toBeNull()
    expect(result.state.consecutiveFailures).toBe(4)
  })

  it('toasts connected on recovery after a disconnected toast fired', () => {
    const prev: ToastDebounceState = { consecutiveFailures: 3, lastToasted: 'disconnected' }
    const result = nextToastDebounceState(prev, true)
    expect(result.toast).toBe('connected')
    expect(result.state).toEqual({ consecutiveFailures: 0, lastToasted: 'connected' })
  })

  it('does not toast connected again once already connected', () => {
    const prev: ToastDebounceState = { consecutiveFailures: 0, lastToasted: 'connected' }
    const result = nextToastDebounceState(prev, true)
    expect(result.toast).toBeNull()
  })

  it('a transient blip below the failure threshold recovers silently', () => {
    let state: ToastDebounceState = initialToastDebounceState()
    state = nextToastDebounceState(state, true).state
    const failResult = nextToastDebounceState(state, false)
    expect(failResult.toast).toBeNull()
    const recoverResult = nextToastDebounceState(failResult.state, true)
    expect(recoverResult.toast).toBeNull()
  })

  it('respects a custom failureThreshold', () => {
    let state: ToastDebounceState = initialToastDebounceState()
    let lastToast: string | null = null
    for (let i = 0; i < 5; i++) {
      const result = nextToastDebounceState(state, false, 5)
      state = result.state
      lastToast = result.toast
    }
    expect(lastToast).toBe('disconnected')
  })
})
