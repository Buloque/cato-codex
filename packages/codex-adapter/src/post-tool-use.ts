import { processPostToolUse } from '../../core/src/output.ts'

let input = ''
for await (const chunk of process.stdin) {
  input += chunk.toString()
  if (input.length > 8 * 1024 * 1024) {
    process.stderr.write('CATO PostToolUse: input exceeded the safety limit; passing the result through.\n')
    process.exit(0)
  }
}

try {
  const result = await processPostToolUse(input)
  if (result?.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reason }))
  }
} catch (error) {
  process.stderr.write(`CATO PostToolUse: ${error instanceof Error ? error.message : String(error)}\n`)
}
