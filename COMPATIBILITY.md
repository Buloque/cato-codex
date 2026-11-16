# Compatibilidade CATO / Codex

Status verificado em 16/11/2026; revise contra as versões usadas antes de distribuir.

| Capacidade CATO original | Codex | Implementação neste fork |
|---|---|---|
| Orientação de navegação e leitura precisa | Nativa via Agent Skills e MCP | `skills/cato-efficiency` e seis ferramentas MCP |
| Mapa, símbolos e buscas | Parcialmente equivalente | Reuso de utilitários puros; ast-grep é opcional, fallback local |
| Compressão de saída de ferramenta | Hook local PostToolUse pode devolver feedback após executar ação | Bash para testes/build/linter reconhecidos; saída bruta pesquisável por ID durante 14 dias; MCP estruturado passa intacto |
| Métricas de tokens | PostModelRequest best-effort por tentativa | Ledger local com campos desconhecidos como `null`; retries contam como requests separados |
| Custo monetário/cache misses | Não há campo oficial equivalente acessível ao plugin local | Não calculado nem estimado |
| Compactação | Codex já compacta a conversa | Usa a compactação nativa; sem leitura de transcript interno instável |
| Slash commands `/cato...` | Plugins não registram comandos slash arbitrários | `pnpm cato <subcomando>` / `node dist/cli/index.js <subcomando>` |
| MCP de projeto | Compatível com config TOML de projeto | `cato install` grava apenas `.codex/config.toml` do alvo; raiz absoluta é explícita |
| Hooks do plugin | Disponíveis com revisão de confiança e instalação explícita | Manifesto aponta para hooks empacotados; autorização e execução devem ser aceitas pelo usuário |
| Hooks Claude | Sem compatibilidade de payload | Adaptador e arquivos originais são preservados; não foram refatorados para o core Codex |

Os eventos e campos dependem da documentação pública de Hooks do Codex. `PostModelRequest.token_usage` é best-effort e pode estar ausente. `PostToolUse` pode substituir o resultado visível após a ação ter ocorrido; não é uma barreira preventiva completa. Ferramentas hospedadas podem ficar fora do caminho dos hooks locais.

O MCP recebe `--root` explicitamente. Não presume que `process.cwd()` seja o workspace, pois o plugin pode iniciar a partir do cache do plugin e o protocolo de roots não está disponível nesse contexto documentado. Configurar por projeto evita alterar a configuração global.

Referências: [Hooks](https://developers.openai.com/codex/hooks.md), [plugins](https://developers.openai.com/plugins/build/plugins), [MCP local](https://developers.openai.com/plugins/deploy/desktop-only), [skills](https://developers.openai.com/api/reference/cli), [limitação de raiz no Codex](https://github.com/openai/codex/issues/37903).
