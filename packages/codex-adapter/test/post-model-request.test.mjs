import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('PostModelRequest hook appends only privacy-minimized usage fields', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'cato-hook-'))
  try {
    const event = { session_id: 'session-secret', turn_id: 'turn-1', model: 'gpt-test', status: 'completed', error: 'C:\\Users\\Alice\\secret.txt', token_usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 }, prompt: 'private prompt' }
    const result = spawnSync(process.execPath, ['dist/hooks/post-model-request.js'], {
      input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, CATO_DATA_DIR: data },
    })
    assert.equal(result.status, 0, result.stderr)
    const record = JSON.parse((await readFile(path.join(data, 'usage.jsonl'), 'utf8')).trim())
    assert.equal(record.tokenUsage.totalTokens, 15)
    assert.notEqual(record.sessionHash, event.session_id)
    assert.equal(JSON.stringify(record).includes('secret.txt'), false)
    assert.equal(JSON.stringify(record).includes('private prompt'), false)
    assert.equal(record.error, '[error details omitted]')
  } finally { await rm(data, { recursive: true, force: true }) }
})
