# CATO Privacy Policy

## Codex adaptation in this fork

The Codex adapter stores data under `%LOCALAPPDATA%\\Cato\\Codex` on Windows or `$XDG_DATA_HOME/cato-codex` on other systems (override with `CATO_DATA_DIR` or `PLUGIN_DATA`). Its `usage.jsonl` records documented `PostModelRequest` usage fields when available, model/status/turn/agent metadata, a one-way session hash, and a generic error marker; detailed error text is omitted. Missing usage stays unknown. It does not store prompts, model responses, transcript contents, or session paths in this ledger. Entries older than 90 days are removed when the ledger is updated.

When a recognized verbose Bash test/build/linter command is compressed by at least 30%, the original terminal output is stored under `logs/cmd_*.json` for 14 days so `search_sandbox` can retrieve matching lines. Raw tool output may include sensitive data; the log stays local and can be deleted at any time. Commands are not stored. `compressions.jsonl` keeps byte counts and strategy metadata, not the output text.

The MCP server reads source files only under the explicit project root configured during installation. It skips common secret paths, VCS metadata, symlinks and oversized/binary files. Hook scripts run locally when Codex trusts and enables them. No CATO network requests or telemetry are added. You may delete any ledger or log file in the data directory at any time.

The original Claude Code privacy description below continues to describe the upstream adapter, not the Codex ledger.

_Last updated: 2026-10-30_

CATO is a Claude Code plugin that runs entirely on your machine. It has no server, no account and no telemetry.

## What CATO reads

- **Claude Code session transcripts** (`~/.claude/projects`), for `/cato` and `/cato-import`. Only token usage, model, timestamps and tool names are used.
- **Claude Code settings** (`settings.json`, `settings.local.json` and the project's `.mcp.json`), for `/cato-doctor`. CATO does not read `~/.claude.json` or any credential file.
- **Tool output** in the current session (shell commands, MCP responses), to compress or sandbox it.

## What CATO stores

All on your machine:

- Counts of tokens, costs and interventions, in CATO's store inside Claude Code.
- Raw logs of compressed shell output in `~/.cato/logs` and large MCP responses in `~/.cato/sandbox`. These may contain whatever the command or tool returned. They are deleted automatically after 14 days, and you can delete the folder at any time.

## What CATO sends

Nothing. CATO makes no network requests of its own and shares no data with the author or any third party. The optional, off-by-default `warmCache` feature makes one small call to the session's own Claude model through Claude Code, like any other turn.

## Contact

Questions: open an issue at https://github.com/marcusaguiarmaciel-cmd/cato-plugin/issues
