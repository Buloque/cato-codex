# Instalação e uso no Codex

## Requisitos

- Codex CLI/Desktop com suporte a plugins e hooks locais.
- Node.js 20 ou mais novo; para desenvolvimento, pnpm 11 ou mais novo.
- Windows 10/11, macOS ou Linux. A configuração por projeto funciona no Windows; valide políticas locais de confiança antes de habilitar hooks.

## Compilar

Na raiz do checkout: `pnpm install --frozen-lockfile` e `pnpm build`. Para gerar o pacote preview com manifestos, Skill, hooks e bundles já compilados, execute `pnpm package`; o arquivo fica em `dist/cato-codex-0.1.0.tgz`.

## MCP por projeto

No repositório alvo, execute o CLI a partir do checkout do CATO:

```powershell
pnpm cato install "C:\caminho\do\projeto"
```

Isso cria/mescla `.codex/config.toml`, preserva uma cópia datada se o arquivo existia e configura o MCP com Node, servidor compilado e raiz absoluta. O parser preserva valores TOML, mas comentários/formatação podem mudar; o backup contém o original. Reinicie Codex e confirme a confiança do projeto. `pnpm cato uninstall "C:\caminho\do\projeto"` remove só a entrada `[mcp_servers.cato]` e também cria backup.

Para instalar a Skill e hooks como plugin local pelo CLI:

```powershell
codex plugin marketplace add "C:\caminho\do\checkout\cato-codex"
codex plugin add cato-codex --marketplace cato-codex-local
```

O marketplace do repositório também é descoberto pelo Codex Desktop quando o projeto é aberto. Revise e aceite a execução local/hook quando solicitado. A instalação MCP pelo comando acima é independente do marketplace.

## Comandos

```powershell
pnpm cato stats
pnpm cato report
pnpm cato status
pnpm cato doctor
pnpm cato config
```

O Codex não oferece registro de slash command arbitrário para este plugin; `cato stats` é a forma CLI de `/cato-stats`. O relatório usa apenas eventos `PostModelRequest` recebidos depois da instalação dos hooks e pode indicar `unavailable`. Não calcula custo monetário, não importa transcripts e não inventa contagens. O hook resume somente saídas Bash reconhecidas; a saída original pode conter conteúdo sensível e fica em logs locais por até 14 dias.

## Dados e privacidade

Consulte [PRIVACY.md](PRIVACY.md). Para apagar o ledger, feche o Codex e remova `usage.jsonl` do diretório local CATO. `CATO_DATA_DIR` muda a pasta. O servidor MCP só enxerga a raiz informada e bloqueia caminhos fora dela.
