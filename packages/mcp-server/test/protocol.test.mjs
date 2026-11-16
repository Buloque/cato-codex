import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'

test('MCP stdio handshake, lists CATO tools and serves a bounded repo map', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cato-mcp-'))
  const data = await mkdtemp(path.join(tmpdir(), 'cato-mcp-data-'))
  try {
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'sample.ts'), 'export function answer() { return 42 }\n')
    await writeFile(path.join(root, '.env'), 'PRIVATE=secret\n')
    await mkdir(path.join(data, 'logs'))
    await writeFile(path.join(data, 'logs', 'cmd_12345678.json'), JSON.stringify({ id: 'cmd_12345678', command: 'pnpm test', exitCode: 1, raw: 'ERR_FIXTURE: expected 2 got 1\n' }))
    const server = spawn(process.execPath, ['dist/mcp-server/index.js', '--root', root], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CATO_DATA_DIR: data } })
    let pending = ''
    const responses = new Map()
    server.stdout.setEncoding('utf8')
    server.stdout.on('data', chunk => {
      pending += chunk
      while (pending.includes('\n')) {
        const i = pending.indexOf('\n')
        const line = pending.slice(0, i); pending = pending.slice(i + 1)
        try { const msg = JSON.parse(line); if (msg.id !== undefined) responses.set(msg.id, msg) } catch { /* protocol stdout must be JSON-RPC only */ }
      }
    })
    const request = async (id, method, params = {}) => {
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      const limit = Date.now() + 5000
      while (!responses.has(id) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 10))
      assert.ok(responses.has(id), `no response for ${method}`)
      return responses.get(id)
    }
    const init = await request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    assert.equal(init.error, undefined)
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const listed = await request(2, 'tools/list')
    assert.equal(listed.error, undefined)
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ['repo_map', 'read_symbol', 'structural_search', 'graph_query', 'search_sandbox', 'cost_report'])
    const mapped = await request(3, 'tools/call', { name: 'repo_map', arguments: { focus: 'answer' } })
    assert.equal(mapped.error, undefined)
    assert.match(mapped.result.content[0].text, /sample\.ts|answer/)
    const traversal = await request(4, 'tools/call', { name: 'read_symbol', arguments: { file_path: '../outside.txt', symbol: 'secret' } })
    assert.equal(traversal.result.isError, true)
    const secret = await request(5, 'tools/call', { name: 'read_symbol', arguments: { file_path: '.env', symbol: 'PRIVATE' } })
    assert.equal(secret.result.isError, true)
    const recovered = await request(6, 'tools/call', { name: 'search_sandbox', arguments: { id: 'cmd_12345678', query: 'ERR_FIXTURE' } })
    assert.match(recovered.result.content[0].text, /ERR_FIXTURE: expected 2 got 1/)
    server.stdin.end()
    await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])
    if (server.exitCode === null) server.kill()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  }
})
