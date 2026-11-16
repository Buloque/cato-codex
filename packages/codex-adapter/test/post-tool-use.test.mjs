import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('PostToolUse hook emits documented replacement feedback and saves recoverable raw output', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cato-post-tool-hook-'))
  try {
    const stdout = Array.from({ length: 240 }, (_, i) => `✓ test case ${i} passed successfully with fixture line`)
      .concat(['FAILURES', 'AssertionError: hook fixture failure', '100 passed, 1 failed']).join('\n')
    const event = {
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tool-use-1',
      tool_input: { command: 'pnpm test' }, tool_response: { stdout, stderr: '', exit_code: 1 },
    }
    const result = spawnSync(process.execPath, ['dist/hooks/post-tool-use.js'], {
      input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, CATO_DATA_DIR: dataDir },
    })
    assert.equal(result.status, 0, result.stderr)
    const response = JSON.parse(result.stdout)
    assert.equal(response.decision, 'block')
    assert.match(response.reason, /AssertionError: hook fixture failure/)
    const id = response.reason.match(/(cmd_[a-f0-9]{8})/)[1]
    const raw = JSON.parse(await readFile(path.join(dataDir, 'logs', `${id}.json`), 'utf8'))
    assert.equal(raw.raw, stdout)
    assert.equal('command' in raw, false)
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})
