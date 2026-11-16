import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { parse, stringify } from 'smol-toml'
import { readUsageReport } from '../../core/src/usage.ts'

const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const projectRoot = path.resolve(args[1] ?? process.cwd())
const dataDir = process.env.CATO_DATA_DIR ?? process.env.PLUGIN_DATA ?? (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA ?? homedir(), 'Cato', 'Codex')
  : path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'cato-codex'))
const ledger = path.join(dataDir, 'usage.jsonl')

function printReport(report: Awaited<ReturnType<typeof readUsageReport>>) {
  console.log('CATO Stats — measured Codex usage (best effort)')
  console.log(`Period: ${report.period.from} to ${report.period.to} (${report.period.retentionDays} day retention)`)
  console.log(`Requests: ${report.requests} | completed: ${report.completed} | failed: ${report.failed} | cancelled: ${report.cancelled}`)
  console.log(`Sessions: ${report.sessions}`)
  console.log(`Input tokens: ${report.inputTokens ?? 'unavailable'} | output tokens: ${report.outputTokens ?? 'unavailable'} | total: ${report.totalTokens ?? 'unavailable'}`)
  console.log(`Cached input: ${report.cachedInputTokens ?? 'unavailable'} | reasoning output: ${report.reasoningOutputTokens ?? 'unavailable'}`)
  console.log(`Requests with usage: ${report.knownUsageRequests} | unavailable: ${report.unavailableUsageRequests}`)
  if (!report.requests) console.log('No usage events recorded yet. Install the project hook and use a Codex CLI session.')
  console.log('Token counts are official PostModelRequest fields when present; retries are separate requests. No costs are inferred.')
}

async function install() {
  const configDir = path.join(projectRoot, '.codex')
  const configFile = path.join(configDir, 'config.toml')
  await mkdir(configDir, { recursive: true })
  let config: Record<string, any> = {}
  let previous: string | undefined
  try { previous = await readFile(configFile, 'utf8'); config = parse(previous) as Record<string, any> } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot parse ${configFile}: ${String(error)}`)
  }
  const mcpServers = config.mcp_servers ??= {}
  if (mcpServers.cato) throw new Error('An MCP server named "cato" already exists; rename or remove it before installing.')
  const executable = process.execPath.replace(/\\/g, '/')
  const server = path.resolve(process.cwd(), 'dist/mcp-server/index.js').replace(/\\/g, '/')
  mcpServers.cato = { command: executable, args: [server, '--root', projectRoot.replace(/\\/g, '/')], enabled: true }
  if (previous !== undefined) {
    const backup = `${configFile}.cato-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await copyFile(configFile, backup)
    console.log(`Backup: ${backup}`)
  }
  await writeFile(configFile, stringify(config), 'utf8')
  console.log(`Installed CATO MCP for ${projectRoot}`)
  console.log(`Restart Codex and approve the project plugin/hooks when prompted. Configuration: ${configFile}`)
}

async function uninstall() {
  const configFile = path.join(projectRoot, '.codex', 'config.toml')
  const text = await readFile(configFile, 'utf8')
  const config = parse(text) as Record<string, any>
  if (!config.mcp_servers?.cato) { console.log('No CATO MCP entry found.'); return }
  const backup = `${configFile}.cato-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await copyFile(configFile, backup)
  console.log(`Backup: ${backup}`)
  delete config.mcp_servers.cato
  if (!Object.keys(config.mcp_servers).length) delete config.mcp_servers
  await writeFile(configFile, stringify(config), 'utf8')
  console.log(`Removed only the CATO MCP entry from ${configFile}`)
}

try {
  if (command === 'stats' || command === 'report') printReport(await readUsageReport(ledger))
  else if (command === 'install') await install()
  else if (command === 'uninstall') await uninstall()
  else if (command === 'status' || command === 'doctor') {
    console.log(`CATO for Codex 0.1.0 | Node ${process.version} | data: ${dataDir}`)
    console.log(`Project: ${projectRoot}`)
    console.log(`Ledger: ${await readUsageReport(ledger).then(r => `${r.requests} requests recorded`)}`)
  } else {
    console.log('Usage: cato <stats|report|status|doctor|install|uninstall> [project-root]')
  }
} catch (error) {
  console.error(`cato: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
