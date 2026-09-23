# astrobaas-mcp

The [Model Context Protocol](https://modelcontextprotocol.io) server for
[AstroBaaS](https://github.com/operator888/astrobaas). It lets an AI agent
(Claude Desktop, Claude Code, or any MCP client) read and write the content of a
running AstroBaaS backend.

It has no dependencies and talks to your backend over its HTTP API, so it runs
straight from `npx`. You do not need AstroBaaS itself installed on the machine
that runs the agent.

```json
{
  "mcpServers": {
    "astrobaas": {
      "command": "npx",
      "args": ["-y", "astrobaas-mcp"],
      "env": {
        "ASTROBAAS_URL": "https://cms.example.com",
        "ASTROBAAS_KEY": "abk_..."
      }
    }
  }
}
```

| variable | meaning |
| --- | --- |
| `ASTROBAAS_URL` | Base URL of the backend. Default `http://localhost:4321`. |
| `ASTROBAAS_KEY` | An API key, minted in the admin or at `POST /api/keys`. Required to write; its scopes decide what the agent may do. |

The tools, and what each one needs, are documented in
[INTEGRATION.md](https://github.com/operator888/astrobaas/blob/main/INTEGRATION.md).

This package is built from `bin/astrobaas-mcp.mjs` in the AstroBaaS repository
at release time, so it is the same server the `astrobaas` package ships as its
`astrobaas-mcp` binary. Licensed GPL-3.0-or-later.
