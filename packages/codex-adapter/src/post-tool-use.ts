// Conservative observational hook: Codex PostToolUse runs after the action. This
// adapter leaves the original result untouched until compression semantics can
// be validated across supported CLI and Desktop builds.
for await (const _chunk of process.stdin) { /* consume hook input */ }
process.stdout.write(JSON.stringify({ continue: true }))
