import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeRunFailures, extractRunTestData } from "./diagnostics.js";
import { REDACTED } from "../utils/redact.js";

vi.mock("../utils/http.js", () => ({
  armRequest: vi.fn(),
  workflowMgmtRequest: vi.fn(),
}));

vi.mock("./runs.js", () => ({
  resolveRunTarget: vi.fn(),
  fetchRunRaw: vi.fn(),
  fetchRunActionsRaw: vi.fn(),
  fetchContentLink: vi.fn(),
}));

import { armRequest } from "../utils/http.js";
import { resolveRunTarget, fetchRunRaw, fetchRunActionsRaw, fetchContentLink } from "./runs.js";

const target = {
  sku: "consumption" as const,
  subscriptionId: "sub",
  resourceGroupName: "rg",
  logicAppName: "app",
};

function action(name: string, status: string, extra: Record<string, unknown> = {}) {
  return { id: name, name, type: "Http", properties: { status, startTime: "2024-01-01T00:00:00Z", ...extra } };
}

describe("diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveRunTarget).mockResolvedValue(target);
  });

  describe("analyzeRunFailures", () => {
    it("groups failures by action/error and ranks root causes first", async () => {
      vi.mocked(armRequest).mockResolvedValue({
        value: [
          { name: "run1", properties: { status: "Failed", startTime: "2024-01-01T00:00:00Z" } },
          { name: "run2", properties: { status: "Failed", startTime: "2024-01-02T00:00:00Z" } },
          {
            name: "run3",
            properties: {
              status: "Failed",
              startTime: "2024-01-03T00:00:00Z",
              error: { code: "TriggerFailed", message: "bad trigger" },
            },
          },
        ],
        nextLink: "https://management.azure.com/next",
      });
      vi.mocked(fetchRunActionsRaw).mockImplementation(async (_t, runId) => {
        if (runId === "run3") return [];
        return [
          action("Call_API", "Failed", {
            startTime: runId === "run1" ? "2024-01-01T00:00:01Z" : "2024-01-02T00:00:01Z",
            error: { code: "BadGateway", message: "502 from backend" },
          }),
          action("Scope", "Failed", { error: { code: "ActionFailed", message: "child failed" } }),
          action("Compose", "Succeeded"),
        ] as never;
      });

      const result = await analyzeRunFailures("sub", "rg", "app", undefined, "2024-01-01T00:00:00Z", undefined, 10);

      expect(armRequest).toHaveBeenCalledWith(
        expect.stringContaining("/runs"),
        expect.objectContaining({
          queryParams: expect.objectContaining({
            $top: "10",
            $filter: "status eq 'Failed' and startTime ge 2024-01-01T00:00:00Z",
          }),
        })
      );
      expect(result.runsAnalyzed).toBe(3);
      expect(result.hasMoreFailedRuns).toBe(true);
      expect(result.failureGroups[0]).toMatchObject({
        actionName: "Call_API",
        errorCode: "BadGateway",
        isRootCause: true,
        count: 2,
        sampleRunIds: ["run1", "run2"],
        firstSeen: "2024-01-01T00:00:01Z",
        lastSeen: "2024-01-02T00:00:01Z",
      });
      expect(result.failureGroups[1]).toMatchObject({ actionName: "Scope", isRootCause: false });
      expect(result.runLevelErrors).toEqual([
        { errorCode: "TriggerFailed", count: 1, sampleMessage: "bad trigger", sampleRunIds: ["run3"] },
      ]);
      expect(result.runsWithoutFailedActions).toEqual(["run3"]);
      expect(result.nextSteps[0]).toContain("Call_API");
    });

    it("caps maxRuns at 50", async () => {
      vi.mocked(armRequest).mockResolvedValue({ value: [] });
      const result = await analyzeRunFailures("sub", "rg", "app", undefined, undefined, undefined, 500);
      expect(armRequest).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ queryParams: expect.objectContaining({ $top: "50" }) })
      );
      expect(result.runsAnalyzed).toBe(0);
      expect(result.nextSteps[0]).toContain("No failed runs");
    });
  });

  describe("extractRunTestData", () => {
    beforeEach(() => {
      vi.mocked(fetchRunRaw).mockResolvedValue({
        id: "run1",
        name: "run1",
        type: "runs",
        properties: {
          status: "Succeeded",
          startTime: "2024-01-01T00:00:00Z",
          endTime: "2024-01-01T00:00:05Z",
          workflow: { name: "08585" },
          correlation: { clientTrackingId: "ct-1" },
          trigger: {
            name: "manual",
            status: "Succeeded",
            inputsLink: { uri: "https://link/trigger-in" },
            outputsLink: { uri: "https://link/trigger-out" },
          },
        },
      });
      vi.mocked(fetchRunActionsRaw).mockResolvedValue([
        action("Get_Order", "Succeeded", {
          inputsLink: { uri: "https://link/get-in" },
          outputsLink: { uri: "https://link/get-out" },
        }),
        action("Send_Mail", "Failed", { error: { code: "Unauthorized", message: "nope" } }),
      ] as never);
      vi.mocked(fetchContentLink).mockImplementation(async (uri: string) => {
        switch (uri) {
          case "https://link/trigger-out":
            return { headers: { Authorization: "Bearer x" }, body: { orderId: 42 } };
          case "https://link/trigger-in":
            return { body: { orderId: 42 } };
          case "https://link/get-in":
            return { uri: "https://api/orders/42?code=SECRET", method: "GET" };
          case "https://link/get-out":
            return { statusCode: 200, body: { id: 42, items: ["a"] } };
        }
        throw new Error("unexpected");
      });
    });

    it("produces mock-shaped, redacted test data", async () => {
      const result = await extractRunTestData("sub", "rg", "app", "run1");

      expect(result.source).toMatchObject({ runId: "run1", runStatus: "Succeeded", workflowVersion: "08585", clientTrackingId: "ct-1" });
      expect(result.triggerMock).toEqual({
        name: "manual",
        status: "Succeeded",
        outputs: { headers: { Authorization: REDACTED }, body: { orderId: 42 } },
      });
      expect(result.actionMocks.Get_Order).toEqual({ status: "Succeeded", outputs: { statusCode: 200, body: { id: 42, items: ["a"] } } });
      expect(result.actionMocks.Send_Mail).toMatchObject({ status: "Failed", error: { code: "Unauthorized" } });
      expect(result.actionInputs?.Get_Order).toEqual({ uri: `https://api/orders/42?code=${REDACTED}`, method: "GET" });
      expect(result.expected).toEqual({ runStatus: "Succeeded", actionStatuses: { Get_Order: "Succeeded", Send_Mail: "Failed" } });
      expect(result.redaction).toEqual({ enabled: true, redactedValues: 2 });
    });

    it("filters actions, skips inputs and reports missing actions", async () => {
      const result = await extractRunTestData("sub", "rg", "app", "run1", {
        actionNames: ["Get_Order", "Missing"],
        includeInputs: false,
      });
      expect(Object.keys(result.actionMocks)).toEqual(["Get_Order"]);
      expect(result.actionInputs).toBeUndefined();
      expect(result.triggerInputs).toBeUndefined();
      expect(result.notes.join(" ")).toContain("Missing");
      expect(fetchContentLink).not.toHaveBeenCalledWith("https://link/get-in");
    });

    it("can disable redaction and truncates large payloads", async () => {
      vi.mocked(fetchContentLink).mockResolvedValue({ big: "x".repeat(5000), token: "t" });
      const result = await extractRunTestData("sub", "rg", "app", "run1", {
        redact: false,
        maxPayloadBytes: 1024,
      });
      expect(result.redaction.enabled).toBe(false);
      expect(result.triggerMock.outputs).toMatchObject({ _truncated: true });
      expect(result.truncatedPayloads).toContain("trigger.manual.outputs");
    });
  });
});
