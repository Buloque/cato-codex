import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const RETENTION_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000
const MAX_LINE_CHARS = 256_000
const MAX_ERROR_CHARS = 1_000

export type ModelRequestStatus = 'completed' | 'failed' | 'cancelled'

/** Counts are nullable because Codex may not expose usage for every model request attempt. */
export interface TokenUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cachedInputTokens: number | null
  reasoningOutputTokens: number | null
}

export interface PostModelRequestEvent {
  session_id: string
  turn_id: string
  model: string
  agent_id?: string | null
  agent_type?: string | null
  status: ModelRequestStatus
  error?: string | null
  token_usage: TokenUsage | null
}

export interface UsageRecord {
  schemaVersion: 1
  recordedAt: string
  sessionHash: string
  turnId: string
  model: string
  agentId: string | null
  agentType: string | null
  status: ModelRequestStatus
  error: string | null
  tokenUsage: TokenUsage
}

export interface UsageModelSummary {
  model: string
  requests: number
  completed: number
  failed: number
  cancelled: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cachedInputTokens: number | null
  reasoningOutputTokens: number | null
  knownUsageRequests: number
}

export interface UsageAgentSummary {
  agentId: string | null
  agentType: string | null
  requests: number
  completed: number
  failed: number
  cancelled: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cachedInputTokens: number | null
  reasoningOutputTokens: number | null
  knownUsageRequests: number
}

export interface UsageReport {
  period: { from: string; to: string; retentionDays: number }
  requests: number
  completed: number
  failed: number
  cancelled: number
  sessions: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cachedInputTokens: number | null
  reasoningOutputTokens: number | null
  knownUsageRequests: number
  unavailableUsageRequests: number
  byModel: UsageModelSummary[]
  byAgent: UsageAgentSummary[]
  corruptLines: number
}

export interface ReadUsageOptions {
  /** Timestamp used for deterministic reporting and retention tests. Defaults to now. */
  now?: Date | number
}

export interface AppendUsageOptions {
  /** Timestamp used for deterministic tests. Defaults to now. */
  now?: Date | number
}

export class UsageEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageEventError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageEventError(`PostModelRequest event is missing a valid ${field}`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new UsageEventError(`PostModelRequest ${field} must be a string or null`)
  return value
}

/** Parse only the documented PostModelRequest fields; prompt/output/transcript data is never retained. */
export function parsePostModelRequestEvent(input: unknown): PostModelRequestEvent {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      throw new UsageEventError('PostModelRequest event is not valid JSON')
    }
  }
  if (!isObject(value)) throw new UsageEventError('PostModelRequest event must be a JSON object')

  const status = value.status
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
    throw new UsageEventError('PostModelRequest status must be completed, failed, or cancelled')
  }
  const tokenUsage = value.token_usage
  if (tokenUsage !== undefined && tokenUsage !== null && !isObject(tokenUsage)) {
    throw new UsageEventError('PostModelRequest token_usage must be an object or null')
  }

  return {
    session_id: requiredString(value.session_id, 'session_id'),
    turn_id: requiredString(value.turn_id, 'turn_id'),
    model: requiredString(value.model, 'model'),
    agent_id: optionalString(value.agent_id, 'agent_id'),
    agent_type: optionalString(value.agent_type, 'agent_type'),
    status,
    error: optionalString(value.error, 'error'),
    token_usage: tokenUsage === undefined || tokenUsage === null ? null : normalizeUsage(tokenUsage),
  }
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function nestedCount(value: unknown, ...path: string[]): number | null {
  let current = value
  for (const key of path) {
    if (!isObject(current)) return null
    current = current[key]
  }
  return count(current)
}

function normalizeUsage(value: unknown): TokenUsage {
  if (!isObject(value)) {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
    }
  }
  return {
    inputTokens: count(value.input_tokens),
    outputTokens: count(value.output_tokens),
    totalTokens: count(value.total_tokens),
    cachedInputTokens:
      count(value.cached_input_tokens) ??
      count(value.cached_tokens) ??
      nestedCount(value, 'input_tokens_details', 'cached_tokens'),
    reasoningOutputTokens:
      count(value.reasoning_output_tokens) ??
      count(value.reasoning_tokens) ??
      nestedCount(value, 'output_tokens_details', 'reasoning_tokens'),
  }
}

function safeError(value: string | null): string | null {
  if (!value) return null
  // Error strings can contain local paths, snippets or credential material.
  // Keep only the fact an error occurred; the detailed text stays out of the ledger.
  return '[error details omitted]'.slice(0, MAX_ERROR_CHARS)
}

function timestamp(value: Date | number | undefined): Date {
  const date = value === undefined ? new Date() : value instanceof Date ? new Date(value) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new RangeError('now must be a valid Date or timestamp')
  return date
}

function sumKnown(records: readonly UsageRecord[], field: keyof TokenUsage): number | null {
  let found = false
  let total = 0
  for (const record of records) {
    const value = record.tokenUsage[field]
    if (value === null) continue
    found = true
    total += value
  }
  return found ? total : null
}

function makeRecord(event: PostModelRequestEvent, at: Date): UsageRecord {
  return {
    schemaVersion: 1,
    recordedAt: at.toISOString(),
    sessionHash: createHash('sha256').update(event.session_id, 'utf8').digest('hex'),
    turnId: event.turn_id,
    model: event.model,
    agentId: event.agent_id ?? null,
    agentType: event.agent_type ?? null,
    status: event.status,
    error: safeError(event.error ?? null),
    tokenUsage: event.token_usage ?? normalizeUsage(null),
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`
  const started = Date.now()
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8')
      return async () => {
        await handle.close().catch(() => undefined)
        await unlink(lockPath).catch(() => undefined)
      }
    } catch (error) {
      if (!isObject(error) || error.code !== 'EEXIST') throw error
      try {
        const lockStat = await stat(lockPath)
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          await unlink(lockPath)
          continue
        }
      } catch (statError) {
        if (isObject(statError) && statError.code === 'ENOENT') continue
      }
      await delay(15 + Math.floor(Math.random() * 20))
    }
  }
  throw new Error('Timed out waiting for usage ledger lock')
}

interface ParsedLines {
  records: UsageRecord[]
  corruptLines: number
}

function validStoredRecord(value: unknown): value is UsageRecord {
  if (!isObject(value) || value.schemaVersion !== 1) return false
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))) return false
  if (typeof value.sessionHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sessionHash)) return false
  if (typeof value.turnId !== 'string' || typeof value.model !== 'string') return false
  if (value.status !== 'completed' && value.status !== 'failed' && value.status !== 'cancelled') return false
  if (value.error !== null && typeof value.error !== 'string') return false
  if (value.agentId !== null && typeof value.agentId !== 'string') return false
  if (value.agentType !== null && typeof value.agentType !== 'string') return false
  if (!isObject(value.tokenUsage)) return false
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const) {
    const item = value.tokenUsage[key]
    if (item !== null && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) return false
  }
  return true
}

function parseLines(content: string, now: Date): ParsedLines {
  const cutoff = now.getTime() - RETENTION_DAYS * DAY_MS
  const records: UsageRecord[] = []
  let corruptLines = 0
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.length > MAX_LINE_CHARS) {
      corruptLines += 1
      continue
    }
    try {
      const value: unknown = JSON.parse(line)
      if (!validStoredRecord(value)) {
        corruptLines += 1
        continue
      }
      if (Date.parse(value.recordedAt) >= cutoff) records.push(value)
    } catch {
      corruptLines += 1
    }
  }
  return { records, corruptLines }
}

async function readFileIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Appends one privacy-minimized ledger entry for an official PostModelRequest event.
 * Entries older than 90 days and malformed lines are removed during retention compaction.
 */
export async function appendUsageEvent(
  filePath: string,
  input: unknown,
  options: AppendUsageOptions = {},
): Promise<UsageRecord> {
  const event = parsePostModelRequestEvent(input)
  const at = timestamp(options.now)
  const record = makeRecord(event, at)
  await mkdir(dirname(filePath), { recursive: true })
  const release = await acquireLock(filePath)
  try {
    // Each event is first written as one JSONL append. The retention pass then atomically
    // replaces the file only when old/corrupt records need removal.
    await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' })
    const content = await readFileIfPresent(filePath)
    const parsed = parseLines(content, at)
    if (parsed.corruptLines > 0 || parsed.records.length < content.split(/\r?\n/).filter(Boolean).length) {
      const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, parsed.records.map(item => JSON.stringify(item)).join('\n') + (parsed.records.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, filePath)
    }
  } finally {
    await release()
  }
  return record
}

function countStatus(records: readonly UsageRecord[], status: ModelRequestStatus): number {
  return records.reduce((n, record) => n + Number(record.status === status), 0)
}

function summarizeByModel(records: readonly UsageRecord[]): UsageModelSummary[] {
  const grouped = new Map<string, UsageRecord[]>()
  for (const record of records) grouped.set(record.model, [...(grouped.get(record.model) ?? []), record])
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, group]) => ({
    model,
    requests: group.length,
    completed: countStatus(group, 'completed'),
    failed: countStatus(group, 'failed'),
    cancelled: countStatus(group, 'cancelled'),
    inputTokens: sumKnown(group, 'inputTokens'),
    outputTokens: sumKnown(group, 'outputTokens'),
    totalTokens: sumKnown(group, 'totalTokens'),
    cachedInputTokens: sumKnown(group, 'cachedInputTokens'),
    reasoningOutputTokens: sumKnown(group, 'reasoningOutputTokens'),
    knownUsageRequests: group.filter(r => Object.values(r.tokenUsage).some(v => v !== null)).length,
  }))
}

function summarizeByAgent(records: readonly UsageRecord[]): UsageAgentSummary[] {
  const grouped = new Map<string, UsageRecord[]>()
  for (const record of records) {
    const key = `${record.agentType ?? ''}\u0000${record.agentId ?? ''}`
    grouped.set(key, [...(grouped.get(key) ?? []), record])
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => ({
    agentId: group[0].agentId,
    agentType: group[0].agentType,
    requests: group.length,
    completed: countStatus(group, 'completed'),
    failed: countStatus(group, 'failed'),
    cancelled: countStatus(group, 'cancelled'),
    inputTokens: sumKnown(group, 'inputTokens'),
    outputTokens: sumKnown(group, 'outputTokens'),
    totalTokens: sumKnown(group, 'totalTokens'),
    cachedInputTokens: sumKnown(group, 'cachedInputTokens'),
    reasoningOutputTokens: sumKnown(group, 'reasoningOutputTokens'),
    knownUsageRequests: group.filter(r => Object.values(r.tokenUsage).some(v => v !== null)).length,
  }))
}

/** Read retained JSONL records and return measured totals. Missing usage remains null, never zero. */
export async function readUsageReport(filePath: string, options: ReadUsageOptions = {}): Promise<UsageReport> {
  const now = timestamp(options.now)
  const content = await readFileIfPresent(filePath)
  const { records, corruptLines } = parseLines(content, now)
  const knownUsageRequests = records.filter(r => Object.values(r.tokenUsage).some(v => v !== null)).length
  return {
    period: {
      from: new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString(),
      to: now.toISOString(),
      retentionDays: RETENTION_DAYS,
    },
    requests: records.length,
    completed: countStatus(records, 'completed'),
    failed: countStatus(records, 'failed'),
    cancelled: countStatus(records, 'cancelled'),
    sessions: new Set(records.map(record => record.sessionHash)).size,
    inputTokens: sumKnown(records, 'inputTokens'),
    outputTokens: sumKnown(records, 'outputTokens'),
    totalTokens: sumKnown(records, 'totalTokens'),
    cachedInputTokens: sumKnown(records, 'cachedInputTokens'),
    reasoningOutputTokens: sumKnown(records, 'reasoningOutputTokens'),
    knownUsageRequests,
    unavailableUsageRequests: records.length - knownUsageRequests,
    byModel: summarizeByModel(records),
    byAgent: summarizeByAgent(records),
    corruptLines,
  }
}
