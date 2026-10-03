/**
 * `scripts/check-env.cjs`'s credential guard (docs/phase-180): `.env` is
 * bundled into every installer as plaintext, so the build must refuse
 * one that carries a store URL, token or M-Pesa credential.
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { BUNDLE_FORBIDDEN_KEYS, findBundledCredentialKeys } = require('../scripts/check-env.cjs') as {
  BUNDLE_FORBIDDEN_KEYS: string[]
  findBundledCredentialKeys: (contents: string) => string[]
}

const BLANK_ENV = [
  'VITE_SHOPIFY_STORE_URL=',
  'VITE_SHOPIFY_ADMIN_API_TOKEN=',
  'VITE_SHOPIFY_LOCATION_ID=',
  'VITE_TAX_RATE=0.16',
  'VITE_MOCK_PRINTER=false',
  'VITE_USE_MOCK_MPESA=false # Defaults to real when absent.',
  'MPESA_CONSUMER_KEY=',
  'MPESA_CONSUMER_SECRET=',
  'MPESA_SHORTCODE=174379',
  'MPESA_PASSKEY='
].join('\n')

describe('findBundledCredentialKeys', () => {
  it('passes a .env with every credential blank, whatever the non-secret keys hold', () => {
    expect(findBundledCredentialKeys(BLANK_ENV)).toEqual([])
  })

  // CHANGED (docs/phase-213). OLD: exactly the six store and M-Pesa credential keys. NEW: also the two
  // publishing credentials, GH_TOKEN and GITHUB_TOKEN, which must never be bundled into an installer.
  it('guards exactly the eight credential keys', () => {
    expect(BUNDLE_FORBIDDEN_KEYS).toEqual([
      'VITE_SHOPIFY_STORE_URL',
      'VITE_SHOPIFY_ADMIN_API_TOKEN',
      'VITE_SHOPIFY_LOCATION_ID',
      'MPESA_CONSUMER_KEY',
      'MPESA_CONSUMER_SECRET',
      'MPESA_PASSKEY',
      'GH_TOKEN',
      'GITHUB_TOKEN'
    ])
  })

  it.each(['GH_TOKEN', 'GITHUB_TOKEN'])('reports the publishing credential %s when it has a value', (key) => {
    expect(findBundledCredentialKeys(`${BLANK_ENV}\n${key}=ghp_example`)).toEqual([key])
  })

  it('passes a blank or absent publishing credential', () => {
    expect(findBundledCredentialKeys(`${BLANK_ENV}\nGH_TOKEN=`)).toEqual([])
    expect(findBundledCredentialKeys(BLANK_ENV)).toEqual([])
  })

  it.each([
    'VITE_SHOPIFY_STORE_URL',
    'VITE_SHOPIFY_ADMIN_API_TOKEN',
    'VITE_SHOPIFY_LOCATION_ID',
    'MPESA_CONSUMER_KEY',
    'MPESA_CONSUMER_SECRET',
    'MPESA_PASSKEY'
  ])('reports %s when it has a value', (key) => {
    const contents = BLANK_ENV.replace(new RegExp(`^${key}=$`, 'm'), `${key}=some-value`)
    expect(findBundledCredentialKeys(contents)).toEqual([key])
  })

  it('treats a key holding only a trailing comment or empty quotes as blank', () => {
    const contents = 'VITE_SHOPIFY_ADMIN_API_TOKEN= # set in the wizard\nMPESA_PASSKEY=""'
    expect(findBundledCredentialKeys(contents)).toEqual([])
  })

  it('still reports a value that is followed by a trailing comment', () => {
    expect(findBundledCredentialKeys('MPESA_CONSUMER_SECRET=abc123 # old sandbox')).toEqual([
      'MPESA_CONSUMER_SECRET'
    ])
  })

  it('ignores commented-out lines', () => {
    expect(findBundledCredentialKeys('# VITE_SHOPIFY_ADMIN_API_TOKEN=shpat_x')).toEqual([])
  })

  it('never reports a non-credential key', () => {
    expect(findBundledCredentialKeys('VITE_TAX_RATE=0.16\nMPESA_SHORTCODE=174379')).toEqual([])
  })
})
