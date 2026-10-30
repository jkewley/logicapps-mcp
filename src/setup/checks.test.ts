import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../auth/index.js", () => ({
  getAccessToken: vi.fn(),
  getAzureCliAccount: vi.fn(),
  getAzureCliVersion: vi.fn(),
  getSettings: vi.fn(),
  isAzureCliAuthEnabled: vi.fn(),
}));

vi.mock("../tools/subscriptions.js", () => ({
  listSubscriptions: vi.fn(),
}));

import {
  getAccessToken,
  getAzureCliAccount,
  getAzureCliVersion,
  getSettings,
  isAzureCliAuthEnabled,
} from "../auth/index.js";
import { listSubscriptions } from "../tools/subscriptions.js";
import { setEnabledCapabilities } from "../tools/capabilities.js";
import { McpError } from "../utils/errors.js";
import { runSetupChecks, formatSetupReport } from "./checks.js";
import { AZURE_CLOUDS } from "../config/clouds.js";
import type { LogicAppsMcpSettings } from "../config/settings.js";

function settings(overrides: Partial<LogicAppsMcpSettings> = {}): LogicAppsMcpSettings {
  return {
    tenantId: "common",
    clientId: "c",
    cloud: AZURE_CLOUDS.AzurePublic,
    logLevel: "info",
    cacheTtlSeconds: 300,
    capabilities: ["read"],
    capabilitySource: "default",
    configFilePath: "/home/u/.logicapps-mcp/config.json",
    warnings: [],
    ...overrides,
  };
}

const account = {
  user: "dev@contoso.com",
  tenantId: "t1",
  subscriptionId: "s1",
  subscriptionName: "Dev",
  environmentName: "AzureCloud",
};

function status(report: Awaited<ReturnType<typeof runSetupChecks>>) {
  return Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
}

describe("runSetupChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnabledCapabilities([]);
    vi.mocked(getSettings).mockReturnValue(settings());
    vi.mocked(isAzureCliAuthEnabled).mockReturnValue(true);
    vi.mocked(getAzureCliVersion).mockResolvedValue("2.67.0");
    vi.mocked(getAzureCliAccount).mockResolvedValue(account);
    vi.mocked(getAccessToken).mockResolvedValue("tok");
    vi.mocked(listSubscriptions).mockResolvedValue({
      subscriptions: [{ subscriptionId: "s1", displayName: "Dev", state: "Enabled" }],
    });
  });

  it("passes when everything is configured", async () => {
    const report = await runSetupChecks();
    expect(report.ok).toBe(true);
    expect(report.authMode).toBe("azure-cli");
    expect(Object.values(status(report)).every((s) => s === "pass")).toBe(true);
    expect(report.summary).toBe("Setup OK.");
    expect(report.checks.find((c) => c.id === "capabilities")?.message).toMatch(/Read-only/);
  });

  it("fails and skips dependents when Azure CLI is missing", async () => {
    vi.mocked(getAzureCliVersion).mockRejectedValue(
      new McpError("AuthenticationError", "Azure CLI is not installed or not on PATH.")
    );
    const report = await runSetupChecks();
    expect(report.ok).toBe(false);
    expect(status(report)).toMatchObject({
      "azure-cli-installed": "fail",
      "azure-cli-login": "skip",
      "arm-token": "skip",
      "subscription-access": "skip",
    });
    expect(report.checks.find((c) => c.id === "azure-cli-installed")?.remediation).toMatch(
      /aka.ms\/installazurecli/
    );
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("tells the user to run az login when not signed in", async () => {
    vi.mocked(getAzureCliAccount).mockRejectedValue(
      new McpError("AuthenticationError", "Not logged in to Azure CLI. Please run: az login")
    );
    const report = await runSetupChecks();
    const login = report.checks.find((c) => c.id === "azure-cli-login");
    expect(login?.status).toBe("fail");
    expect(login?.remediation).toMatch(/az login/);
    expect(status(report)["arm-token"]).toBe("skip");
  });

  it("warns on tenant and cloud mismatches", async () => {
    vi.mocked(getSettings).mockReturnValue(
      settings({ tenantId: "t2", cloud: AZURE_CLOUDS.AzureGovernment })
    );
    const report = await runSetupChecks();
    const login = report.checks.find((c) => c.id === "azure-cli-login");
    expect(login?.status).toBe("warn");
    expect(login?.remediation).toContain("az login --tenant t2");
    expect(login?.remediation).toContain("az cloud set --name AzureUSGovernment");
    expect(report.ok).toBe(true);
  });

  it("surfaces configuration warnings", async () => {
    vi.mocked(getSettings).mockReturnValue(settings({ warnings: ["Config file is not valid JSON"] }));
    const report = await runSetupChecks();
    expect(status(report).configuration).toBe("warn");
  });

  it("warns when no subscriptions or the default subscription is not visible", async () => {
    vi.mocked(listSubscriptions).mockResolvedValueOnce({ subscriptions: [] });
    expect(status(await runSetupChecks())["subscription-access"]).toBe("warn");

    vi.mocked(getSettings).mockReturnValue(settings({ defaultSubscriptionId: "other" }));
    const report = await runSetupChecks();
    expect(status(report)["subscription-access"]).toBe("warn");
    expect(report.checks.find((c) => c.id === "subscription-access")?.message).toContain("other");
  });

  it("reports ARM failures", async () => {
    vi.mocked(listSubscriptions).mockRejectedValue(new McpError("AuthorizationError", "denied"));
    const report = await runSetupChecks();
    expect(report.ok).toBe(false);
    expect(status(report)["subscription-access"]).toBe("fail");
  });

  it("skips Azure CLI checks in passthrough mode", async () => {
    vi.mocked(isAzureCliAuthEnabled).mockReturnValue(false);
    vi.mocked(getAccessToken).mockRejectedValue(new McpError("AuthenticationError", "No bearer token"));
    const report = await runSetupChecks();
    expect(report.authMode).toBe("passthrough");
    expect(report.checks.map((c) => c.id)).not.toContain("azure-cli-installed");
    expect(report.checks.find((c) => c.id === "arm-token")?.remediation).toMatch(/Authorization: Bearer/);
  });

  it("reports enabled capabilities", async () => {
    setEnabledCapabilities(["write"]);
    vi.mocked(getSettings).mockReturnValue(settings({ capabilitySource: "cli" }));
    const report = await runSetupChecks();
    expect(report.checks.find((c) => c.id === "capabilities")?.message).toBe(
      "Enabled: read, write (from cli)."
    );
  });

  it("formats a readable report", async () => {
    vi.mocked(getAzureCliAccount).mockRejectedValue(
      new McpError("AuthenticationError", "Not logged in to Azure CLI. Please run: az login")
    );
    const text = formatSetupReport(await runSetupChecks());
    expect(text).toContain("✖ Azure CLI login: Not logged in");
    expect(text).toContain("→ Run 'az login'");
    expect(text).toContain("– Azure Resource Manager token: Skipped");
  });
});
