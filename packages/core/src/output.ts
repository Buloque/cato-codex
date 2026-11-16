import { randomBytes } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { optimizeOutput, isCompressibleCommand } from '../../../plugin/hooks/lib/compress.ts'

const MAX_HOOK_INPUT = 8 * 1024 * 1024
const MIN_OUTPUT_CHARS = 4_000
const MIN_REDUCTION = 0.3
const OUTPUT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

async function cleanOldOutputs(logsDir: string, now = Date.now()): Promise<void> {
  for (const name of await readdir(logsDir)) {
    if (!/^cmd_[a-f0-9]{8}\.json$/.test(name)) continue
    const file = path.join(logsDir, name)
    try {
      const info = await stat(file)
      if (now - info.mtimeMs > OUTPUT_RETENTION_MS) await unlink(file)
    } catch { /* a concurrent cleanup or inaccessible local file is non-fatal */ }
  }
}

export interface CompressionEvent {
  recordedAt: string
  id: string
  tool: string
  strategy: string
  rawBytes: number
  summaryBytes: number
  omittedErrors: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultDataDir(): string {
  if (process.env.CATO_DATA_DIR) return process.env.CATO_DATA_DIR
  if (process.env.PLUGIN_DATA) return process.env.PLUGIN_DATA
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? '.', 'Cato', 'Codex')
  return path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? '.', '.local/share'), 'cato-codex')
}

function terminalText(response: unknown): { text: string; exitCode: number | null } | null {
  if (typeof response === 'string') return { text: response, exitCode: null }
  if (!isRecord(response)) return null
  // Keep this allowlist narrow: only the documented shell output fields are rebuilt.
  const hasStreams = typeof response.stdout === 'string' || typeof response.stderr === 'string'
  if (!hasStreams) return null
  const stdout = typeof response.stdout === 'string' ? response.stdout : ''
  const stderr = typeof response.stderr === 'string' ? response.stderr : ''
  const exitCode = typeof response.exit_code === 'number' && Number.isSafeInteger(response.exit_code)
    ? response.exit_code
    : typeof response.exitCode === 'number' && Number.isSafeInteger(response.exitCode) ? response.exitCode : null
  return { text: [stdout, stderr].filter(Boolean).join('\n'), exitCode }
}

function readPostToolEvent(input: unknown): Record<string, unknown> | null {
  let value = input
  if (typeof input === 'string') {
    if (input.length > MAX_HOOK_INPUT) return null
    try { value = JSON.parse(input) } catch { return null }
  }
  if (!isRecord(value) || value.hook_event_name !== 'PostToolUse') return null
  return value
}

export async function processPostToolUse(input: unknown, dataDir = defaultDataDir()): Promise<{ decision: 'continue' } | { decision: 'block'; reason: string; event: CompressionEvent } | null> {
  const event = readPostToolEvent(input)
  if (!event || event.tool_name !== 'Bash' || !isRecord(event.tool_input) || typeof event.tool_input.command !== 'string') return null
  const command = event.tool_input.command
  if (!isCompressibleCommand(command)) return null
  const result = terminalText(event.tool_response)
  if (!result || result.text.length < MIN_OUTPUT_CHARS) return null
  const optimized = optimizeOutput(command, result.text)
  if (!optimized.changed || optimized.text.length >= result.text.length * (1 - MIN_REDUCTION)) return null

  const id = `cmd_${randomBytes(4).toString('hex')}`
  const record: CompressionEvent = {
    recordedAt: new Date().toISOString(),
    id,
    tool: 'Bash',
    strategy: optimized.strategy,
    rawBytes: Buffer.byteLength(result.text),
    summaryBytes: Buffer.byteLength(optimized.text),
    omittedErrors: optimized.omittedErrors,
  }
  const logsDir = path.join(dataDir, 'logs')
  await mkdir(logsDir, { recursive: true })
  await cleanOldOutputs(logsDir)
  await writeFile(path.join(logsDir, `${id}.json`), JSON.stringify({
    schemaVersion: 1,
    id,
    exitCode: result.exitCode,
    raw: result.text,
    summary: optimized.text,
  }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await appendFile(path.join(dataDir, 'compressions.jsonl'), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' })
  const exit = result.exitCode === null ? '' : ` (exit ${result.exitCode})`
  return {
    decision: 'block',
    reason: `CATO summarized this ${optimized.strategy} terminal output${exit} (${record.rawBytes} to ${record.summaryBytes} bytes).\nOriginal output is saved locally as ${id}; use CATO search_sandbox to find specific original lines.\n\n${optimized.text}`,
    event: record,
  }
}

export interface CompressionReport {
  events: number
  rawBytes: number
  summaryBytes: number
  savedBytes: number
  omittedErrors: number
  byStrategy: Array<{ strategy: string; events: number; savedBytes: number }>
}

export async function readCompressionReport(dataDir = defaultDataDir()): Promise<CompressionReport> {
  let text: string
  try { text = await readFile(path.join(dataDir, 'compressions.jsonl'), 'utf8') }
  catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { events: 0, rawBytes: 0, summaryBytes: 0, savedBytes: 0, omittedErrors: 0, byStrategy: [] }
    throw error
  }
  const rows: CompressionEvent[] = []
  for (const line of text.split(/\r?\n/)) {
    try {
      const row = JSON.parse(line)
      if (isRecord(row) && typeof row.strategy === 'string' && typeof row.rawBytes === 'number' && typeof row.summaryBytes === 'number' && typeof row.omittedErrors === 'number') rows.push(row as unknown as CompressionEvent)
    } catch { /* skip partial/corrupt ledger rows */ }
  }
  const byStrategy = new Map<string, { events: number; savedBytes: number }>()
  for (const row of rows) {
    const summary = byStrategy.get(row.strategy) ?? { events: 0, savedBytes: 0 }
    summary.events += 1
    summary.savedBytes += Math.max(0, row.rawBytes - row.summaryBytes)
    byStrategy.set(row.strategy, summary)
  }
  const rawBytes = rows.reduce((sum, row) => sum + row.rawBytes, 0)
  const summaryBytes = rows.reduce((sum, row) => sum + row.summaryBytes, 0)
  return {
    events: rows.length,
    rawBytes,
    summaryBytes,
    savedBytes: Math.max(0, rawBytes - summaryBytes),
    omittedErrors: rows.reduce((sum, row) => sum + row.omittedErrors, 0),
    byStrategy: [...byStrategy].map(([strategy, summary]) => ({ strategy, ...summary })),
  }
}

export async function searchSavedOutput(dataDir: string, id: string, query: string): Promise<string> {
  if (!/^(?:cmd)_[a-f0-9]{8}$/.test(id)) throw new Error('Saved output ID must use the cmd_xxxxxxxx format.')
  const root = await realpath(dataDir)
  const filename = path.join(root, 'logs', `${id}.json`)
  const info = await lstat(filename)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Saved output record is not a regular local file.')
  const resolved = await realpath(filename)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Saved output record escapes the CATO data directory.')
  const raw = await readFile(filename, 'utf8')
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Saved output is larger than the search limit.')
  const record = JSON.parse(raw) as { raw?: unknown; exitCode?: unknown }
  if (typeof record.raw !== 'string') throw new Error('Saved output record is invalid.')
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const lines = record.raw.split(/\r?\n/)
  const hits: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (terms.every(term => lines[index].toLowerCase().includes(term))) hits.push(`${index + 1}: ${lines[index].slice(0, 1000)}`)
    if (hits.length >= 30) break
  }
  return [
    `Original output ${id}; exit: ${record.exitCode ?? 'unknown'}`,
    hits.length ? hits.join('\n') : `No lines matched ${JSON.stringify(query)}.`,
  ].join('\n')
}
