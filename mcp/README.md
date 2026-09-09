# Herd MCP connector

A small, **local, read-only** [MCP](https://modelcontextprotocol.io) server that exposes
**your own** Herdwatch herd to an MCP client — Claude Desktop, ChatGPT, or any other — so
you can ask about your herd from the assistant you already use, without opening the app.

It reuses the same reverse-engineered auth flow and the same on-device query/rules engine
as the web app. It runs on **your machine**; your Herdwatch login and herd data stay there.

## Read this first — privacy trade-off

The web app's promise is that **herd data stays on the device** — only your questions and
small results ever leave. This connector is different **by design**: whatever your
assistant reads through it goes to **that assistant's provider** (OpenAI, Anthropic, …) and
may be retained per their terms. That's the cost of using your own assistant as the front
door. So:

- It is **strictly opt-in** — nothing runs until you configure and launch it.
- It is **read-only** — no tool writes back to Herdwatch.
- Keep it **local** — your Herdwatch credentials live only in your own MCP client config or
  shell environment; never put them on a shared/hosted server.

If you want the private, offline-capable experience, use the in-app assistant instead.

## Requirements

- Node.js 18 or newer (uses the built-in `fetch`).

## Install

```bash
cd mcp
npm install
```

## Configure

Set your Herdwatch login as environment variables (a per-region phone number + password —
the same ones the app's connect screen uses):

| Variable | Meaning | Default |
|---|---|---|
| `HERD_PHONE` | Herdwatch username (phone number) | — (required for live mode) |
| `HERD_PASSWORD` | Herdwatch password | — (required for live mode) |
| `HERD_REGION` | Region code, e.g. `IE` | `IE` |
| `HERD_HOST` | Override the API host | `mc<region>-prod.hwbe.io` |
| `HERD_VERSION` | App-version string for the version gate | `9.9.28` |
| `HERD_REFRESH_MINUTES` | Re-sync interval; `0` = load once | `0` |

**Offline mode (no login):** instead of the login vars, point it at an exported sync:

| Variable | Meaning |
|---|---|
| `HERD_FARMDATA` | path to a `farmdata.json` (the `system_type:false` payload) |
| `HERD_REFERENCE` | path to a `reference.json` (the `system_type:true` payload) |

> If the version gate returns HTTP 426, bump `HERD_VERSION` to the current app version
> (see the API notes in the repo's `CLAUDE.md`).

## Use with Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "herd": {
      "command": "node",
      "args": ["/absolute/path/to/herd/mcp/herd-mcp.mjs"],
      "env": {
        "HERD_PHONE": "0861234567",
        "HERD_PASSWORD": "your-password",
        "HERD_REGION": "IE"
      }
    }
  }
}
```

Restart Claude Desktop; "herd" appears as a connected tool. Ask things like
*"what needs my attention on the herd today?"* or *"show me the history for #60009"*.

## Use with ChatGPT / other clients

Any MCP client that can launch a local stdio server works — point it at
`node /absolute/path/to/herd/mcp/herd-mcp.mjs` with the same env vars. In ChatGPT this is
under its MCP/connector settings where available on your plan.

## Tools exposed

| Tool | What it returns |
|---|---|
| `herd_summary` | herd size, species, datasets, detected key fields |
| `query_herd` | exact counts / filtered lists / group breakdowns / aggregates |
| `get_animal` | one animal's full record, codes and references resolved to names |
| `history_for` | a date-sorted timeline of records referencing one animal |
| `list_tasks` | tasks filtered `open` / `overdue` / `done` / `all` |
| `recommendations` | the on-device jobs feed: `now` / `book` / `watch` |

All results are computed locally by the same engine the app uses — the numbers are exact,
not the assistant's estimate.

## Verify it works

Run the offline smoke test against the bundled example herd (no login, no network):

```bash
npm run smoke
```

You should see a summary, a couple of queries, the recommendation list, and a history
timeline. `example.farmdata.json` / `example.reference.json` are **illustrative sample
data**, not a real herd.
