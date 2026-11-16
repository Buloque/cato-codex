import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('install and uninstall preserve existing settings and create reversible backups', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cato-install-'))
  try {
    const codex = path.join(root, '.codex')
    await (await import('node:fs/promises')).mkdir(codex)
    const original = 'model = "gpt-test"\n[mcp_servers.other]\ncommand = "other"\n'
    await writeFile(path.join(codex, 'config.toml'), original)
    const run = command => spawnSync(process.execPath, ['dist/cli/index.js', command, root], { encoding: 'utf8' })
    const installed = run('install')
    assert.equal(installed.status, 0, installed.stderr)
    let config = await readFile(path.join(codex, 'config.toml'), 'utf8')
    assert.match(config, /gpt-test/)
    assert.match(config, /mcp_servers\.other/)
    assert.match(config, /mcp_servers\.cato/)
    assert.ok((await readdir(codex)).some(name => name.includes('cato-backup')))
    const repeated = run('install')
    assert.notEqual(repeated.status, 0)
    assert.match(repeated.stderr, /already exists/)
    const removed = run('uninstall')
    assert.equal(removed.status, 0, removed.stderr)
    config = await readFile(path.join(codex, 'config.toml'), 'utf8')
    assert.match(config, /mcp_servers\.other/)
    assert.doesNotMatch(config, /mcp_servers\.cato/)
    assert.ok((await readdir(codex)).filter(name => name.includes('cato-backup')).length >= 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
