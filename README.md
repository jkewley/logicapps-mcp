# Azure Logic Apps MCP Server

[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.laveeshb%2Flogicapps--mcp-blue)](https://registry.modelcontextprotocol.io/)
[![npm](https://img.shields.io/npm/v/logicapps-mcp)](https://www.npmjs.com/package/logicapps-mcp)

<img src="https://raw.githubusercontent.com/benc-uk/icon-collection/master/azure-icons/Logic-Apps.svg" alt="Azure Logic Apps" width="80" align="right">

Manage and debug Azure Logic Apps using natural language. Ask your AI assistant to investigate failed runs, explain workflows, or make changes—no portal clicking required.

```
You:  Why did my order-processing workflow fail this morning?

AI:   Looking at the run history... Found a failed run at 10:15 AM.
      The HTTP action "Call-Payment-API" failed with 503 Service Unavailable.
      The payment service at api.payments.com was down for 3 minutes.

You:  Add retry logic to that action - 3 attempts with exponential backoff.

AI:   Done. Updated the workflow with retry policy. Want me to test it?
```

Works with **GitHub Copilot**, **Claude Desktop**, or any MCP-compatible AI client. Supports both Consumption and Standard Logic Apps.

## Quick Start

```bash
# 1. Install
npm install -g logicapps-mcp

# 2. Login to Azure, then verify the setup
az login
logicapps-mcp --check

# 3. Configure your AI assistant (example for VS Code)
```

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "logicapps": {
      "type": "stdio",
      "command": "logicapps-mcp"
    }
  }
}
```

Reload VS Code and start chatting with Copilot about your Logic Apps!

### Read-only by default

Out of the box the server only **reads**: it can inspect workflows, run history and action inputs/outputs, analyze failures and extract test data, but it cannot trigger runs, change workflows, or reveal callback URLs. Opt in when you need more by adding `--allow`:

```json
{
  "servers": {
    "logicapps": {
      "type": "stdio",
      "command": "logicapps-mcp",
      "args": ["--allow", "write,execute"]
    }
  }
}
```

Capabilities: `execute` (run/resubmit/cancel), `write` (create/update/delete/enable/disable/clone, create connections), `connector` (live connector calls), `secrets` (trigger callback URLs), or `all`. You can also set `LOGICAPPS_MCP_CAPABILITIES`. See [Configuration](docs/CONFIGURATION.md#capabilities-read-only-by-default).

> **Cloud MCP Server**: Need a hosted deployment? See the [Getting Started Guide](docs/GETTING_STARTED.md#cloud-mcp-server-setup) for Azure deployment instructions.

## Features

- **43 Tools** for Logic Apps operations: list, debug, document, create, update, delete workflows
- **Safe by default**: read-only unless you opt in to `execute`, `write`, `connector` or `secrets`
- **Setup diagnostics**: `--check` and the `check_setup` tool report missing `az login`, tenant/cloud mismatches, config errors and access problems with fixes
- **Dual SKU Support**: Works with both Consumption and Standard Logic Apps
- **Run Debugging**: Trace failures through actions, loops (per-iteration I/O), and scopes
- **Failure Analysis**: `analyze_run_failures` groups recurring failures by root-cause action and error code
- **Test Data from History**: `extract_run_test_data` turns a real run into redacted trigger/action mocks for modernization and regression tests
- **Write Operations** (opt-in): Create workflows, run triggers, resubmit or cancel runs
- **Connector Support**: Discover connectors, create connections

## Example Prompts

```
"List my Logic Apps in subscription xyz"
"Show failed runs from the last 24 hours"
"What went wrong in run ID abc123?"
"Which actions have been failing most often this week, and why?"
"Extract test data from yesterday's successful order run so I can mock it"
"Add retry logic to the HTTP action"
"Disable the order-processing workflow"
```

## Documentation

- [Getting Started Guide](docs/GETTING_STARTED.md) - Setup for Claude, Copilot, Cloud MCP Server
- [Available Tools](docs/TOOLS.md) - All 43 tools with descriptions and required capabilities
- [Configuration](docs/CONFIGURATION.md) - Environment variables, auth, SKU differences
- [Changelog](CHANGELOG.md) - Release history

## Development

```bash
npm run dev              # Run in development mode
npm test                 # Run unit tests
npm run test:integration # Run integration tests (requires Azure setup)
npm run test:all         # Run all tests
```

### Integration Testing

Integration tests run against real Azure resources. They auto-discover your subscriptions and Logic Apps:

```bash
az login                     # Login to Azure
npm run test:integration     # Tests find resources automatically
```

## License

MIT
