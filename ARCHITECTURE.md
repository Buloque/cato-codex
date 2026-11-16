# Arquitetura

O fork adiciona caminhos Codex sem substituir a implementação Claude original.

```text
plugin/hooks/lib/        utilitários puros originais reutilizados
packages/core/           ledger de uso oficial, minimizado e com retenção
packages/codex-adapter/  scripts Node chamados pelo hooks.json
packages/mcp-server/     MCP stdio limitado por --root
packages/cli/            stats, diagnóstico e instalação MCP por projeto
skills/                  instruções de navegação para Codex
hooks/hooks.json         declara os eventos suportados no plugin portátil
```

O servidor oferece `repo_map`, `read_symbol`, `structural_search`, `graph_query` e `cost_report`. Ast-grep é opcional; a busca mantém fallback sem subprocesso opcional. Paths são canonicalizados e delimitados à raiz; limites de bytes/arquivos/resultados evitam varreduras sem limite. Arquivos secretos comuns, repositórios VCS e symlinks não são lidos.

O ledger `usage.jsonl` guarda timestamp, hash SHA-256 de sessão, IDs de turn/agente, modelo, status e campos de uso divulgados pelo evento. Detalhes textuais de erro são omitidos. Não grava prompt, resposta, transcript ou caminho da sessão. Retenção padrão: 90 dias. Armazenamento padrão é `%LOCALAPPDATA%\\Cato\\Codex` no Windows e `$XDG_DATA_HOME/cato-codex` (ou `~/.local/share/cato-codex`) nos demais sistemas; `CATO_DATA_DIR` ou `PLUGIN_DATA` pode sobrescrever.

`PostToolUse` e `PostCompact` permanecem passivos nesta versão; compressão automática de saída ainda não foi portada. O comportamento original de hooks Claude continua acoplado ao runtime Claude em `plugin/hooks/register.ts`; nenhuma API Claude é importada pelo pacote Codex.
