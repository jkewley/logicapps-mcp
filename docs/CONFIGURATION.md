# Configuration

Advanced configuration options for the local MCP server. Most users won't need these - the defaults work with `az login`.

## Environment Variables

| Variable | Purpose | Default Behavior |
|----------|---------|------------------|
| `AZURE_TENANT_ID` | Lock to a specific Azure AD tenant | Uses `common` - auto-detects tenant from your login |
| `AZURE_CLIENT_ID` | Use a custom app registration | Uses Azure CLI's public client ID |
| `AZURE_SUBSCRIPTION_ID` | Set a default subscription | None - you'll specify subscription in each request |
| `AZURE_CLOUD` | Connect to sovereign clouds | `AzurePublic` |
| `LOGICAPPS_MCP_LOG_LEVEL` | Control verbosity (debug, info, warn, error) | `info` |
| `LOGICAPPS_MCP_CACHE_TTL` | Cache duration in seconds | `300` |
| `LOGICAPPS_MCP_CAPABILITIES` | Comma-separated opt-in capabilities (`execute`, `write`, `connector`, `secrets`, or `all`) | Read-only |

### When to use these

- **Multi-tenant scenarios**: Set `AZURE_TENANT_ID` to avoid tenant picker prompts
- **Enterprise policies**: Set `AZURE_CLIENT_ID` if your org requires a specific app registration
- **Single subscription**: Set `AZURE_SUBSCRIPTION_ID` to skip specifying it in every request
- **Government/China clouds**: Set `AZURE_CLOUD` to `AzureGovernment` or `AzureChina`

## Capabilities (read-only by default)

The server is **read-only by default**: it can list, inspect and analyze Logic Apps, runs and
connections, but cannot trigger, change or reveal secrets of anything running in Azure. Opt in
to additional capabilities only when you need them:

| Capability | Enables |
|------------|---------|
| `read` | Always on. Discovery, definitions, run history, action I/O, failure analysis, test-data extraction, knowledge tools |
| `execute` | `run_trigger`, `resubmit_run`, `cancel_run` |
| `write` | `create_workflow`, `update_workflow`, `delete_workflow`, `enable_workflow`, `disable_workflow`, `clone_workflow`, `create_connection` |
| `connector` | `invoke_connector_operation` and the live probe in `test_connection` (calls the backend system through the connector) |
| `secrets` | `get_trigger_callback_url` (SAS-signed trigger URL) |

Disabled tools are hidden from `tools/list`; calling one returns a `CapabilityDisabled` error that
explains how to enable it. Unknown capability names fail startup.

Ways to opt in (first match wins):

1. **CLI flag**: `logicapps-mcp --allow execute,write` (repeatable; also `--allow=all`)
2. **Environment variable**: `LOGICAPPS_MCP_CAPABILITIES=execute,write`
3. **Config file**: `"capabilities": ["execute"]` in `~/.logicapps-mcp/config.json`

Example VS Code configuration enabling run/resubmit only:

```json
{
  "servers": {
    "logicapps": {
      "type": "stdio",
      "command": "logicapps-mcp",
      "args": ["--allow", "execute"]
    }
  }
}
```

The policy is process-wide and applies equally to stdio, HTTP and Azure Functions hosts.

## Config File

Alternative to environment variables. Create `~/.logicapps-mcp/config.json`:

```json
{
  "tenantId": "your-tenant-id",
  "clientId": "your-client-id",
  "defaultSubscriptionId": "your-subscription-id",
  "capabilities": []
}
```

Environment variables take precedence over the config file.

## Authentication

This MCP server uses Azure CLI for authentication. Before using it, ensure you're logged in:

```bash
az login
```

In local (stdio) mode the MCP server uses the Azure CLI's tokens, caching each until shortly before expiry. In HTTP/Azure Functions mode each request must carry its own `Authorization: Bearer` token; tokens are scoped per request and never fall back to the server's Azure CLI identity.

### Verifying your setup

Run `logicapps-mcp --check` (add the same `--allow` flags you use in your client config) to verify
configuration, Azure CLI login, token acquisition and subscription access. It prints a remediation
for each problem and exits with code `1` if any check fails. The same checks run in the background
at server startup (results go to the server log and to MCP log notifications) and are available to
the AI assistant through the `check_setup` tool.

Invalid settings are reported rather than silently ignored: a malformed config file, an unknown
`LOGICAPPS_MCP_LOG_LEVEL`, or a non-numeric `LOGICAPPS_MCP_CACHE_TTL` produce warnings and fall
back to defaults. An unknown capability name is a startup error.

> Note: `AZURE_TENANT_ID` does not change which tenant Azure CLI signs in to. If it differs from
> the CLI's tenant, the check warns and suggests `az login --tenant <id>`.

### Required Azure Permissions

| Role | Scope | Purpose |
|------|-------|---------|
| `Logic App Contributor` | Subscription/RG/Resource | Required for `execute`/`write`/`secrets` capabilities |
| `Reader` | Subscription/RG | List resources and resource groups |

For read-only use with **Consumption** Logic Apps, `Logic App Operator` or `Reader` is sufficient.

> **Standard Logic Apps**: run history and workflow files are read through the app's host runtime
> APIs, which currently requires retrieving the host master key (`Microsoft.Web/sites/host/listkeys`).
> That needs a role that includes `Microsoft.Web/sites/host/listkeys/action` (for example `Website Contributor`), even for read-only use.

## See Also

- [Getting Started](GETTING_STARTED.md) - Setup guides for local MCP server or cloud agent
- [Available Tools](TOOLS.md) - All 43 tools
- [Cloud MCP Server](design/CLOUD_MCP_SERVER.md) - Deploy to Azure for team/enterprise use
