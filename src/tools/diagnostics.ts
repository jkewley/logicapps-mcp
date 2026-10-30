/**
 * Read-only diagnostics and test-data extraction built on run history.
 *
 * - analyzeRunFailures: cluster failures across many runs to find the dominant root causes
 * - extractRunTestData: turn a historical run into mock/fixture data for workflow unit tests
 */

import { armRequest, workflowMgmtRequest } from "../utils/http.js";
import { RunAction, WorkflowRun } from "../types/logicApp.js";
import {
  mapWithConcurrency,
  redactValue,
  RedactionStats,
  truncatePayload,
} from "../utils/redact.js";
import {
  RunTarget,
  resolveRunTarget,
  fetchRunRaw,
  fetchRunActionsRaw,
  fetchContentLink,
} from "./runs.js";

const CONCURRENCY = 5;
const FAILED_ACTION_STATUSES = new Set(["Failed", "TimedOut"]);
// Error codes that only indicate a failure propagated from a child/predecessor action
const PROPAGATED_ERROR_CODES = new Set(["ActionFailed", "ActionSkipped", "ActionConditionFailed"]);

async function listRunsRaw(
  t: RunTarget,
  filter: string,
  top: number
): Promise<{ runs: WorkflowRun[]; hasMore: boolean }> {
  if (t.sku === "consumption") {
    const res = await armRequest<{ value?: WorkflowRun[]; nextLink?: string }>(
      `/subscriptions/${t.subscriptionId}/resourceGroups/${t.resourceGroupName}/providers/Microsoft.Logic/workflows/${t.logicAppName}/runs`,
      { queryParams: { "api-version": "2019-05-01", $top: String(top), $filter: filter } }
    );
    return { runs: res.value ?? [], hasMore: Boolean(res.nextLink) };
  }
  const qs = new URLSearchParams({
    "api-version": "2020-05-01-preview",
    $top: String(top),
    $filter: filter,
  });
  const res = await workflowMgmtRequest<{ value?: WorkflowRun[]; nextLink?: string }>(
    t.hostname!,
    `/runtime/webhooks/workflow/api/management/workflows/${t.workflowName}/runs?${qs.toString()}`,
    t.masterKey!
  );
  return { runs: res.value ?? [], hasMore: Boolean(res.nextLink) };
}

function truncateText(text: string | undefined, max = 500): string | undefined {
  if (!text) return text;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ============================================================================
// analyze_run_failures
// ============================================================================

export interface FailureGroup {
  actionName: string;
  actionType?: string;
  errorCode: string;
  /** True when this failure is the origin (not just propagated from a child action). */
  isRootCause: boolean;
  count: number;
  sampleMessage?: string;
  sampleRunIds: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface AnalyzeRunFailuresResult {
  window: { startTime?: string; endTime?: string };
  runsAnalyzed: number;
  /** More failed runs exist in the window than were analyzed. */
  hasMoreFailedRuns: boolean;
  failureGroups: FailureGroup[];
  runLevelErrors: Array<{
    errorCode: string;
    count: number;
    sampleMessage?: string;
    sampleRunIds: string[];
  }>;
  runsWithoutFailedActions: string[];
  nextSteps: string[];
}

export async function analyzeRunFailures(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  workflowName?: string,
  startTime?: string,
  endTime?: string,
  maxRuns: number = 25
): Promise<AnalyzeRunFailuresResult> {
  const top = Math.max(1, Math.min(maxRuns, 50));
  const target = await resolveRunTarget(subscriptionId, resourceGroupName, logicAppName, workflowName);

  const filterParts = ["status eq 'Failed'"];
  if (startTime) filterParts.push(`startTime ge ${startTime}`);
  if (endTime) filterParts.push(`startTime le ${endTime}`);

  const { runs, hasMore } = await listRunsRaw(target, filterParts.join(" and "), top);

  const groups = new Map<string, FailureGroup>();
  const runErrors = new Map<
    string,
    { errorCode: string; count: number; sampleMessage?: string; sampleRunIds: string[] }
  >();
  const runsWithoutFailedActions: string[] = [];

  const perRunActions = await mapWithConcurrency(runs, CONCURRENCY, (run) =>
    fetchRunActionsRaw(target, run.name).catch(() => [] as RunAction[])
  );

  runs.forEach((run, idx) => {
    const runStart = run.properties.startTime;

    const runErr = run.properties.error;
    if (runErr?.code) {
      const entry = runErrors.get(runErr.code) ?? {
        errorCode: runErr.code,
        count: 0,
        sampleMessage: truncateText(runErr.message),
        sampleRunIds: [],
      };
      entry.count++;
      if (entry.sampleRunIds.length < 5) entry.sampleRunIds.push(run.name);
      runErrors.set(runErr.code, entry);
    }

    const failed = perRunActions[idx].filter((a) => FAILED_ACTION_STATUSES.has(a.properties.status));
    if (failed.length === 0) {
      runsWithoutFailedActions.push(run.name);
      return;
    }

    for (const action of failed) {
      const errorCode = action.properties.error?.code ?? action.properties.code ?? action.properties.status;
      const key = `${action.name}\u0000${errorCode}`;
      const seen = action.properties.startTime ?? runStart;
      const group = groups.get(key) ?? {
        actionName: action.name,
        actionType: action.type,
        errorCode,
        isRootCause: !PROPAGATED_ERROR_CODES.has(errorCode),
        count: 0,
        sampleMessage: truncateText(action.properties.error?.message),
        sampleRunIds: [],
        firstSeen: seen,
        lastSeen: seen,
      };
      group.count++;
      if (group.sampleRunIds.length < 5 && !group.sampleRunIds.includes(run.name)) {
        group.sampleRunIds.push(run.name);
      }
      if (seen < group.firstSeen) group.firstSeen = seen;
      if (seen > group.lastSeen) group.lastSeen = seen;
      groups.set(key, group);
    }
  });

  const failureGroups = [...groups.values()].sort(
    (a, b) => Number(b.isRootCause) - Number(a.isRootCause) || b.count - a.count
  );

  const nextSteps: string[] = [];
  const top1 = failureGroups.find((g) => g.isRootCause);
  if (top1) {
    nextSteps.push(
      `Inspect the dominant root cause with get_action_io (runId '${top1.sampleRunIds[0]}', actionName '${top1.actionName}').`
    );
    nextSteps.push(
      "Use get_action_request_history for HTTP/connector actions and get_action_repetitions for failures inside loops."
    );
    nextSteps.push(
      "Use extract_run_test_data on a sample run to capture a reproducible fixture before changing the workflow."
    );
  } else if (runs.length === 0) {
    nextSteps.push("No failed runs found in the window. Widen startTime/endTime or check get_trigger_history.");
  } else {
    nextSteps.push(
      "Failures were not attributed to actions; check run-level errors and get_trigger_history."
    );
  }

  return {
    window: { startTime, endTime },
    runsAnalyzed: runs.length,
    hasMoreFailedRuns: hasMore,
    failureGroups,
    runLevelErrors: [...runErrors.values()].sort((a, b) => b.count - a.count),
    runsWithoutFailedActions,
    nextSteps,
  };
}

// ============================================================================
// extract_run_test_data
// ============================================================================

export interface MockData {
  status: string;
  outputs?: unknown;
  error?: { code: string; message: string };
}

export interface ExtractRunTestDataResult {
  source: {
    logicAppName: string;
    workflowName?: string;
    runId: string;
    runStatus: string;
    startTime: string;
    endTime?: string;
    workflowVersion?: string;
    clientTrackingId?: string;
  };
  /** Shape matches the Logic Apps Automated Test SDK TriggerMock(status, name, outputs). */
  triggerMock: MockData & { name: string };
  triggerInputs?: unknown;
  /** Keyed by action name. Shape matches ActionMock(status, name, outputs). */
  actionMocks: Record<string, MockData>;
  /** Recorded action inputs, useful as assertions on what each action received. */
  actionInputs?: Record<string, unknown>;
  /** Expected statuses for asserting test results. */
  expected: {
    runStatus: string;
    actionStatuses: Record<string, string>;
  };
  redaction: { enabled: boolean; redactedValues: number };
  truncatedPayloads: string[];
  notes: string[];
}

export async function extractRunTestData(
  subscriptionId: string,
  resourceGroupName: string,
  logicAppName: string,
  runId: string,
  options: {
    workflowName?: string;
    actionNames?: string[];
    includeInputs?: boolean;
    redact?: boolean;
    maxPayloadBytes?: number;
  } = {}
): Promise<ExtractRunTestDataResult> {
  const includeInputs = options.includeInputs ?? true;
  const redact = options.redact ?? true;
  const maxPayloadBytes = Math.max(1024, Math.min(options.maxPayloadBytes ?? 32768, 1024 * 1024));

  const target = await resolveRunTarget(
    subscriptionId,
    resourceGroupName,
    logicAppName,
    options.workflowName
  );
  const [run, allActions] = await Promise.all([
    fetchRunRaw(target, runId),
    fetchRunActionsRaw(target, runId),
  ]);

  const notes: string[] = [];
  const truncatedPayloads: string[] = [];
  const stats: RedactionStats = { redactedCount: 0 };

  let actions = allActions;
  if (options.actionNames && options.actionNames.length > 0) {
    const wanted = new Set(options.actionNames);
    actions = allActions.filter((a) => wanted.has(a.name));
    const missing = options.actionNames.filter((n) => !allActions.some((a) => a.name === n));
    if (missing.length > 0) {
      notes.push(`Actions not found in run: ${missing.join(", ")}`);
    }
  }

  const prepare = (value: unknown, path: string): unknown => {
    if (value === undefined) return undefined;
    const clean = redact ? redactValue(value, stats) : value;
    const { value: out, truncated } = truncatePayload(clean, maxPayloadBytes);
    if (truncated) truncatedPayloads.push(path);
    return out;
  };

  const fetchLink = async (uri: string | undefined, path: string): Promise<unknown> => {
    if (!uri) return undefined;
    try {
      return prepare(await fetchContentLink(uri), path);
    } catch (error) {
      notes.push(
        `Could not fetch ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  };

  // Trigger
  const trigger = run.properties.trigger;
  const triggerName = trigger?.name ?? "unknown";
  const [triggerOutputs, triggerInputs] = await Promise.all([
    fetchLink(trigger?.outputsLink?.uri, `trigger.${triggerName}.outputs`),
    includeInputs ? fetchLink(trigger?.inputsLink?.uri, `trigger.${triggerName}.inputs`) : undefined,
  ]);

  // Actions
  const actionMocks: Record<string, MockData> = {};
  const actionInputs: Record<string, unknown> = {};
  const actionStatuses: Record<string, string> = {};

  await mapWithConcurrency(actions, CONCURRENCY, async (action) => {
    const p = action.properties;
    actionStatuses[action.name] = p.status;

    const [outputs, inputs] = await Promise.all([
      fetchLink(p.outputsLink?.uri, `actions.${action.name}.outputs`),
      includeInputs ? fetchLink(p.inputsLink?.uri, `actions.${action.name}.inputs`) : undefined,
    ]);

    actionMocks[action.name] = {
      status: p.status,
      ...(outputs !== undefined ? { outputs } : {}),
      ...(p.error ? { error: redact ? redactValue(p.error, stats) : p.error } : {}),
    };
    if (inputs !== undefined) actionInputs[action.name] = inputs;

    if ((p.repetitionCount ?? p.iterationCount ?? 0) > 0 && !p.outputsLink) {
      notes.push(
        `'${action.name}' ran inside a loop; use get_action_io with repetitionName (see get_action_repetitions) for per-iteration data.`
      );
    }
  });

  if (run.properties.status === "Running" || run.properties.status === "Waiting") {
    notes.push("Run has not completed; captured data may be incomplete.");
  }
  if (redact) {
    notes.push(
      "Sensitive values (auth headers, keys, tokens, passwords, SAS signatures) were redacted. Review fixtures before committing."
    );
  }

  // Sort actions for stable output
  const sortObj = <T>(o: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

  return {
    source: {
      logicAppName,
      workflowName: options.workflowName,
      runId: run.name ?? runId,
      runStatus: run.properties.status,
      startTime: run.properties.startTime,
      endTime: run.properties.endTime,
      workflowVersion: run.properties.workflow?.name,
      clientTrackingId:
        run.properties.correlation?.clientTrackingId ?? trigger?.correlation?.clientTrackingId,
    },
    triggerMock: {
      name: triggerName,
      status: trigger?.status ?? "Succeeded",
      ...(triggerOutputs !== undefined ? { outputs: triggerOutputs } : {}),
    },
    ...(triggerInputs !== undefined ? { triggerInputs } : {}),
    actionMocks: sortObj(actionMocks),
    ...(includeInputs ? { actionInputs: sortObj(actionInputs) } : {}),
    expected: {
      runStatus: run.properties.status,
      actionStatuses: sortObj(actionStatuses),
    },
    redaction: { enabled: redact, redactedValues: stats.redactedCount },
    truncatedPayloads,
    notes,
  };
}
