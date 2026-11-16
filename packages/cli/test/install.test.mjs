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
    const original = 'model = "gpt-test"\n[mcp_servers.other]\ncommand = "other"\n[plugins."cato-codex@cato-codex-local"]\nenabled = true\n'
    await writeFile(path.join(codex, 'config.toml'), original)
    const run = command => spawnSync(process.execPath, ['dist/cli/index.js', command, root], { encoding: 'utf8' })
    const installed = run('install')
    assert.equal(installed.status, 0, installed.stderr)
    let config = await readFile(path.join(codex, 'config.toml'), 'utf8')
    assert.match(config, /gpt-test/)
    assert.match(config, /mcp_servers\.other/)
    assert.match(config, /mcp_servers\.cato/)
    assert.match(config, /plugins\."cato-codex@cato-codex-local"/)
    assert.match(config, /enabled = true/)
    assert.ok((await readdir(codex)).some(name => name.includes('cato-backup')))
    const configured = run('config')
    assert.equal(configured.status, 0, configured.stderr)
    assert.match(configured.stdout, /CATO MCP: configured/)
    assert.match(configured.stdout, /MCP repository root:/)
    const diagnosis = run('doctor')
    assert.equal(diagnosis.status, 0, diagnosis.stdout + diagnosis.stderr)
    assert.match(diagnosis.stdout, /OK Built MCP server/)
    const repeated = run('install')
    assert.notEqual(repeated.status, 0)
    assert.match(repeated.stderr, /already exists/)
    const removed = run('uninstall')
    assert.equal(removed.status, 0, removed.stderr)
    config = await readFile(path.join(codex, 'config.toml'), 'utf8')
    assert.match(config, /mcp_servers\.other/)
    assert.doesNotMatch(config, /mcp_servers\.cato/)
    assert.match(config, /plugins\."cato-codex@cato-codex-local"/)
    assert.ok((await readdir(codex)).filter(name => name.includes('cato-backup')).length >= 2)

    const invalid = 'model = [ this is not valid TOML\n'
    await writeFile(path.join(codex, 'config.toml'), invalid)
    const rejected = run('install')
    assert.notEqual(rejected.status, 0)
    assert.equal(await readFile(path.join(codex, 'config.toml'), 'utf8'), invalid)
  } finally { await rm(root, { recursive: true, force: true }) }
})
