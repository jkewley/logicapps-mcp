# Available Tools

This MCP server provides 42 tools for diagnosing, documenting and managing Azure Logic Apps.

## Read-only by default

The server starts **read-only**. Tools that invoke, modify, or expose secrets of a live Logic App
are hidden from `tools/list` and rejected if called, until you opt in to the capability they need.
See [Configuration → Capabilities](CONFIGURATION.md#capabilities-read-only-by-default).

| Capability | Default | Tools |
|------------|---------|-------|
| `read` | ✅ always on | Everything not listed below |
| `execute` | opt-in | `run_trigger`, `resubmit_run`, `cancel_run` |
| `write` | opt-in | `create_workflow`, `update_workflow`, `delete_workflow`, `enable_workflow`, `disable_workflow`, `clone_workflow`, `create_connection` |
| `connector` | opt-in | `invoke_connector_operation`, active probe in `test_connection` |
| `secrets` | opt-in | `get_trigger_callback_url` (returns a SAS-signed URL) |

Each listed tool also carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients can prompt for confirmation appropriately.

## Discovery & Navigation

| Tool | Description |
|------|-------------|
| `list_subscriptions` | List all accessible Azure subscriptions |
| `list_logic_apps` | List Logic Apps in a subscription (filter by SKU) |
| `list_workflows` | List workflows within a Standard Logic App |

## Workflow Definitions

| Tool | Description |
|------|-------------|
| `get_workflow_definition` | Get workflow JSON definition |
| `get_workflow_swagger` | Get OpenAPI/Swagger definition for a workflow |
| `list_workflow_versions` | List all versions of a Consumption Logic App |
| `get_workflow_version` | Get a specific historical version's definition (Consumption only) |

## Triggers

| Tool | Description |
|------|-------------|
| `get_workflow_triggers` | Get trigger information and execution times |
| `get_trigger_history` | Get execution history of a specific trigger |
| `get_trigger_callback_url` | Get callback URL for request-based triggers *(requires `secrets`)* |

## Run History & Debugging

| Tool | Description |
|------|-------------|
| `list_run_history` | Get run history with optional filtering |
| `search_runs` | Search runs with friendly parameters (status, time range, tracking ID); returns `skipToken` for paging |
| `get_run_details` | Get details of a specific run |
| `get_run_actions` | Get action execution details for a run |
| `get_action_io` | Get actual input/output content for a run action (use `repetitionName` for a loop iteration) |
| `get_action_repetitions` | Get iteration details for loop actions (ForEach, Until) |
| `get_scope_repetitions` | Get execution details for scope actions (Scope, Switch, Condition) |
| `get_action_request_history` | Get HTTP request/response details for connector actions |
| `get_expression_traces` | Get expression evaluation traces for an action |

## Failure Analysis & Test Data

| Tool | Description |
|------|-------------|
| `analyze_run_failures` | Aggregate recent failed runs by failing action and error code, distinguishing root-cause failures from propagated `ActionFailed`/skipped ones. Good first step for "why does this keep failing?" |
| `extract_run_test_data` | Turn a historical run into test fixtures: trigger payload, per-action mock outputs/status (shaped like the Logic Apps Automated Test SDK `TriggerMock`/`ActionMock`) and expected statuses. Redacts secrets by default; truncates payloads above `maxPayloadBytes` |

> Redaction is heuristic (header/key names such as `authorization`, `password`, `*secret*`, `*token*`, SAS `sig`/`code` query parameters, connection-string keys, bearer tokens). Always review extracted data before committing it.

## Connections & Connectors

| Tool | Description |
|------|-------------|
| `get_connections` | List API connections in a resource group |
| `get_connection_details` | Get detailed information about a specific API connection |
| `test_connection` | Check whether an API connection is healthy (status-only unless `connector` is enabled, which also runs the connector's live test link) |
| `create_connection` | Create a new API connection for a managed connector *(requires `write`)* |
| `get_connector_swagger` | Get OpenAPI/Swagger definition for a managed connector |
| `invoke_connector_operation` | Invoke dynamic operations to fetch schemas, tables, queues, etc. *(requires `connector`)* |

## Execute Operations (opt-in: `execute`)

| Tool | Description |
|------|-------------|
| `run_trigger` | Manually fire a workflow trigger |
| `resubmit_run` | Resubmit a previous run using its original trigger inputs |
| `cancel_run` | Cancel a running or waiting workflow run |

## Write Operations (opt-in: `write`)

| Tool | Description |
|------|-------------|
| `enable_workflow` | Enable a disabled workflow |
| `disable_workflow` | Disable an active workflow |
| `create_workflow` | Create a new workflow (Consumption: new Logic App; Standard: new workflow). Fails with `ConflictError` if it already exists; optional `state` |
| `update_workflow` | Update an existing workflow's definition (Standard: preserves existing `kind` unless overridden) |
| `delete_workflow` | Delete a workflow (use with caution) |
| `clone_workflow` | Clone a Consumption Logic App to a Standard Logic App workflow |

## Migration

| Tool | Description |
|------|-------------|
| `validate_clone_workflow` | Validate a Consumption Logic App can be cloned to Standard (read-only) |

## Host & Diagnostics (Standard SKU)

| Tool | Description |
|------|-------------|
| `get_host_status` | Get host status for Standard Logic Apps (runtime version, diagnostics) |

## Knowledge Tools

| Tool | Description |
|------|-------------|
| `get_troubleshooting_guide` | Built-in documentation for debugging patterns |
| `get_authoring_guide` | Workflow authoring best practices |
| `get_reference` | SKU differences and API reference |
| `get_workflow_instructions` | Common workflow patterns and examples |

## MCP Prompts

MCP Prompts provide AI assistants with guidance on tool selection and common workflows.

| Prompt | Description |
|--------|-------------|
| `logic-apps-guide` | System guidance covering SKU differences, debugging workflows, and tool selection tips |

> **Note**: Prompt availability depends on the MCP client. Claude Desktop supports prompts; GitHub Copilot does not yet.

## See Also

- [Getting Started](GETTING_STARTED.md) - Setup for local MCP server or cloud agent
- [Configuration](CONFIGURATION.md) - Environment variables and authentication
- [Cloud MCP Server](design/CLOUD_MCP_SERVER.md) - Deploy to Azure for team/enterprise use
