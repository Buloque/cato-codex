import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import {
  bm25Search,
  buildRepoMap,
  chunkLines,
  extractSymbol,
  IGNORED_DIRS,
  isCodeFile,
} from '../../../plugin/hooks/lib/codeintel.ts'
import {
  formatAstGrepMatches,
  GRAPHIFY_JSON,
  graphFileEdges,
  parseGraph,
  queryGraph,
  type Graph,
} from '../../../plugin/hooks/lib/integrations.ts'
import { readUsageReport } from '../../core/src/usage.ts'

const MAX_TOOL_TEXT = 18_000
const MAX_SINGLE_FILE = 512 * 1024
const MAX_REPO_FILES = 500
const MAX_REPO_BYTES = 2 * 1024 * 1024
const MAX_GRAPH_BYTES = 4 * 1024 * 1024
const MAX_SEARCH_RESULTS = 100
const MAX_SEARCH_SCAN_FILES = 600
const MAX_SEARCH_BYTES = 4 * 1024 * 1024
const MAX_AST_OUTPUT = 2 * 1024 * 1024
const SECRET_SEGMENT = /^(?:\.env(?:\..*)?|.*(?:credentials?|secrets?).*|id_rsa[^/\\]*|id_ed25519[^/\\]*|.*\.(?:pem|key|p12|pfx))$/i
const FORBIDDEN_SEGMENT = /^(?:\.git|\.hg|\.svn)$/i
const DATA_DIR_ENV = 'CATO_DATA_DIR'

type JsonObject = Record<string, unknown>
type SearchHit = { file: string; line: number; text: string }
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

class ToolInputError extends Error {}

function boundedText(text: string, limit = MAX_TOOL_TEXT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… [output truncated at ${limit} characters]`
}

function toolResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: boundedText(text) }], ...(isError ? { isError: true } : {}) }
}

function requiredString(args: JsonObject, key: string, maxLength: number): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new ToolInputError(`'${key}' must be a non-empty string.`)
  if (value.length > maxLength) throw new ToolInputError(`'${key}' exceeds ${maxLength} characters.`)
  return value.trim()
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(min, Math.min(max, number))
}

function containsSecretSegment(relative: string): boolean {
  return relative.split(/[\\/]+/).some(segment => SECRET_SEGMENT.test(segment))
}

function ensureInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  if (rel === '') return true
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return false
  return true
}

function rejectUnsafeSegments(relative: string): void {
  if (relative.includes('\0')) throw new ToolInputError('Path contains a null byte.')
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.startsWith('\\\\')) {
    throw new ToolInputError('Use a path relative to the configured repository root.')
  }
  const parts = relative.split(/[\\/]+/)
  if (parts.some(part => part === '..' || FORBIDDEN_SEGMENT.test(part))) {
    throw new ToolInputError('Path contains a traversal or repository metadata segment.')
  }
  if (containsSecretSegment(relative)) throw new ToolInputError('Secret-like paths are not readable by CATO.')
}

async function canonicalRoot(configuredRoot: string): Promise<string> {
  if (!path.isAbsolute(configuredRoot) && !path.win32.isAbsolute(configuredRoot)) {
    throw new Error('The --root value must be an absolute path.')
  }
  const root = await realpath(configuredRoot)
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('The --root value must point to a directory.')
  return root
}

async function resolveRepoPath(root: string, input: string, allowRoot = false): Promise<string> {
  const relative = input || '.'
  if (relative !== '.') rejectUnsafeSegments(relative)
  const candidate = path.resolve(root, relative)
  if (!ensureInside(root, candidate)) throw new ToolInputError('Path is outside the configured repository root.')
  let canonical: string
  try {
    canonical = await realpath(candidate)
  } catch {
    throw new ToolInputError(`Path does not exist inside the configured repository: ${relative}`)
  }
  if (!ensureInside(root, canonical)) throw new ToolInputError('Symlink resolves outside the configured repository root.')
  if (!allowRoot && canonical === root) throw new ToolInputError('A file or directory path inside the repository is required.')
  const rel = path.relative(root, canonical)
  if (containsSecretSegment(rel)) throw new ToolInputError('Secret-like paths are not readable by CATO.')
  return canonical
}

async function readUtf8(file: string, maxBytes = MAX_SINGLE_FILE): Promise<string> {
  const info = await lstat(file)
  if (info.isSymbolicLink()) throw new ToolInputError('Symbolic links are not read directly; use their in-repository target path.')
  if (!info.isFile()) throw new ToolInputError('Path is not a regular file.')
  if (info.size > maxBytes) throw new ToolInputError(`File is larger than the ${maxBytes}-byte read limit.`)
  const chunks: Buffer[] = []
  let bytesRead = 0
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytesRead += buffer.length
    if (bytesRead > maxBytes) throw new ToolInputError(`File exceeded the ${maxBytes}-byte read limit while being read.`)
    if (buffer.includes(0)) throw new ToolInputError('Binary files are not readable by CATO.')
    chunks.push(buffer)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new ToolInputError('File is not valid UTF-8 text.')
  }
}

async function collectCodeFiles(root: string, start = root, limits = { files: MAX_REPO_FILES, bytes: MAX_REPO_BYTES }): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  let totalBytes = 0
  const pending = [start]
  const startInfo = await lstat(start)
  if (startInfo.isSymbolicLink()) throw new ToolInputError('Symbolic link search roots are not supported.')
  if (startInfo.isFile()) {
    const rel = path.relative(root, start).split(path.sep).join('/')
    rejectUnsafeSegments(rel)
    if (!isCodeFile(rel)) throw new ToolInputError('The selected file is not a supported source-code file.')
    const source = await readUtf8(start)
    files.set(rel, source)
    return files
  }
  while (pending.length && files.size < limits.files && totalBytes < limits.bytes) {
    const directory = pending.pop()!
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.size >= limits.files || totalBytes >= limits.bytes) break
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (containsSecretSegment(relative) || FORBIDDEN_SEGMENT.test(entry.name)) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) pending.push(absolute)
        continue
      }
      if (!entry.isFile() || !isCodeFile(entry.name)) continue
      const info = await lstat(absolute).catch(() => null)
      if (!info || info.isSymbolicLink() || info.size > MAX_SINGLE_FILE || totalBytes + info.size > limits.bytes) continue
      try {
        const text = await readUtf8(absolute)
        files.set(relative, text)
        totalBytes += info.size
      } catch {
        // Ignore files that disappear or fail strict text/size validation during a repository scan.
      }
    }
  }
  return files
}

async function loadGraph(root: string) {
  const graphPath = await resolveRepoPath(root, GRAPHIFY_JSON)
  const text = await readUtf8(graphPath, MAX_GRAPH_BYTES)
  const parsed = parseGraph(text, root)
  if (!parsed) throw new ToolInputError('Graphify graph is invalid or has an unsupported format.')
  const nodes = new Map([...parsed.nodes].filter(([, node]) => {
    if (!node.file) return true
    try {
      rejectUnsafeSegments(node.file)
      return !path.isAbsolute(node.file) && !path.win32.isAbsolute(node.file)
    } catch {
      return false
    }
  }))
  const links = parsed.links.filter(link => nodes.has(link.source) && nodes.has(link.target))
  const degree = new Map<string, number>()
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1)
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1)
  }
  return { nodes, links, degree } satisfies Graph
}

function runAstGrep(binary: string, root: string, relativeTarget: string, pattern: string, lang: string | undefined): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [binary, 'run', '--pattern', pattern, '--json=stream', ...(lang ? ['--lang', lang] : []), relativeTarget]
    const child = spawn(binary, args.slice(1), { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let stderrSize = 0
    let timedOut = false
    let settled = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 30_000)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve({ code: child.exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    }
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_AST_OUTPUT) child.kill()
      else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrSize < 16_000) {
        stderr.push(chunk.subarray(0, 16_000 - stderrSize))
        stderrSize += chunk.length
      }
    })
    child.on('error', finish)
    child.on('close', code => {
      if (size > MAX_AST_OUTPUT) finish(new ToolInputError('ast-grep output exceeded the size limit.'))
      else if (timedOut) finish(new ToolInputError('ast-grep exceeded the 30-second time limit.'))
      else finish()
      if (settled && code !== null) {
        // `exitCode` is set before the close event; the result is produced by finish above.
      }
    })
  })
}

async function findAstGrep(): Promise<string | null> {
  const candidates = process.platform === 'win32' ? ['ast-grep.exe', 'ast-grep', 'sg.exe', 'sg'] : ['ast-grep']
  for (const candidate of candidates) {
    const available = await new Promise<boolean>(resolve => {
      const child = spawn(candidate, ['--version'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => child.kill(), 3_000)
      child.on('error', () => { clearTimeout(timer); resolve(false) })
      child.on('close', code => { clearTimeout(timer); resolve(code === 0) })
    })
    if (available) return candidate
  }
  return null
}

function regexSearchInWorker(files: Array<{ name: string; text: string }>, pattern: string, maxResults: number): Promise<SearchHit[]> {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    try {
      const re = new RegExp(workerData.pattern, 'i');
      const hits = [];
      outer: for (const file of workerData.files) {
        const lines = file.text.split(/\\r?\\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push({ file: file.name, line: i + 1, text: lines[i].trim().slice(0, 300) });
            if (hits.length >= workerData.maxResults) break outer;
          }
        }
      }
      parentPort.postMessage({ hits });
    } catch (error) { parentPort.postMessage({ error: String(error && error.message || error) }); }
  `
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { files, pattern, maxResults } })
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new ToolInputError('Regular expression exceeded the search time limit.'))
    }, 500)
    worker.once('message', (message: { hits?: SearchHit[]; error?: string }) => {
      clearTimeout(timer)
      void worker.terminate()
      if (message.error) reject(new ToolInputError(`Invalid or unsupported regular expression: ${message.error}`))
      else resolve(message.hits ?? [])
    })
    worker.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

async function searchFallback(root: string, target: string, pattern: string, mode: 'exact' | 'regex', maxResults: number): Promise<string> {
  const files = await collectCodeFiles(root, target, { files: MAX_SEARCH_SCAN_FILES, bytes: MAX_SEARCH_BYTES })
  let hits: SearchHit[]
  if (mode === 'exact') {
    const needle = pattern.toLocaleLowerCase()
    hits = []
    outer: for (const [name, text] of files) {
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLocaleLowerCase().includes(needle)) {
          hits.push({ file: name, line: i + 1, text: lines[i].trim().slice(0, 300) })
          if (hits.length >= maxResults) break outer
        }
      }
    }
  } else {
    hits = await regexSearchInWorker([...files].map(([name, text]) => ({ name, text })), pattern, maxResults)
  }
  if (!hits.length) return 'No matches found.'
  return `# Text search fallback (${mode}; ${hits.length} result(s))\n${hits.map(hit => `${hit.file}:L${hit.line}  ${hit.text}`).join('\n')}`
}

function getDataDir(): string {
  const configured = process.env[DATA_DIR_ENV]
  if (configured && (path.isAbsolute(configured) || path.win32.isAbsolute(configured))) return path.resolve(configured)
  const pluginData = process.env.PLUGIN_DATA
  if (pluginData && (path.isAbsolute(pluginData) || path.win32.isAbsolute(pluginData))) return path.resolve(pluginData)
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || homedir(), 'Cato', 'Codex')
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'cato-codex')
}

function parseRootArg(argv: string[]): string {
  const index = argv.indexOf('--root')
  if (index < 0 || !argv[index + 1]) throw new Error('Usage: cato-mcp --root <absolute-repository-path>')
  if (argv.slice(index + 2).some(arg => arg === '--root')) throw new Error('Provide --root exactly once.')
  return argv[index + 1]
}

async function invokeTool(name: string, args: JsonObject, root: string): Promise<ReturnType<typeof toolResult>> {
  try {
    switch (name) {
      case 'repo_map': {
        const focus = typeof args.focus === 'string' ? args.focus.slice(0, 500) : undefined
        const budget = boundedInteger(args.token_budget, 1200, 100, 5000)
        const files = await collectCodeFiles(root)
        if (!files.size) return toolResult('No readable source-code files found within the configured scan limits.')
        let graphEdges: Map<string, Map<string, number>> | undefined
        let graphNote = ''
        try {
          const graph = await loadGraph(root)
          graphEdges = graphFileEdges(graph)
          graphNote = `\n\n[Graphify ranking included ${graph.links.length} in-repository relation(s).]`
        } catch {
          // Graphify is optional; a missing or malformed graph does not stop the repo map.
        }
        return toolResult(buildRepoMap(files, focus, budget, graphEdges) + graphNote)
      }
      case 'read_symbol': {
        const relative = requiredString(args, 'file_path', 1000)
        const symbol = requiredString(args, 'symbol', 200)
        const file = await resolveRepoPath(root, relative)
        const canonicalRelative = path.relative(root, file).split(path.sep).join('/')
        if (!isCodeFile(canonicalRelative)) throw new ToolInputError('read_symbol only reads supported source-code files.')
        const source = await readUtf8(file)
        const found = extractSymbol(canonicalRelative, source, symbol)
        if (!found) return toolResult(`Symbol '${symbol}' was not found in ${canonicalRelative}.`)
        return toolResult(`# ${symbol} — ${canonicalRelative}:L${found.start}-L${found.end}\n${found.text}`)
      }
      case 'structural_search': {
        const pattern = requiredString(args, 'pattern', 200)
        const relativeTarget = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.'
        const target = await resolveRepoPath(root, relativeTarget, true)
        const canonicalRelative = target === root ? '.' : path.relative(root, target).split(path.sep).join('/')
        const maxResults = boundedInteger(args.max_results, 60, 1, MAX_SEARCH_RESULTS)
        const lang = typeof args.lang === 'string' && args.lang ? args.lang.slice(0, 32) : undefined
        const astGrep = await findAstGrep()
        if (astGrep) {
          const result = await runAstGrep(astGrep, root, canonicalRelative, pattern, lang)
          const formatted = formatAstGrepMatches(result.stdout, maxResults)
          if (formatted) return toolResult(formatted)
          if (result.code !== 0 && !result.stdout.trim()) {
            return toolResult(`ast-grep could not complete the pattern: ${result.stderr.trim().slice(0, 800) || 'no diagnostic output'}`, true)
          }
          return toolResult(result.stdout || 'No matches found.')
        }
        const mode = args.mode === 'regex' ? 'regex' : 'exact'
        return toolResult(await searchFallback(root, target, pattern, mode, maxResults))
      }
      case 'graph_query': {
        const term = requiredString(args, 'term', 300)
        const limit = boundedInteger(args.limit, 12, 1, 50)
        const graph = await loadGraph(root)
        return toolResult(queryGraph(graph, term, limit, 3000))
      }
      case 'cost_report': {
        const report = await readUsageReport(path.join(getDataDir(), 'usage.jsonl'), { now: Date.now() })
        return toolResult(JSON.stringify(report, null, 2))
      }
      default:
        return toolResult(`Unknown tool: ${name}`, true)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown failure.'
    return toolResult(message, true)
  }
}

export async function startMcpServer(argv = process.argv.slice(2)): Promise<void> {
  const root = await canonicalRoot(parseRootArg(argv))
  const server = new McpServer({ name: 'cato-codex', version: '0.1.0' })
  server.registerTool(
    'repo_map',
    {
      description: 'Rank source files and list declarations relevant to a focus. Reads a bounded set of source files from the configured repository.',
      inputSchema: z.object({ focus: z.string().max(500).optional(), token_budget: z.number().int().min(100).max(5000).optional() }),
    },
    args => invokeTool('repo_map', args as JsonObject, root),
  )
  server.registerTool(
    'read_symbol',
    {
      description: 'Read one declared class, function, or method from a path relative to the configured repository root.',
      inputSchema: z.object({ file_path: z.string().min(1).max(1000), symbol: z.string().min(1).max(200) }),
    },
    args => invokeTool('read_symbol', args as JsonObject, root),
  )
  server.registerTool(
    'structural_search',
    {
      description: 'Search source code with ast-grep syntax when installed; otherwise use an exact-text or bounded regular-expression fallback.',
      inputSchema: z.object({
        pattern: z.string().min(1).max(200),
        lang: z.string().max(32).optional(),
        path: z.string().max(1000).optional(),
        mode: z.enum(['exact', 'regex']).optional(),
        max_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
      }),
    },
    args => invokeTool('structural_search', args as JsonObject, root),
  )
  server.registerTool(
    'graph_query',
    {
      description: 'Search the repository-local Graphify graph (graphify-out/graph.json) for matching nodes and neighboring relationships.',
      inputSchema: z.object({ term: z.string().min(1).max(300), limit: z.number().int().min(1).max(50).optional() }),
    },
    args => invokeTool('graph_query', args as JsonObject, root),
  )
  server.registerTool(
    'cost_report',
    {
      description: 'Report measured token-usage records available to CATO, clearly marking unavailable fields as unknown.',
      inputSchema: z.object({}),
    },
    args => invokeTool('cost_report', args as JsonObject, root),
  )
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMcpServer().catch(error => {
    process.stderr.write(`[cato-mcp] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
