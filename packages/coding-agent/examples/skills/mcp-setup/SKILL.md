---
name: mcp-setup
description: Configure or troubleshoot core MCP servers (Originkit first). Use when the user asks to connect, add, remove, or debug an MCP server, or when MCP tools are missing or unhealthy.
---

# MCP setup

C-code connects to remote MCP servers natively; no extension is needed.
The sidebar has a permanent "MCP" group: a `●` lamp per server (green =
healthy, red = problem) or `○ 未配置` when no servers exist. The same lamps
mirror into the footer, so they are visible in regular mode too.

## Config resolution (first match wins)

1. `$C_CODE_MCP_CONFIG` path
2. `<cwd>/.c-code/mcp.json` (project; only when the project is trusted)
3. `<agent-dir>/extensions/mcp.json` (user-level, `~/.c-code/agent/extensions/mcp.json` by default)
4. Built-in default: Originkit at `https://mcp.originkit.dev/mcp`

Prefer `/mcp add <name> <url> [--no-auth] [--project]` over hand-editing.
It writes the entry, defaults the auth header to
`Bearer {env:<NAME>_API_KEY}`, and reconnects. A project mcp.json triggers
the project-trust prompt because it can name environment variables.

## Secrets

Never write secrets into mcp.json. Headers use `{env:VAR}` placeholders:

```json
{
	"servers": {
		"originkit": {
			"type": "remote",
			"url": "https://mcp.originkit.dev/mcp",
			"headers": { "Authorization": "Bearer {env:ORIGINKIT_API_KEY}" }
		}
	}
}
```

Tell the user to `export ORIGINKIT_API_KEY=...` in their shell before
starting C-code. A missing key shows a red lamp; no network is attempted.

## Conversational flow

1. User: "接上 originkit" → write or merge the server entry into the
   user-level mcp.json (create directories as needed), keeping `{env:VAR}`
   headers. Never ask for the key itself in a way that lands on disk.
2. Run `/mcp reconnect <name>` (or `/mcp reconnect` for all). No restart needed.
3. Verify: sidebar `● <name> N tools` green. Red → `/mcp status` shows the
   error; fix the config or the key, then reconnect.
4. Originkit `get_component` is limited to 10 calls per key per day
   (00:00 UTC reset): locate components with `search`/`list_components` first.
5. `local`/stdio entries are unsupported in v1 (red lamp plus warning).

## Removal

Delete the server entry from mcp.json, then `/mcp reconnect`.
