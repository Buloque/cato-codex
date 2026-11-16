import { appendUsageEvent } from '../../core/src/usage.ts'

const dataDir = process.env.CATO_DATA_DIR ?? process.env.PLUGIN_DATA ??
  (process.platform === 'win32'
    ? `${process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? '.'}\\Cato\\Codex`
    : `${process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? '.'}/.local/share`}/cato-codex`)

let input = ''
for await (const chunk of process.stdin) input += chunk.toString()
try {
  await appendUsageEvent(`${dataDir}/usage.jsonl`, JSON.parse(input))
} catch (error) {
  process.stderr.write(`CATO usage hook: ${error instanceof Error ? error.message : String(error)}\n`)
}
