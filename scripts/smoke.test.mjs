#!/usr/bin/env node
/**
 * Smoke test for the dsh shell's pure logic under plain Node: endpoint
 * resolution (three-tier priority), key-file degradation, and the SSE → dsh
 * chunk re-emission with a mock hub listener.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const mod = await import('../index.js')

function post(port, urlPath, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

test('SSE stream from a mock hub re-emits as dsh chunks with usage and finish', async () => {
  const SSE = (delta, extra = {}) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`
  const server = http.createServer((req, res) => {
    if (req.url === '/hub-models') {
      assert.equal(req.headers.authorization, 'Bearer K-mock')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash', contextWindow: 128000, maxOutput: 64000, vision: false }], at: 1 }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(SSE({ role: 'assistant', content: '' }))
      res.write(SSE({ content: 'MOCK' }))
      res.write(SSE({ reasoning: 'thinking…' }))
      res.write(SSE({}, { usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } }))
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(18740, '127.0.0.1', resolve))

  // Drive the adapter's stream directly through a fake plugin context.
  const originalFetch = globalThis.fetch
  let registered
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    llm: {
      registerAdapter: (providers, adapter) => {
        // Mirror dsh-llm prepareRoutes: a missing providerRetryPolicy is TypeError at activate.
        const policy = adapter.providerRetryPolicy(providers[0])
        assert.equal(policy, undefined)
        registered = adapter
        return { replace() {} }
      },
    },
    on: () => {},
  }
  const config = { hubBaseUrl: 'http://127.0.0.1:18740', hubKey: 'K-mock' }
  mod.apply(ctx, config)
  assert.ok(registered, 'adapter registered')

  const chunks = []
  for await (const chunk of registered.stream({ model: 'deepseek-v4-flash-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], sessionId: 'smoke' })) {
    chunks.push(chunk)
  }
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, 'MOCK')
  const reasoning = chunks.find(c => c.type === 'reasoning-delta')
  assert.equal(reasoning?.text, 'thinking…')
  const usage = chunks.find(c => c.type === 'usage')
  assert.equal(usage.usage.totalTokens, 11)
  assert.equal(usage.usage.cacheReadTokens, 0)
  const finish = chunks.find(c => c.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })

  globalThis.fetch = originalFetch
  server.close()
})

test('a turn against a dead hub yields the install hint, not a raw stack', async () => {
  const originalFetch = globalThis.fetch
  let registered
  const ctx = { logger: { info: () => {}, warn: () => {} }, llm: { registerAdapter: (p, a) => { a.providerRetryPolicy(p[0]); registered = a; return { replace() {} } } }, on: () => {} }
  // A port nothing listens on; an explicit key so no daemon autostart fires.
  mod.apply(ctx, { hubBaseUrl: 'http://127.0.0.1:18741', hubKey: 'K-x' })
  const chunks = []
  for await (const chunk of registered.stream({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
    chunks.push(chunk)
  }
  const finish = chunks.find(c => c.type === 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /free-model-hub/)
  assert.ok(!/at \w+ \(/.test(finish.reason.failure.message), 'no stack frames leak into the message')
  globalThis.fetch = originalFetch
})

test('endpoint resolution: explicit config wins and skips file-key hydration', () => {
  const settings = mod.resolveEndpoint({ hubBaseUrl: 'http://10.0.0.8:8330', hubKey: 'K-remote' })
  assert.equal(settings.baseUrl, 'http://10.0.0.8:8330')
  assert.equal(settings.key, 'K-remote')
  assert.equal(settings.keyFromFile, false)
  assert.equal(mod.isLocalHub(settings.baseUrl), false)
})

test('endpoint resolution: missing key file degrades to empty key, still local', () => {
  const missing = path.join(os.tmpdir(), 'no-such-freehub-settings.json')
  const key = mod.readHubKey(missing)
  assert.equal(key, '')
  const settings = mod.resolveEndpoint({})
  assert.equal(settings.keyFromFile, true)
  assert.equal(mod.isLocalHub(settings.baseUrl), true)
})
