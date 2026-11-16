---
name: cato-efficiency
description: Navigate code repositories efficiently with CATO's MCP tools and bounded reads. Use when locating code, tracing a behavior, or answering repository questions.
---

# CATO efficiency workflow

1. Start with `repo_map` for a broad question; pass a short focus phrase when the area is known.
2. Use `structural_search` for a call shape, declaration, or syntax pattern. Use an exact phrase or a narrow regex when ast-grep is unavailable.
3. Read one symbol with `read_symbol` before loading a whole source file. Use a relative path from the configured repository root.
4. Check a graph relation with `graph_query` only when Graphify's repository graph exists. Missing optional integrations should not stop the task.
5. Avoid dependency trees, generated output, lockfiles, secret-like paths, and repeated full-file reads. Use targeted line ranges when the native file tool supports them.
6. For recognized verbose test/build/linter Bash output, preserve CATO's summary and errors; use `search_sandbox` with the shown ID to find original lines. Other tools pass through unchanged.
7. Use `cost_report` for measured request counts. Treat null or absent token usage as unavailable, never as zero. Text-size/token estimates are estimates, not measured model usage.

Keep the user's requested files and behavior in view. CATO's tools are optional: continue with native Codex tools when the MCP server or an integration is unavailable.
