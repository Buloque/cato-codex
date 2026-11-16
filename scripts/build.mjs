import { build } from 'esbuild'

const entries = {
  'mcp-server/index': 'packages/mcp-server/src/index.ts',
  'hooks/post-model-request': 'packages/codex-adapter/src/post-model-request.ts',
  'hooks/post-tool-use': 'packages/codex-adapter/src/post-tool-use.ts',
  'hooks/post-compact': 'packages/codex-adapter/src/post-compact.ts',
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
