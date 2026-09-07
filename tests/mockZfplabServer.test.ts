/**
 * Chunk 2 — the mock ZFPLabServer engine's own correctness, independent of
 * the real provider (Chunk 3 tests the provider against this engine; this
 * file tests the engine itself: command routing, fault injection, the
 * request log). Boots on an ephemeral port (`port: 0`) per the robust-test
 * standard (§9.5) — no fixed-port collision with a real ZFPLabServer or a
 * concurrently running `npm run mock:zfplab`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createMockZfpLabServer,
  type MockZfpLabServerHandle
} from '../mock-zfplab-server/engine.js'

let server: MockZfpLabServerHandle

beforeEach(async () => {
  server = await createMockZfpLabServer({ port: 0 })
})

afterEach(async () => {
  await server.close()
})

async function postCommand(commandXml: string): Promise<{ status: number; body: string }> {
  const response = await fetch(server.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: commandXml
  })
  return { status: response.status, body: await response.text() }
}

describe('settings() and clientremove() GETs', () => {
  it('settings(...) returns the real captured settings-ok.xml verbatim, regardless of params', async () => {
    const response = await fetch(
      `${server.baseUrl}settings(ip=1.2.3.4,port=9999,password=whatever,tcp=1)`
    )
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('<Res Code="0">')
    expect(body).toContain('<clientID>Localhost</clientID>')
  })

  it('clientremove(who=me) returns a bare Code 0', async () => {
    const response = await fetch(`${server.baseUrl}clientremove(who=me)`)
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body.trim()).toBe('<Res Code="0" />')
  })
})

describe('command routing (POST)', () => {
  it('routes ReadStatus to the full 22-flag fixture', async () => {
    const { status, body } = await postCommand('<Command Name="ReadStatus"/>')
    expect(status).toBe(200)
    expect(body).toContain('CU_fiscalized" Value="1"')
    expect(body).toContain('Update_is_available')
  })

  it('routes OpenInvoiceWithFreeCustomerData to a bare ack', async () => {
    const { body } = await postCommand(
      '<Command Name="OpenInvoiceWithFreeCustomerData"><Args><Arg Name="CompanyName" Value="Acme"/></Args></Command>'
    )
    expect(body.trim()).toBe('<Res Code="0" />')
  })

  it('routes CloseReceipt to the InvoiceNum/QRcode fixture', async () => {
    const { body } = await postCommand('<Command Name="CloseReceipt"/>')
    expect(body).toContain('InvoiceNum" Value="0000000000000000042"')
    expect(body).toContain('QRcode')
  })

  it('routes ReadCUnumbers to the SerialNumber/PINnumber fixture', async () => {
    const { status, body } = await postCommand('<Command Name="ReadCUnumbers"/>')
    expect(status).toBe(200)
    expect(body).toContain('SerialNumber" Value="MOCK-CU-SERIAL-0001"')
    expect(body).toContain('PINnumber" Value="00000000001"')
  })

  it('routes an unrecognized command to a safe-default ack, not a hang or 404', async () => {
    const { status, body } = await postCommand('<Command Name="SomeFutureCommand"/>')
    expect(status).toBe(200)
    expect(body.trim()).toBe('<Res Code="0" />')
  })

  it('routes a malformed POST body (no <Command Name> match) to the real Code-63 fixture', async () => {
    const { body } = await postCommand('not xml at all')
    expect(body).toContain('Code="63"')
    expect(body).toContain('ClientInvalidPostFormat')
  })
})

describe('fault injection', () => {
  it('setFault is one-shot by default: the next matching request gets the fault, then reverts', async () => {
    server.setFault('ReadStatus', 'code19-opensocket.xml')

    const first = await postCommand('<Command Name="ReadStatus"/>')
    expect(first.body).toContain('Code="19"')

    const second = await postCommand('<Command Name="ReadStatus"/>')
    expect(second.body).toContain('CU_fiscalized" Value="1"')
    expect(second.body).not.toContain('Code="19"')
  })

  it('a persistent fault applies to every matching request until cleared', async () => {
    server.setFault('ReadStatus', 'code30-socketfail.xml', { persistent: true })

    const first = await postCommand('<Command Name="ReadStatus"/>')
    const second = await postCommand('<Command Name="ReadStatus"/>')
    expect(first.body).toContain('Code="30"')
    expect(second.body).toContain('Code="30"')

    server.clearFault('ReadStatus')
    const third = await postCommand('<Command Name="ReadStatus"/>')
    expect(third.body).toContain('CU_fiscalized" Value="1"')
  })

  it('exercises the Code-53 auto-resettle scenario: fault on first command only, then success', async () => {
    server.setFault('OpenInvoiceWithFreeCustomerData', 'code53-settingsmissing.xml')

    const first = await postCommand('<Command Name="OpenInvoiceWithFreeCustomerData"/>')
    expect(first.body).toContain('Code="53"')

    const retry = await postCommand('<Command Name="OpenInvoiceWithFreeCustomerData"/>')
    expect(retry.body.trim()).toBe('<Res Code="0" />')
  })

  it('setFault also works on the settings() pseudo-command', async () => {
    server.setFault('settings', 'readstatus-code31-authfail.xml')
    const response = await fetch(`${server.baseUrl}settings(ip=1,port=2,password=3,tcp=1)`)
    const body = await response.text()
    expect(body).toContain('Code="31"')
  })
})

describe('request log', () => {
  it('records every request in arrival order, with the fixture actually served', async () => {
    await fetch(`${server.baseUrl}settings(ip=1,port=2,password=3,tcp=1)`)
    await postCommand('<Command Name="ReadStatus"/>')

    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]).toMatchObject({
      method: 'GET',
      pseudoCommand: 'settings',
      servedFixture: 'settings-ok.xml'
    })
    expect(server.requests[1]).toMatchObject({
      method: 'POST',
      commandName: 'ReadStatus',
      servedFixture: 'readstatus-fiscalized-full.xml'
    })
  })

  it('clearRequests empties the log', async () => {
    await postCommand('<Command Name="ReadStatus"/>')
    expect(server.requests.length).toBeGreaterThan(0)
    server.clearRequests()
    expect(server.requests).toHaveLength(0)
  })
})
