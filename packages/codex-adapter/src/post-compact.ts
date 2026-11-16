// PostCompact is informational; do not read or rewrite unstable transcript data.
for await (const _chunk of process.stdin) { /* consume hook input */ }
process.stdout.write(JSON.stringify({ continue: true }))
