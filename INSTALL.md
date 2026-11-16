# Instalação e uso no Codex

## Requisitos

- Codex CLI/Desktop com suporte a plugins e hooks locais.
- Node.js 20 ou mais novo; para desenvolvimento, pnpm 11 ou mais novo.
- Windows 10/11, macOS ou Linux. A configuração por projeto funciona no Windows; valide políticas locais de confiança antes de habilitar hooks.

## Compilar

Na raiz do checkout: `pnpm install --frozen-lockfile` e `pnpm build`.

## MCP por projeto

No repositório alvo, execute o CLI a partir do checkout do CATO:

```powershell
pnpm cato install "C:\caminho\do\projeto"
```

Isso cria/mescla `.codex/config.toml`, preserva uma cópia datada se o arquivo existia e configura o MCP com Node, servidor compilado e raiz absoluta. O parser preserva valores TOML, mas comentários/formatação podem mudar; o backup contém o original. Reinicie Codex e confirme a confiança do projeto. `pnpm cato uninstall "C:\caminho\do\projeto"` remove só a entrada `[mcp_servers.cato]` e também cria backup.

Para instalar a Skill e hooks como plugin local, use o marketplace em `.agents/plugins/marketplace.json` pela experiência de plugins do Codex; revise e aceite a execução local/hook quando solicitado. A instalação MCP pelo comando acima é independente do marketplace.

## Comandos

```powershell
pnpm cato stats
pnpm cato report
pnpm cato status
pnpm cato doctor
```

O Codex não oferece registro de slash command arbitrário para este plugin; `cato stats` é a forma CLI de `/cato-stats`. O relatório usa apenas eventos `PostModelRequest` recebidos depois da instalação dos hooks e pode indicar `unavailable`. Não calcula custo monetário, não importa transcripts e não inventa contagens. Compressão automática de saída de ferramentas ainda não está implementada no adaptador Codex.

## Dados e privacidade

Consulte [PRIVACY.md](PRIVACY.md). Para apagar o ledger, feche o Codex e remova `usage.jsonl` do diretório local CATO. `CATO_DATA_DIR` muda a pasta. O servidor MCP só enxerga a raiz informada e bloqueia caminhos fora dela.
