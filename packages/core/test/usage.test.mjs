import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendUsageEvent, parsePostModelRequestEvent, readUsageReport, UsageEventError } from '../src/usage.ts'

const NOW = Date.parse('2026-11-16T12:00:00.000Z')

async function withTempDir(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'cato-usage-'))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('parses only PostModelRequest usage fields and leaves unavailable token counts null', () => {
  const parsed = parsePostModelRequestEvent({
    session_id: 'session-1',
    turn_id: 'turn-1',
    model: 'gpt-test',
    agent_id: 'agent-1',
    agent_type: 'worker',
    status: 'completed',
    error: null,
    token_usage: null,
    prompt: 'must not be returned',
    output: 'must not be returned',
  })

  assert.deepEqual(parsed.token_usage, null)
  assert.equal('prompt' in parsed, false)
  assert.equal('output' in parsed, false)
})

test('normalizes counts, appends one privacy-minimized record, and reports measured totals', async () => {
  await withTempDir(async directory => {
    const path = join(directory, 'usage.jsonl')
    const first = await appendUsageEvent(path, {
      session_id: 'sensitive-session-id',
      turn_id: 'turn-1',
      model: 'gpt-test',
      agent_id: 'agent-1',
      agent_type: 'worker',
      status: 'completed',
      error: null,
      token_usage: {
        input_tokens: 100,
        output_tokens: 25,
        total_tokens: 125,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens_details: { reasoning_tokens: 5 },
        raw_prompt: 'must not be stored',
      },
      prompt: 'must not be stored',
      output: 'must not be stored',
      transcript_path: 'must not be stored',
    }, { now: NOW })
    await appendUsageEvent(path, {
      session_id: 'sensitive-session-id',
      turn_id: 'turn-2',
      model: 'gpt-test',
      status: 'failed',
      error: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      token_usage: null,
      prompt: 'never persist',
      output: 'never persist',
    }, { now: NOW + 1 })

    assert.equal(first.sessionHash.length, 64)
    assert.notEqual(first.sessionHash, 'sensitive-session-id')
    const contents = await readFile(path, 'utf8')
    assert.equal(contents.trim().split('\n').length, 2)
    assert.equal(contents.includes('sensitive-session-id'), false)
    assert.equal(contents.includes('must not be stored'), false)
    assert.equal(contents.includes('never persist'), false)
    assert.equal(contents.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false)

    const report = await readUsageReport(path, { now: NOW + 2 })
    assert.equal(report.requests, 2)
    assert.equal(report.completed, 1)
    assert.equal(report.failed, 1)
    assert.equal(report.sessions, 1)
    assert.equal(report.inputTokens, 100)
    assert.equal(report.outputTokens, 25)
    assert.equal(report.totalTokens, 125)
    assert.equal(report.cachedInputTokens, 40)
    assert.equal(report.reasoningOutputTokens, 5)
    assert.equal(report.knownUsageRequests, 1)
    assert.equal(report.unavailableUsageRequests, 1)
    assert.equal(report.byModel[0].requests, 2)
    assert.equal(report.byAgent.find(item => item.agentType === 'worker').inputTokens, 100)
  })
})

test('retains only 90 days and skips corrupt JSONL lines', async () => {
  await withTempDir(async directory => {
    const path = join(directory, 'usage.jsonl')
    const old = await appendUsageEvent(path, {
      session_id: 'session-old', turn_id: 'old', model: 'old-model', status: 'completed', token_usage: null,
    }, { now: NOW - 91 * 24 * 60 * 60 * 1000 })
    await writeFile(path, `${JSON.stringify(old)}\nnot-json\n`, { encoding: 'utf8', flag: 'a' })
    await appendUsageEvent(path, {
      session_id: 'session-new', turn_id: 'new', model: 'new-model', status: 'completed', token_usage: null,
    }, { now: NOW })

    const content = await readFile(path, 'utf8')
    const lines = content.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].turnId, 'new')

    const report = await readUsageReport(path, { now: NOW })
    assert.equal(report.requests, 1)
    assert.equal(report.corruptLines, 0)
  })
})

test('missing ledger produces an empty report; malformed events fail with a typed error', async () => {
  await withTempDir(async directory => {
    const report = await readUsageReport(join(directory, 'missing.jsonl'), { now: NOW })
    assert.equal(report.requests, 0)
    assert.equal(report.inputTokens, null)
    assert.equal(report.unavailableUsageRequests, 0)

    assert.throws(
      () => parsePostModelRequestEvent('{'),
      error => error instanceof UsageEventError && /valid JSON/.test(error.message),
    )
    assert.throws(
      () => parsePostModelRequestEvent({ session_id: 's', turn_id: 't', model: 'm', status: 'retry', token_usage: null }),
      UsageEventError,
    )
  })
})

test('report handles corrupt stored lines without failing', async () => {
  await withTempDir(async directory => {
    const path = join(directory, 'usage.jsonl')
    await writeFile(path, '{bad json}\n[]\n', 'utf8')
    const report = await readUsageReport(path, { now: NOW })
    assert.equal(report.requests, 0)
    assert.equal(report.corruptLines, 2)
    assert.equal(report.totalTokens, null)
  })
})
