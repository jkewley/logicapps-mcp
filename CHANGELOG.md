# Changelog

## [Unreleased]

### ⚠️ Breaking Changes
- **Read-only by default.** Tools that invoke, modify, or expose secrets of live Logic Apps are now
  opt-in via capabilities (`execute`, `write`, `connector`, `secrets`, or `all`). Enable with
  `--allow <list>`, `LOGICAPPS_MCP_CAPABILITIES`, or `"capabilities"` in the config file.
  Disabled tools are hidden from `tools/list` and return `CapabilityDisabled` if called.
- `create_workflow` no longer overwrites: it fails with `ConflictError` if the Consumption Logic App
  or Standard workflow already exists, and requires the Standard app to exist when `workflowName` is given.
- `list_logic_apps`, `get_connections` and `get_run_actions` now return all pages; their `nextLink` fields were removed.
- `test_connection` only reports status unless `connector` is enabled (the live probe calls the backend).

### Added
- Resource scope: `AZURE_RESOURCE_GROUP` / `--resource-group` limits the server to one resource group, and `LOGIC_APP_NAME` / `--logic-app` limits it to one Logic App plus the Logic Apps it calls (via Workflow actions and HTTP calls to Logic App trigger URLs, followed transitively). Scoped parameters become optional, out-of-scope requests fail with `OutOfScope`, list results are filtered, and `check_setup` reports the resolved apps.
- `AZURE_SUBSCRIPTION_ID` / `defaultSubscriptionId` is now actually used as the default `subscriptionId` for tools.
- Setup diagnostics: `logicapps-mcp --check` CLI flag, background checks at stdio startup (server log + MCP log notifications), and a `check_setup` tool. Detects missing/unauthenticated Azure CLI, expired login, tenant/cloud mismatch, invalid config, and subscription access problems, with remediation steps. Authentication errors from other tools point to `check_setup`.
- Config problems (malformed config file, invalid log level or cache TTL) are reported as warnings instead of being silently ignored.
- `analyze_run_failures`: groups recent failed runs by failing action and error code, ranking root causes over propagated failures.
- `extract_run_test_data`: converts a historical run into redacted trigger/action mocks and expected statuses for test fixtures.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on every tool.
- `get_action_io` accepts `repetitionName` for per-iteration loop inputs/outputs.
- `create_workflow` accepts `state` (`Enabled`/`Disabled`).
- `get_run_details` returns duration, run/trigger codes, trigger timing, `workflowVersion`, correlation and output names.
- `search_runs` returns `skipToken`, `hasMore` and `pagesScanned`; `clientTrackingId` searches resume reliably.

### Fixed
- HTTP/Functions hosts: bearer tokens are scoped per request (`AsyncLocalStorage`) instead of a shared global, and caches are partitioned per caller.
- Local mode caches the Azure CLI token until shortly before expiry instead of spawning `az` per request.
- Non-idempotent POSTs (run trigger, resubmit, clone, connector invoke) are no longer retried on 5xx/network errors (only on 429), preventing duplicate executions.
- Pagination `nextLink`s are only followed over HTTPS to the expected host, so the bearer token cannot leak to other hosts.
- `update_workflow` (Standard) preserves the existing `kind` and other `workflow.json` fields instead of resetting to `Stateful`.
- Docs: `get_reference` tool name corrected.

## [0.4.3] - 2026-01-11

### Changed
- Simplified README to focus on local MCP server setup
- Removed unused files: Azure Functions configs, test artifacts, M365 Copilot manifests
- Moved `design/` to `docs/design/`
- Moved `mcp.json` to `.vscode/mcp.json`

## [0.4.2] - 2026-01-11

### Added
- `mcpName` field for official MCP Registry publishing

## [0.4.1] - 2026-01-11

### Fixed
- Documentation: corrected install commands to use npm package name `logicapps-mcp`
- Documentation: updated tool count from 37 to 40 (36 operations + 4 knowledge tools)

## [0.4.0] - 2026-01-11

### Added
- `resubmit_run` tool for retrying failed workflow runs
- `clone_workflow` and `validate_clone_workflow` tools
- Runtime input validation with Zod

### Fixed
- Pagination now properly bounded across all operations (runs, actions, repetitions, request history)
- Improved caching: LRU eviction, stampede protection, proper TTL initialization
- Better error handling for JSON parsing, SKU detection, and null API responses
- Standard SKU: use POST for expression traces endpoint

### Changed
- Version now read from package.json dynamically

## [0.3.0] - 2026-01-02

### Added

- Write operations for workflow lifecycle management: `create_workflow`, `update_workflow`, `delete_workflow`, `enable_workflow`, `disable_workflow`
- Connector tools: `get_connector_swagger`, `invoke_connector_operation`, `create_connection`, `test_connection`
- Knowledge tools for AI guidance: `get_troubleshooting_guide`, `get_authoring_guide`, `get_reference`, `get_workflow_instructions`
- Retry logic with exponential backoff and jitter in HTTP client
- Integration tests for Azure API calls
- ESLint and Prettier configuration
- Parameter validation for `createConnection()`

### Changed

- Simplified cloud deployment to pure MCP server with passthrough authentication
- Migrated from deprecated `Server` class to `McpServer`
- Renamed internal Flowie references to LogicAppsMcp

### Fixed

- Add timeout (30s) and size limits (10MB) to `fetchContentLink()`
- Improve `armRequest` type safety for empty responses
- Fix `searchRuns()` pagination with `clientTrackingId` filter
- Add `UnsupportedOperation` to `McpErrorCode` type
- Apply `top` parameter limit to `getTriggerHistory` for Standard SKU
- Handle VFS 412/409 conflict errors with specific error code
- Improve `withConcurrency` robustness
- Handle both SKUs gracefully in workflow operations

### Performance

- Parallelize API calls in `getConnectorSwagger()`
- Cache SKU detection and Standard app access results with configurable TTL

## [0.2.0] - 2025-12-24

### Added

- 5 new tools for enhanced workflow debugging:
  - `get_action_repetitions` - Debug foreach/until loop iterations
  - `get_scope_repetitions` - Debug scope/switch/condition executions
  - `get_action_request_history` - View HTTP request/response history
  - `get_expression_traces` - Debug workflow expression evaluations
  - `get_workflow_swagger` - Get OpenAPI spec for workflow triggers

## [0.1.0] - 2025-12-23

### Added

- Initial release of Azure Logic Apps MCP Server
- Support for both Consumption and Standard Logic App SKUs
- Core tools:
  - `list_subscriptions` - Discover Azure subscriptions
  - `list_logic_apps` - List Logic Apps in subscription/resource group
  - `list_workflows` - List workflows in Standard Logic Apps
  - `get_workflow_definition` - Retrieve workflow JSON definition
  - `get_workflow_triggers` - Get trigger information
  - `list_run_history` - View workflow run history
  - `get_run_details` - Get run-level details and errors
  - `get_run_actions` - List all actions in a run
  - `get_action_io` - Get action inputs/outputs
  - `get_connections` - List API connections
  - `get_connection_details` - Get connection status and details
  - `search_runs` - Search runs by status, time, or tracking ID
  - `get_trigger_history` - View trigger execution history
  - `get_trigger_callback_url` - Get request trigger URLs
  - `run_trigger` - Manually invoke triggers
  - `cancel_run` - Cancel running workflow instances
  - `get_host_status` - Get Standard SKU runtime status
  - `list_workflow_versions` - List workflow versions (Consumption)
  - `get_workflow_version` - Get specific version definition
- Dual deployment modes: stdio (local) and HTTP (Azure Functions)
- Azure authentication via Azure CLI or service principal

[0.4.0]: https://github.com/laveeshb/logicapps-mcp/releases/tag/v0.4.0
[0.3.0]: https://github.com/laveeshb/logicapps-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/laveeshb/logicapps-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/laveeshb/logicapps-mcp/releases/tag/v0.1.0
