# Getting Started

This guide helps you choose the right setup and get started with AI-powered Logic Apps management.

## Decision Flowchart

```
        Do you have a local AI assistant?
        (GitHub Copilot, Claude Desktop, Cursor)
                    │
         ┌──────────┴──────────┐
         │                     │
        YES                    NO
         │                     │
         ▼                     ▼
┌─────────────────┐    ┌─────────────────┐
│ Local MCP Server│    │ Cloud MCP Server│
│                 │    │                 │
│ npm install +   │    │ Deploy to Azure │
│ AI config       │    │ + remote AI     │
└─────────────────┘    └─────────────────┘

Both options require Azure access (az login) to get credentials.
```

| Aspect | Local MCP Server | Cloud MCP Server |
|--------|------------------|------------------|
| **Setup** | `npm install` + AI config | Deploy to Azure |
| **AI Model** | Your local AI (Copilot, Claude) | Bring your own AI client |
| **API Auth** | Your Azure CLI credentials | Passthrough (client provides bearer token) |
| **Resource Access** | What *you* can access | What *the token holder* can access |
| **Best For** | Individual developers | Remote/hosted AI integrations |

## Local MCP Server Setup

### Prerequisites

- [Azure CLI](https://aka.ms/installazurecli) installed and authenticated (`az login`)
- Node.js 20+
- GitHub Copilot or Claude Desktop

### Step 1: Install

```bash
npm install -g logicapps-mcp
```

### Step 2: Login to Azure and verify

```bash
az login
logicapps-mcp --check     # or: npx -y logicapps-mcp --check
```

`--check` verifies the configuration, Azure CLI installation and login, token acquisition,
subscription access and [resource scope](CONFIGURATION.md#resource-scope), prints a fix for anything that is wrong, and exits non-zero on failure:

```
$ logicapps-mcp --check
logicapps-mcp setup check (azure-cli auth)
  ✔ Configuration: Cloud: AzurePublic; tenant: common
  ✔ Capabilities: Read-only (default). Tools that run, change, or expose secrets of live Logic Apps are disabled.
      → To enable more, add e.g. '--allow write,execute' to the server args or set LOGICAPPS_MCP_CAPABILITIES.
  ✔ Azure CLI installed: Azure CLI 2.67.0
  ✖ Azure CLI login: Not logged in to Azure CLI. Please run: az login
      → Run 'az login' in a terminal, then retry (no server restart needed).
  – Azure Resource Manager token: Skipped: Azure CLI login failed
  – Subscription access: Skipped: no Azure token
  – Resource scope: Skipped: no subscription access
Setup has 1 problem(s). Most tools will fail until fixed.
```

### Step 3: Configure Your AI Assistant

> **Read-only by default.** With the configurations below, the server can inspect workflows,
> run history and action I/O, analyze failures and extract test data, but it **cannot** run
> triggers, resubmit/cancel runs, change workflows, or reveal callback URLs. To allow those, see
> [Enabling write operations](#enabling-write-operations).

#### GitHub Copilot in VS Code

1. Install [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) and GitHub Copilot Chat extensions

2. Create/edit `.vscode/mcp.json` in your workspace:

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

3. Reload VS Code (`Ctrl+Shift+P` → "Developer: Reload Window")

4. Open Copilot Chat and start asking questions

> **Tip:** Ensure you've run `az login` before starting VS Code.

#### Claude Desktop

Add to your Claude Desktop configuration:
- **macOS**: `~/.config/claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "logicapps": {
      "command": "npx",
      "args": ["-y", "logicapps-mcp"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "logicapps": {
      "command": "logicapps-mcp"
    }
  }
}
```

Restart Claude Desktop after saving.

#### Enabling write operations

Opt in to only the capabilities you need by adding `--allow` to `args`:

| Capability | Allows |
|------------|--------|
| `execute` | `run_trigger`, `resubmit_run`, `cancel_run` |
| `write` | create/update/delete/enable/disable/clone workflows, `create_connection` |
| `connector` | `invoke_connector_operation`, live probe in `test_connection` |
| `secrets` | `get_trigger_callback_url` |
| `all` | Everything above |

VS Code (`.vscode/mcp.json`), allowing workflow edits and re-running runs:

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

Claude Desktop:

```json
{
  "mcpServers": {
    "logicapps": {
      "command": "npx",
      "args": ["-y", "logicapps-mcp", "--allow", "write,execute"]
    }
  }
}
```

Alternatively set `"env": { "LOGICAPPS_MCP_CAPABILITIES": "write,execute" }` in the server entry, or
`"capabilities"` in `~/.logicapps-mcp/config.json`. Restart/reload the client afterwards. Your Azure
identity still needs the matching RBAC role (e.g. `Logic App Contributor`). See
[Configuration → Capabilities](CONFIGURATION.md#capabilities-read-only-by-default).

### Step 4: Test It

Try these prompts:
- "List my Azure subscriptions"
- "Show Logic Apps in subscription xyz"
- "What workflows failed in the last 24 hours?"

If you ask for a change (e.g. "disable this workflow") while read-only, the assistant will report
that the `write` capability is disabled and how to enable it.

### Troubleshooting

The server runs the same setup checks in the background every time it starts:

- Results are written to the server's log (VS Code: **MCP: List Servers → logicapps → Show Output**;
  Claude Desktop: `mcp-server-logicapps.log`).
- Problems are also sent to the client as MCP log notifications.
- Ask the assistant **"check the Logic Apps MCP setup"** — it calls the `check_setup` tool and relays
  the remediation steps. Tools that fail with authentication errors also point it at `check_setup`.

| Symptom | Fix |
|---------|-----|
| Azure CLI is not installed or not on PATH | Install from https://aka.ms/installazurecli, then restart the client so it picks up the new PATH |
| Not logged in / login expired | `az login` (no restart needed) |
| Signed in to the wrong tenant | `az login --tenant <AZURE_TENANT_ID>` |
| Azure CLI using a different cloud | `az cloud set --name AzureUSGovernment` (or `AzureChinaCloud`) then `az login` |
| No subscriptions visible | Ask for `Reader`/`Logic App Operator` on the subscription or resource group |
| `OutOfScope` errors | The server is scoped by `AZURE_RESOURCE_GROUP` / `LOGIC_APP_NAME`; widen or remove the scope (see [Resource scope](CONFIGURATION.md#resource-scope)) |
| Scope check fails: `LOGIC_APP_NAME ... matches N Logic Apps` | Also set `AZURE_SUBSCRIPTION_ID` and/or `AZURE_RESOURCE_GROUP` |
| Config file ignored | Fix the JSON in `~/.logicapps-mcp/config.json` (reported as a warning) |

## Cloud MCP Server Setup

Deploy a hosted MCP server to Azure. The server uses **passthrough authentication**—it has no Azure credentials of its own. Clients must provide an ARM-scoped bearer token in the `Authorization` header.

### Prerequisites

1. Azure subscription
2. Azure CLI installed and authenticated (`az login`)
3. Azure Functions Core Tools (`npm install -g azure-functions-core-tools@4`)
4. Node.js 20+

### Step 1: Deploy

```bash
# PowerShell
./deploy/deploy.ps1 -ResourceGroup my-rg -CreateResourceGroup

# Bash
./deploy/deploy.sh -g my-rg --create-rg
```

This creates:
- **Function App** - Hosts the MCP server
- **Storage Account** - Required for Functions runtime
- **Application Insights** - Telemetry and monitoring

The deployed server is also **read-only by default**. To enable additional capabilities for all
callers, set the `LOGICAPPS_MCP_CAPABILITIES` app setting and restart:

```bash
az functionapp config appsettings set -g my-rg -n <your-app> \
  --settings LOGICAPPS_MCP_CAPABILITIES=write,execute
```

Each caller's own token still determines what they can do in Azure; capabilities only control
which tools the server exposes.

### Step 2: Test the Deployment

```bash
# Get an ARM-scoped token
TOKEN=$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)

# Test health endpoint
curl -H "Authorization: Bearer $TOKEN" https://<your-app>.azurewebsites.net/api/health

# Expected: {"status":"ok","version":"0.2.0"}
```

### Step 3: Connect Your AI Client

The MCP endpoint is available at:
```
https://<your-app>.azurewebsites.net/api/mcp
```

Configure your AI client to:
1. Send requests to the MCP endpoint
2. Include `Authorization: Bearer <ARM-token>` header
3. Use the MCP protocol (JSON-RPC over HTTP)

### Authentication Model

The cloud MCP server uses **passthrough authentication**:

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│    AI Client     │ ──> │    MCP Server    │ ──> │    Azure ARM     │
│                  │     │  (Function App)  │     │      APIs        │
└──────────────────┘     └──────────────────┘     └──────────────────┘
          │                        │                        │
          │ Authorization:         │ Uses client's          │
          │ Bearer <ARM-token>     │ token directly         │
          └────────────────────────┴────────────────────────┘
```

- **No managed identity for ARM**: The server doesn't have its own Azure access
- **Token required**: Every request must include an ARM-scoped bearer token
- **User-scoped access**: Users only see resources they have access to
- **No token = error**: Requests without a valid token will fail

### Getting an ARM Token

```bash
# Azure CLI
az account get-access-token --resource https://management.azure.com --query accessToken -o tsv

# PowerShell
$token = (Get-AzAccessToken -ResourceUrl https://management.azure.com).Token
```

## Next Steps

- [Available Tools](TOOLS.md) - See all 40 tools
- [Configuration](CONFIGURATION.md) - Environment variables and authentication
