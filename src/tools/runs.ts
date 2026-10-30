/**
 * Workflow run history operations for both SKUs.
 */

import {
  armRequest,
  armRequestAllPages,
  armRequestVoid,
  workflowMgmtRequest,
  workflowMgmtRequestAllPages,
} from "../utils/http.js";
import { WorkflowRun, RunAction, ConsumptionLogicApp } from "../types/logicApp.js";
import { McpError } from "../utils/errors.js";
import {
  detectLogicAppSku,
  getStandardAppAccess,
  getConsumptionRunPortalUrl,
  getStandardRunPortalUrl,
} from "./shared.js";

export interface ListRunHistoryResult {
  runs: Array<{
    id: string;
    name: string;
    status: string;
    startTime: string;
    endTime?: string;
    trigger: {
      name: string;
    };
    correlation?: {
      clientTrackingId: string;
    };
    portalUrl?: string;
  }>;
  nextLink?: string;
}

export interface GetRunDetailsResult {
  run: {
    id: string;
    name: string;
    status: string;
    startTime: string;
    endTime?: string;
    durationMs?: number;
    code?: string;
    trigger: {
      name: string;
      status?: string;
      code?: string;
      startTime?: string;
      endTime?: string;
      scheduledTime?: string;
      hasInputs: boolean;
      hasOutputs: boolean;
      trackedProperties?: Record<string, unknown>;
    };
    /** Workflow version that executed this run (Consumption: version id). */
    workflowVersion?: string;
    correlation?: {
      clientTrackingId?: string;
    };
    /** Names of workflow-level outputs produced by the run (values via get_action_io / extract_run_test_data). */
    outputNames?: string[];
    error?: {
      code: string;
      message: string;
    };
    portalUrl?: string;
  };
}

// ============================================================================
// Shared run access helpers (used by diagnostics and test-data tools)
// ============================================================================

export interface RunTarget {
  sku: "consumption" | "standard";
  subscriptionId: string;
  resourceGroupName: string;
  logicAppName: string;
  workflowName?: string;
  hostname?: string;
  masterKey?: string;
}

/**
 * Resolve SKU and (for Standard) management API access for run operations.
 */
export async function resolveRunTarget(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  workflowName?: string
): Promise<RunTarget> {
  const sku = await detectLogicAppSku(subscriptionId, resourceGroupName, logicAppName);
  if (sku === "consumption") {
    return { sku, subscriptionId, resourceGroupName, logicAppName };
  }
  if (!workflowName) {
    throw new McpError("InvalidParameter", "workflowName is required for Standard Logic Apps");
  }
  const { hostname, masterKey } = await getStandardAppAccess(
    subscriptionId,
    resourceGroupName,
    logicAppName
  );
  return { sku, subscriptionId, resourceGroupName, logicAppName, workflowName, hostname, masterKey };
}

function consumptionWorkflowPath(t: RunTarget): string {
  return `/subscriptions/${t.subscriptionId}/resourceGroups/${t.resourceGroupName}/providers/Microsoft.Logic/workflows/${t.logicAppName}`;
}

function standardWorkflowPath(t: RunTarget): string {
  return `/runtime/webhooks/workflow/api/management/workflows/${t.workflowName}`;
}

const STANDARD_API = "api-version=2020-05-01-preview";

export async function fetchRunRaw(t: RunTarget, runId: string): Promise<WorkflowRun> {
  if (t.sku === "consumption") {
    return armRequest<WorkflowRun>(`${consumptionWorkflowPath(t)}/runs/${runId}`, {
      queryParams: { "api-version": "2019-05-01" },
    });
  }
  return workflowMgmtRequest<WorkflowRun>(
    t.hostname!,
    `${standardWorkflowPath(t)}/runs/${runId}?${STANDARD_API}`,
    t.masterKey!
  );
}

export async function fetchRunActionsRaw(t: RunTarget, runId: string): Promise<RunAction[]> {
  if (t.sku === "consumption") {
    return armRequestAllPages<RunAction>(`${consumptionWorkflowPath(t)}/runs/${runId}/actions`, {
      "api-version": "2019-05-01",
    });
  }
  return workflowMgmtRequestAllPages<RunAction>(
    t.hostname!,
    `${standardWorkflowPath(t)}/runs/${runId}/actions?${STANDARD_API}`,
    t.masterKey!
  );
}

/**
 * Fetch a run action, or a specific repetition (loop iteration) of it.
 */
export async function fetchActionRaw(
  t: RunTarget,
  runId: string,
  actionName: string,
  repetitionName?: string
): Promise<RunAction> {
  const suffix = `/runs/${runId}/actions/${actionName}${repetitionName ? `/repetitions/${repetitionName}` : ""}`;
  if (t.sku === "consumption") {
    return armRequest<RunAction>(`${consumptionWorkflowPath(t)}${suffix}`, {
      queryParams: { "api-version": "2019-05-01" },
    });
  }
  return workflowMgmtRequest<RunAction>(
    t.hostname!,
    `${standardWorkflowPath(t)}${suffix}?${STANDARD_API}`,
    t.masterKey!
  );
}

function durationMs(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? ms : undefined;
}

function toRunDetails(run: WorkflowRun, portalUrl: string): GetRunDetailsResult["run"] {
  const p = run.properties;
  return {
    id: run.id,
    name: run.name,
    status: p.status,
    startTime: p.startTime,
    endTime: p.endTime,
    durationMs: durationMs(p.startTime, p.endTime),
    code: p.code,
    trigger: {
      name: p.trigger?.name ?? "unknown",
      status: p.trigger?.status,
      code: p.trigger?.code,
      startTime: p.trigger?.startTime,
      endTime: p.trigger?.endTime,
      scheduledTime: p.trigger?.scheduledTime,
      hasInputs: Boolean(p.trigger?.inputsLink?.uri),
      hasOutputs: Boolean(p.trigger?.outputsLink?.uri),
      trackedProperties: p.trigger?.trackedProperties,
    },
    workflowVersion: p.workflow?.name,
    correlation: p.correlation ?? p.trigger?.correlation,
    outputNames: p.outputs ? Object.keys(p.outputs) : undefined,
    error: p.error,
    portalUrl,
  };
}

export interface GetRunActionsResult {
  actions: Array<{
    name: string;
    type: string;
    status: string;
    startTime: string;
    endTime?: string;
    error?: {
      code: string;
      message: string;
    };
    trackedProperties?: Record<string, unknown>;
  }>;
}

export async function listRunHistory(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  workflowName?: string,
  top: number = 25,
  filter?: string,
  skipToken?: string
): Promise<ListRunHistoryResult> {
  const sku = await detectLogicAppSku(subscriptionId, resourceGroupName, logicAppName);
  const effectiveTop = Math.min(top, 100);

  if (sku === "consumption") {
    // Get Logic App to retrieve location for portal URLs
    const logicApp = await armRequest<ConsumptionLogicApp>(
      `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Logic/workflows/${logicAppName}`,
      { queryParams: { "api-version": "2019-05-01" } }
    );
    const location = logicApp.location.toLowerCase().replace(/\s/g, "");

    const queryParams: Record<string, string> = {
      "api-version": "2019-05-01",
      $top: effectiveTop.toString(),
    };
    if (filter) queryParams["$filter"] = filter;
    if (skipToken) queryParams["$skiptoken"] = skipToken;

    const response = await armRequest<{ value: WorkflowRun[]; nextLink?: string }>(
      `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Logic/workflows/${logicAppName}/runs`,
      { queryParams }
    );

    const runs = response.value ?? [];

    return {
      runs: runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.properties.status,
        startTime: run.properties.startTime,
        endTime: run.properties.endTime,
        trigger: { name: run.properties.trigger?.name ?? "unknown" },
        correlation: run.properties.correlation,
        portalUrl: getConsumptionRunPortalUrl(
          subscriptionId,
          resourceGroupName,
          logicAppName,
          run.name,
          location
        ),
      })),
      nextLink: response.nextLink,
    };
  }

  // Standard - use Workflow Management API
  if (!workflowName) {
    throw new McpError("InvalidParameter", "workflowName is required for Standard Logic Apps");
  }

  const { hostname, masterKey } = await getStandardAppAccess(
    subscriptionId,
    resourceGroupName,
    logicAppName
  );

  let path = `/runtime/webhooks/workflow/api/management/workflows/${workflowName}/runs?api-version=2020-05-01-preview&$top=${effectiveTop}`;
  if (filter) path += `&$filter=${encodeURIComponent(filter)}`;
  if (skipToken) path += `&$skiptoken=${encodeURIComponent(skipToken)}`;

  const response = await workflowMgmtRequest<{ value?: WorkflowRun[]; nextLink?: string }>(
    hostname,
    path,
    masterKey
  );

  const runsList = response.value ?? [];

  return {
    runs: runsList.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.properties.status,
      startTime: run.properties.startTime,
      endTime: run.properties.endTime,
      trigger: { name: run.properties.trigger?.name ?? "unknown" },
      correlation: run.properties.correlation,
      portalUrl: getStandardRunPortalUrl(
        subscriptionId,
        resourceGroupName,
        logicAppName,
        workflowName,
        run.name
      ),
    })),
    nextLink: response.nextLink,
  };
}

export async function getRunDetails(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  runId: string,
  workflowName?: string
): Promise<GetRunDetailsResult> {
  const sku = await detectLogicAppSku(subscriptionId, resourceGroupName, logicAppName);

  if (sku === "consumption") {
    // Fetch Logic App details to get location
    const logicApp = await armRequest<ConsumptionLogicApp>(
      `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Logic/workflows/${logicAppName}`,
      { queryParams: { "api-version": "2019-05-01" } }
    );
    const run = await fetchRunRaw(
      { sku, subscriptionId, resourceGroupName, logicAppName },
      runId
    );

    return {
      run: toRunDetails(
        run,
        getConsumptionRunPortalUrl(
          subscriptionId,
          resourceGroupName,
          logicAppName,
          run.name,
          logicApp.location
        )
      ),
    };
  }

  const target = await resolveRunTarget(subscriptionId, resourceGroupName, logicAppName, workflowName);
  const run = await fetchRunRaw(target, runId);

  return {
    run: toRunDetails(
      run,
      getStandardRunPortalUrl(subscriptionId, resourceGroupName, logicAppName, workflowName!, run.name)
    ),
  };
}

export async function getRunActions(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  runId: string,
  workflowName?: string,
  actionName?: string
): Promise<GetRunActionsResult> {
  const sku = await detectLogicAppSku(subscriptionId, resourceGroupName, logicAppName);

  if (sku === "consumption") {
    return getRunActionsConsumption(
      subscriptionId,
      resourceGroupName,
      logicAppName,
      runId,
      actionName
    );
  }

  // Standard
  if (!workflowName) {
    throw new McpError("InvalidParameter", "workflowName is required for Standard Logic Apps");
  }

  return getRunActionsStandard(
    subscriptionId,
    resourceGroupName,
    logicAppName,
    workflowName,
    runId,
    actionName
  );
}

async function getRunActionsConsumption(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  runId: string,
  actionName?: string
): Promise<GetRunActionsResult> {
  const basePath = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Logic/workflows/${logicAppName}/runs/${runId}/actions`;

  if (actionName) {
    const action = await armRequest<RunAction>(`${basePath}/${actionName}`, {
      queryParams: { "api-version": "2019-05-01" },
    });

    return {
      actions: [
        {
          name: action.name,
          type: action.type,
          status: action.properties.status,
          startTime: action.properties.startTime,
          endTime: action.properties.endTime,
          error: action.properties.error,
          trackedProperties: action.properties.trackedProperties,
        },
      ],
    };
  }

  const actions = await armRequestAllPages<RunAction>(basePath, { "api-version": "2019-05-01" });

  return {
    actions: actions.map((action) => ({
      name: action.name,
      type: action.type,
      status: action.properties.status,
      startTime: action.properties.startTime,
      endTime: action.properties.endTime,
      error: action.properties.error,
      trackedProperties: action.properties.trackedProperties,
    })),
  };
}

async function getRunActionsStandard(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  workflowName: string,
  runId: string,
  actionName?: string
): Promise<GetRunActionsResult> {
  const { hostname, masterKey } = await getStandardAppAccess(
    subscriptionId,
    resourceGroupName,
    logicAppName
  );
  const basePath = `/runtime/webhooks/workflow/api/management/workflows/${workflowName}/runs/${runId}/actions`;

  if (actionName) {
    const action = await workflowMgmtRequest<RunAction>(
      hostname,
      `${basePath}/${actionName}?api-version=2020-05-01-preview`,
      masterKey
    );

    return {
      actions: [
        {
          name: action.name,
          type: action.type,
          status: action.properties.status,
          startTime: action.properties.startTime,
          endTime: action.properties.endTime,
          error: action.properties.error,
          trackedProperties: action.properties.trackedProperties,
        },
      ],
    };
  }

  const actionsList = await workflowMgmtRequestAllPages<RunAction>(
    hostname,
    `${basePath}?api-version=2020-05-01-preview`,
    masterKey
  );

  return {
    actions: actionsList.map((action) => ({
      name: action.name,
      type: action.type,
      status: action.properties.status,
      startTime: action.properties.startTime,
      endTime: action.properties.endTime,
      error: action.properties.error,
      trackedProperties: action.properties.trackedProperties,
    })),
  };
}

export interface GetActionIOResult {
  actionName: string;
  repetitionName?: string;
  status?: string;
  inputs?: unknown;
  outputs?: unknown;
}

/**
 * Get the actual input/output content for a run action (or one loop iteration of it).
 * Follows the inputsLink/outputsLink URLs to fetch the content.
 */
export async function getActionIO(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  runId: string,
  actionName: string,
  workflowName?: string,
  type: "inputs" | "outputs" | "both" = "both",
  repetitionName?: string
): Promise<GetActionIOResult> {
  const target = await resolveRunTarget(subscriptionId, resourceGroupName, logicAppName, workflowName);
  const action = await fetchActionRaw(target, runId, actionName, repetitionName);

  const result: GetActionIOResult = {
    actionName,
    ...(repetitionName ? { repetitionName } : {}),
    status: action.properties.status,
  };

  if ((type === "inputs" || type === "both") && action.properties.inputsLink?.uri) {
    result.inputs = await fetchContentLink(action.properties.inputsLink.uri);
  }

  if ((type === "outputs" || type === "both") && action.properties.outputsLink?.uri) {
    result.outputs = await fetchContentLink(action.properties.outputsLink.uri);
  }

  return result;
}

/**
 * Fetch content from an inputsLink/outputsLink URL.
 * These URLs include SAS tokens so no additional auth is needed.
 */
export async function fetchContentLink(url: string): Promise<unknown> {
  const TIMEOUT_MS = 30000; // 30 second timeout
  const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB limit

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new McpError(
        "ServiceError",
        `Failed to fetch content link: ${response.status} ${response.statusText}`
      );
    }

    // Check content length before reading body
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_SIZE_BYTES) {
      throw new McpError(
        "ServiceError",
        `Content too large (${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB). Maximum size is 10MB.`
      );
    }

    const text = await response.text();

    // Check actual size (content-length may be missing)
    if (text.length > MAX_SIZE_BYTES) {
      throw new McpError(
        "ServiceError",
        `Content too large (${Math.round(text.length / 1024 / 1024)}MB). Maximum size is 10MB.`
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      // Return raw text if not valid JSON
      return text;
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new McpError("ServiceError", `Request timed out after ${TIMEOUT_MS / 1000} seconds`);
    }
    throw new McpError("ServiceError", `Failed to fetch content: ${error}`);
  } finally {
    clearTimeout(timeout);
  }
}

export interface SearchRunsResult {
  runs: Array<{
    id: string;
    name: string;
    status: string;
    startTime: string;
    endTime?: string;
    trigger: {
      name: string;
    };
    correlation?: {
      clientTrackingId: string;
    };
  }>;
  count: number;
  nextLink?: string;
  /** Pass as skipToken to continue a search (including clientTrackingId searches). */
  skipToken?: string;
  /** Number of run-history pages scanned (clientTrackingId searches only). */
  pagesScanned?: number;
  /** True when more history exists beyond what was scanned. */
  hasMore?: boolean;
}

function extractSkipToken(nextLink: string | undefined): string | undefined {
  if (!nextLink) return undefined;
  try {
    return new URL(nextLink).searchParams.get("$skiptoken") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Search runs with friendly parameters instead of raw OData filter syntax.
 * Uses server-side filtering for performance.
 */
export async function searchRuns(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  workflowName?: string,
  status?: "Succeeded" | "Failed" | "Cancelled" | "Running",
  startTime?: string,
  endTime?: string,
  clientTrackingId?: string,
  top: number = 25,
  skipToken?: string
): Promise<SearchRunsResult> {
  // Build OData filter from friendly parameters
  const filterParts: string[] = [];

  if (status) {
    filterParts.push(`status eq '${status}'`);
  }
  if (startTime) {
    filterParts.push(`startTime ge ${startTime}`);
  }
  if (endTime) {
    filterParts.push(`startTime le ${endTime}`);
  }

  const filter = filterParts.length > 0 ? filterParts.join(" and ") : undefined;

  // If clientTrackingId is provided, we need to handle pagination specially
  // because the API doesn't support filtering by clientTrackingId server-side
  if (clientTrackingId) {
    // Scan whole pages until we have enough matches, run out of pages, or hit the
    // scan limit. Whole pages are consumed so the returned skipToken resumes exactly.
    const matchingRuns: SearchRunsResult["runs"] = [];
    let currentSkipToken = skipToken;
    const maxPages = 10; // Safety limit per call; callers continue with skipToken
    let pagesScanned = 0;

    while (matchingRuns.length < top && pagesScanned < maxPages) {
      pagesScanned++;

      const pageResult = await listRunHistory(
        subscriptionId,
        resourceGroupName,
        logicAppName,
        workflowName,
        100, // Fetch max page size for efficiency
        filter,
        currentSkipToken
      );

      matchingRuns.push(
        ...pageResult.runs.filter((run) => run.correlation?.clientTrackingId === clientTrackingId)
      );

      currentSkipToken = extractSkipToken(pageResult.nextLink);
      if (!currentSkipToken) {
        break;
      }
    }

    return {
      runs: matchingRuns,
      count: matchingRuns.length,
      skipToken: currentSkipToken,
      pagesScanned,
      hasMore: currentSkipToken !== undefined,
    };
  }

  // Standard case: use server-side filtering only
  const result = await listRunHistory(
    subscriptionId,
    resourceGroupName,
    logicAppName,
    workflowName,
    top,
    filter,
    skipToken
  );

  const nextSkipToken = extractSkipToken(result.nextLink);
  return {
    runs: result.runs,
    count: result.runs.length,
    nextLink: result.nextLink,
    skipToken: nextSkipToken,
    hasMore: nextSkipToken !== undefined,
  };
}

// ============================================================================
// Write Operations
// ============================================================================

export interface CancelRunResult {
  success: boolean;
  runId: string;
  message: string;
}

/**
 * Cancel a running workflow run.
 * Only runs with status 'Running' or 'Waiting' can be cancelled.
 */
export async function cancelRun(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  runId: string,
  workflowName?: string
): Promise<CancelRunResult> {
  const sku = await detectLogicAppSku(subscriptionId, resourceGroupName, logicAppName);

  if (sku === "consumption") {
    await armRequestVoid(
      `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Logic/workflows/${logicAppName}/runs/${runId}/cancel`,
      { method: "POST", queryParams: { "api-version": "2019-05-01" }, idempotent: true }
    );

    return {
      success: true,
      runId,
      message: `Run '${runId}' has been cancelled for Consumption workflow '${logicAppName}'.`,
    };
  }

  // Standard requires workflowName
  if (!workflowName) {
    throw new McpError("InvalidParameter", "workflowName is required for Standard Logic Apps");
  }

  // For Standard, use the ARM API with hostruntime path
  await armRequestVoid(
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Web/sites/${logicAppName}/hostruntime/runtime/webhooks/workflow/api/management/workflows/${workflowName}/runs/${runId}/cancel`,
    { method: "POST", queryParams: { "api-version": "2022-03-01" }, idempotent: true }
  );

  return {
    success: true,
    runId,
    message: `Run '${runId}' has been cancelled for Standard workflow '${workflowName}' in '${logicAppName}'.`,
  };
}

export interface ResubmitRunResult {
  success: boolean;
  originalRunId: string;
  message: string;
}

/**
 * Resubmit a failed or cancelled workflow run to retry execution with the original inputs.
 * Only runs with status 'Failed', 'Cancelled', or 'Succeeded' can be resubmitted.
 */
export async function resubmitRun(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  runId: string,
  workflowName?: string
): Promise<ResubmitRunResult> {
  const sku = await detectLogicAppSku(subscriptionId, resourceGroupName, logicAppName);

  if (sku === "consumption") {
    await armRequestVoid(
      `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Logic/workflows/${logicAppName}/runs/${runId}/resubmit`,
      { method: "POST", queryParams: { "api-version": "2019-05-01" } }
    );

    return {
      success: true,
      originalRunId: runId,
      message: `Run '${runId}' has been resubmitted for Consumption workflow '${logicAppName}'. A new run has been created.`,
    };
  }

  // Standard requires workflowName
  if (!workflowName) {
    throw new McpError("InvalidParameter", "workflowName is required for Standard Logic Apps");
  }

  // For Standard, use the ARM API with hostruntime path
  await armRequestVoid(
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Web/sites/${logicAppName}/hostruntime/runtime/webhooks/workflow/api/management/workflows/${workflowName}/runs/${runId}/resubmit`,
    { method: "POST", queryParams: { "api-version": "2022-03-01" } }
  );

  return {
    success: true,
    originalRunId: runId,
    message: `Run '${runId}' has been resubmitted for Standard workflow '${workflowName}' in '${logicAppName}'. A new run has been created.`,
  };
}
