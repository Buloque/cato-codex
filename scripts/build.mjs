import { build } from 'esbuild'
import { readdir, rm } from 'node:fs/promises'

// Remove known obsolete artifacts from prior preview builds without clearing dist wholesale.
await Promise.all([
  rm('dist/hooks/post-compact.js', { force: true }),
  rm('dist/hooks/post-compact.js.map', { force: true }),
])
for (const name of await readdir('dist').catch(() => [])) {
  if (/^cato-codex-\d+\.\d+\.\d+\.tgz$/.test(name)) await rm(`dist/${name}`, { force: true })
}

const entries = {
  'mcp-server/index': 'packages/mcp-server/src/index.ts',
  'hooks/post-model-request': 'packages/codex-adapter/src/post-model-request.ts',
  'hooks/post-tool-use': 'packages/codex-adapter/src/post-tool-use.ts',
  'cli/index': 'packages/cli/src/index.ts',
}

await build({
  entryPoints: entries,
  outdir: 'dist',
  bundle: true,
  packages: 'bundle',
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  legalComments: 'eof',
  logLevel: 'info',
})
