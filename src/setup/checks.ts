/**
 * Setup/preflight checks: verifies configuration, Azure CLI login and ARM access,
 * and reports actionable remediation steps. Used at startup, by `--check`, and
 * by the `check_setup` tool.
 */

import {
  getAccessToken,
  getAzureCliAccount,
  getAzureCliVersion,
  getSettings,
  isAzureCliAuthEnabled,
} from "../auth/index.js";
import { getEnabledCapabilities, OPT_IN_CAPABILITIES } from "../tools/capabilities.js";
import { listSubscriptions } from "../tools/subscriptions.js";
import { McpError } from "../utils/errors.js";
import { VERSION } from "../version.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface SetupCheck {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export interface SetupReport {
  ok: boolean;
  version: string;
  authMode: "azure-cli" | "passthrough";
  checks: SetupCheck[];
  summary: string;
}

/** Map our cloud names to `az cloud` environment names. */
const AZ_CLOUD_NAMES: Record<string, string> = {
  AzurePublic: "AzureCloud",
  AzureGovernment: "AzureUSGovernment",
  AzureChina: "AzureChinaCloud",
};

function errorMessage(error: unknown): string {
  return error instanceof McpError || error instanceof Error ? error.message : String(error);
}

function remediationFor(message: string): string | undefined {
  if (/not installed|not on PATH/i.test(message)) {
    return "Install Azure CLI (https://aka.ms/installazurecli), then run 'az login' and restart the MCP server.";
  }
  if (/az login/i.test(message)) {
    return "Run 'az login' in a terminal, then retry (no server restart needed).";
  }
  return undefined;
}

function skipped(id: string, title: string, reason: string): SetupCheck {
  return { id, title, status: "skip", message: `Skipped: ${reason}` };
}

/**
 * Run all setup checks. Never throws; failures are reported in the result.
 */
export async function runSetupChecks(): Promise<SetupReport> {
  const checks: SetupCheck[] = [];
  const settings = getSettings();
  const cliMode = isAzureCliAuthEnabled();

  // 1. Configuration
  if (!settings) {
    checks.push({
      id: "configuration",
      title: "Configuration",
      status: "fail",
      message: "Settings were not initialized.",
    });
  } else if (settings.warnings.length > 0) {
    checks.push({
      id: "configuration",
      title: "Configuration",
      status: "warn",
      message: settings.warnings.join(" "),
      remediation: `Fix the values above (config file: ${settings.configFilePath}).`,
    });
  } else {
    checks.push({
      id: "configuration",
      title: "Configuration",
      status: "pass",
      message: `Cloud: ${settings.cloud.name}; tenant: ${settings.tenantId}` +
        (settings.defaultSubscriptionId ? `; default subscription: ${settings.defaultSubscriptionId}` : ""),
    });
  }

  // 2. Capabilities (informational)
  const enabled = getEnabledCapabilities();
  const optIn = enabled.filter((c) => c !== "read");
  const source = settings?.capabilitySource ?? "default";
  checks.push({
    id: "capabilities",
    title: "Capabilities",
    status: "pass",
    message:
      optIn.length === 0
        ? "Read-only (default). Tools that run, change, or expose secrets of live Logic Apps are disabled."
        : `Enabled: ${enabled.join(", ")} (from ${source}).`,
    remediation:
      optIn.length < OPT_IN_CAPABILITIES.length
        ? `To enable more, add e.g. '--allow write,execute' to the server args or set LOGICAPPS_MCP_CAPABILITIES. Available: ${OPT_IN_CAPABILITIES.join(", ")}, all.`
        : undefined,
  });

  // 3-4. Azure CLI (local mode only)
  let cliUsable = true;
  if (cliMode) {
    try {
      const version = await getAzureCliVersion();
      checks.push({
        id: "azure-cli-installed",
        title: "Azure CLI installed",
        status: "pass",
        message: `Azure CLI ${version}`,
      });
    } catch (error) {
      cliUsable = false;
      const msg = errorMessage(error);
      checks.push({
        id: "azure-cli-installed",
        title: "Azure CLI installed",
        status: "fail",
        message: msg,
        remediation: remediationFor(msg),
      });
    }

    if (!cliUsable) {
      checks.push(skipped("azure-cli-login", "Azure CLI login", "Azure CLI is not available"));
    } else {
      try {
        const account = await getAzureCliAccount();
        const problems: string[] = [];
        const fixes: string[] = [];

        if (
          settings &&
          settings.tenantId !== "common" &&
          settings.tenantId.toLowerCase() !== account.tenantId.toLowerCase()
        ) {
          problems.push(
            `Signed in to tenant ${account.tenantId} but AZURE_TENANT_ID/config expects ${settings.tenantId}.`
          );
          fixes.push(`az login --tenant ${settings.tenantId}`);
        }

        const expectedCloud = settings ? AZ_CLOUD_NAMES[settings.cloud.name] : undefined;
        if (expectedCloud && account.environmentName && account.environmentName !== expectedCloud) {
          problems.push(
            `Azure CLI is using cloud '${account.environmentName}' but the server is configured for '${settings?.cloud.name}'.`
          );
          fixes.push(`az cloud set --name ${expectedCloud} && az login`);
        }

        checks.push({
          id: "azure-cli-login",
          title: "Azure CLI login",
          status: problems.length > 0 ? "warn" : "pass",
          message:
            `Signed in as ${account.user ?? "unknown"} (tenant ${account.tenantId}, ` +
            `subscription '${account.subscriptionName}').` +
            (problems.length > 0 ? ` ${problems.join(" ")}` : ""),
          remediation: fixes.length > 0 ? `Run: ${fixes.join("; ")}` : undefined,
        });
      } catch (error) {
        cliUsable = false;
        const msg = errorMessage(error);
        checks.push({
          id: "azure-cli-login",
          title: "Azure CLI login",
          status: "fail",
          message: msg,
          remediation: remediationFor(msg) ?? "Run 'az login' in a terminal, then retry.",
        });
      }
    }
  }

  // 5. ARM token
  let tokenOk = false;
  if (cliMode && !cliUsable) {
    checks.push(skipped("arm-token", "Azure Resource Manager token", "Azure CLI login failed"));
  } else {
    try {
      await getAccessToken();
      tokenOk = true;
      checks.push({
        id: "arm-token",
        title: "Azure Resource Manager token",
        status: "pass",
        message: cliMode ? "Token acquired from Azure CLI." : "Caller supplied a bearer token.",
      });
    } catch (error) {
      const msg = errorMessage(error);
      checks.push({
        id: "arm-token",
        title: "Azure Resource Manager token",
        status: "fail",
        message: msg,
        remediation: cliMode
          ? remediationFor(msg) ?? "Run 'az login' in a terminal, then retry."
          : "Send an ARM-scoped token: Authorization: Bearer $(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)",
      });
    }
  }

  // 6. Subscription access
  if (!tokenOk) {
    checks.push(skipped("subscription-access", "Subscription access", "no Azure token"));
  } else {
    try {
      const { subscriptions } = await listSubscriptions();
      const defaultSub = settings?.defaultSubscriptionId;
      if (subscriptions.length === 0) {
        checks.push({
          id: "subscription-access",
          title: "Subscription access",
          status: "warn",
          message: "Signed in, but no Azure subscriptions are visible to this identity.",
          remediation:
            "Ask for a role (e.g. Reader or Logic App Operator) on the subscription/resource group, or sign in with a different account/tenant.",
        });
      } else if (
        defaultSub &&
        !subscriptions.some((s) => s.subscriptionId.toLowerCase() === defaultSub.toLowerCase())
      ) {
        checks.push({
          id: "subscription-access",
          title: "Subscription access",
          status: "warn",
          message: `${subscriptions.length} subscription(s) visible, but the default subscription ${defaultSub} is not one of them.`,
          remediation: "Fix AZURE_SUBSCRIPTION_ID / defaultSubscriptionId, or sign in to the tenant that owns it.",
        });
      } else {
        checks.push({
          id: "subscription-access",
          title: "Subscription access",
          status: "pass",
          message: `${subscriptions.length} subscription(s) visible.`,
        });
      }
    } catch (error) {
      const msg = errorMessage(error);
      checks.push({
        id: "subscription-access",
        title: "Subscription access",
        status: "fail",
        message: `Could not list subscriptions: ${msg}`,
        remediation:
          remediationFor(msg) ?? "Check network access to Azure Resource Manager and that your login is valid.",
      });
    }
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const summary =
    failed > 0
      ? `Setup has ${failed} problem(s)${warned ? ` and ${warned} warning(s)` : ""}. Most tools will fail until fixed.`
      : warned > 0
        ? `Setup OK with ${warned} warning(s).`
        : "Setup OK.";

  return {
    ok: failed === 0,
    version: VERSION,
    authMode: cliMode ? "azure-cli" : "passthrough",
    checks,
    summary,
  };
}

const ICONS: Record<CheckStatus, string> = { pass: "✔", warn: "⚠", fail: "✖", skip: "–" };

/**
 * Human-readable report for terminals/logs.
 */
export function formatSetupReport(report: SetupReport): string {
  const lines = [`logicapps-mcp ${report.version} setup check (${report.authMode} auth)`];
  for (const c of report.checks) {
    lines.push(`  ${ICONS[c.status]} ${c.title}: ${c.message}`);
    if (c.remediation && c.status !== "skip") {
      lines.push(`      → ${c.remediation}`);
    }
  }
  lines.push(report.summary);
  return lines.join("\n");
}
