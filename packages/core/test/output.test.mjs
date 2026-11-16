import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { processPostToolUse, readCompressionReport, searchSavedOutput } from '../src/output.ts'

test('compresses recognized verbose test output, preserves the original, and reports byte counts', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cato-output-'))
  try {
    const lines = Array.from({ length: 250 }, (_, i) => `✓ test case ${i} passed successfully with stable fixture output`)
    lines.push('FAILURES', 'AssertionError: ERR_TARGET must remain visible', '120 passed, 1 failed')
    const stdout = lines.join('\n')
    const result = await processPostToolUse({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'call-1',
      tool_input: { command: 'pnpm test' },
      tool_response: { stdout, stderr: '', exit_code: 1 },
    }, dataDir)
    assert.equal(result?.decision, 'block')
    assert.match(result.reason, /Original output is saved locally as cmd_[a-f0-9]{8}/)
    assert.match(result.reason, /AssertionError: ERR_TARGET/)
    assert.match(result.reason, /120 passed, 1 failed/)
    const raw = await readFile(path.join(dataDir, 'logs', `${result.event.id}.json`), 'utf8')
    assert.equal(JSON.parse(raw).raw, stdout)
    const recovered = await searchSavedOutput(dataDir, result.event.id, 'ERR_TARGET')
    assert.match(recovered, /AssertionError: ERR_TARGET/)
    const report = await readCompressionReport(dataDir)
    assert.equal(report.events, 1)
    assert.ok(report.savedBytes > 0)
    assert.equal(report.rawBytes, Buffer.byteLength(stdout))
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

test('passes through unrecognized tools, commands, small output and structured MCP responses', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cato-output-pass-'))
  try {
    const base = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } }
    assert.equal(await processPostToolUse({ ...base, tool_name: 'mcp__server__tool', tool_response: 'x'.repeat(10_000) }, dataDir), null)
    assert.equal(await processPostToolUse({ ...base, tool_input: { command: 'cat package.json' }, tool_response: 'x'.repeat(10_000) }, dataDir), null)
    assert.equal(await processPostToolUse({ ...base, tool_response: { content: [{ type: 'text', text: 'x'.repeat(10_000) }] } }, dataDir), null)
    assert.equal(await processPostToolUse({ ...base, tool_response: { stdout: 'short', stderr: '', exit_code: 0 } }, dataDir), null)
    assert.equal(await readCompressionReport(dataDir).then(report => report.events), 0)
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})
