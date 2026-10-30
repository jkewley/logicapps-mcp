/**
 * Gets access tokens from Azure CLI.
 * Requires user to have run `az login` beforehand.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { McpError } from "../utils/errors.js";

const execAsync = promisify(exec);

export interface AzureCliToken {
  accessToken: string;
  expiresOn: Date;
  subscription: string;
  tenant: string;
  tokenType: string;
}

interface AzureCliTokenResponse {
  accessToken: string;
  expiresOn: string;
  subscription: string;
  tenant: string;
  tokenType: string;
}

const AZ_TIMEOUT_MS = 30_000;

/**
 * Runs an `az` command (fixed arguments only) and parses JSON output.
 * Errors are normalized into actionable AuthenticationError messages.
 */
async function runAzJson<T>(args: string): Promise<T> {
  try {
    // Use exec with shell to handle az.cmd on Windows
    const { stdout } = await execAsync(`az ${args} --output json`, {
      timeout: AZ_TIMEOUT_MS,
      windowsHide: true,
    });
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw classifyAzureCliError(error);
  }
}

/**
 * Map a raw Azure CLI failure to an McpError with a remediation hint.
 */
export function classifyAzureCliError(error: unknown): McpError {
  const err = error as { message?: string; stderr?: string; code?: number | string; killed?: boolean };
  const errorMessage = `${err?.stderr ?? ""} ${err?.message ?? String(error)}`;

  if (
    err?.code === "ENOENT" ||
    err?.code === 127 ||
    errorMessage.includes("ENOENT") ||
    /az: (command )?not found/i.test(errorMessage) ||
    /'az' is not recognized/i.test(errorMessage)
  ) {
    return new McpError(
      "AuthenticationError",
      "Azure CLI is not installed or not on PATH. Install it from https://aka.ms/installazurecli, then run: az login"
    );
  }

  if (err?.killed) {
    return new McpError(
      "AuthenticationError",
      "Azure CLI did not respond in time. Run 'az account show' in a terminal to check it is working."
    );
  }

  if (/AADSTS(50173|70043|700082|50078|50076)/.test(errorMessage) || /expired|re-?authenticate|interaction_required/i.test(errorMessage)) {
    return new McpError(
      "AuthenticationError",
      "Azure CLI login has expired or requires re-authentication (e.g. MFA). Please run: az login"
    );
  }

  if (
    errorMessage.includes("az login") ||
    /not logged in/i.test(errorMessage) ||
    errorMessage.includes("AADSTS")
  ) {
    return new McpError("AuthenticationError", "Not logged in to Azure CLI. Please run: az login");
  }

  return new McpError(
    "AuthenticationError",
    `Failed to get token from Azure CLI: ${(err?.message ?? String(error)).trim()}`
  );
}

/**
 * Gets an access token from Azure CLI for the ARM management API.
 * Throws if Azure CLI is not installed or user is not logged in.
 */
export async function getAzureCliToken(
  resource: string = "https://management.azure.com"
): Promise<AzureCliToken> {
  const response = await runAzJson<AzureCliTokenResponse>(
    `account get-access-token --resource "${resource}"`
  );
  return {
    accessToken: response.accessToken,
    expiresOn: new Date(response.expiresOn),
    subscription: response.subscription,
    tenant: response.tenant,
    tokenType: response.tokenType,
  };
}

export interface AzureCliAccount {
  user?: string;
  userType?: string;
  tenantId: string;
  subscriptionId: string;
  subscriptionName: string;
  environmentName: string;
}

/**
 * Returns the installed Azure CLI version (e.g. "2.67.0").
 */
export async function getAzureCliVersion(): Promise<string> {
  const v = await runAzJson<Record<string, string>>("version");
  return v["azure-cli"] ?? "unknown";
}

/**
 * Returns the signed-in Azure CLI account (`az account show`).
 */
export async function getAzureCliAccount(): Promise<AzureCliAccount> {
  const a = await runAzJson<{
    id: string;
    name: string;
    tenantId: string;
    environmentName: string;
    user?: { name?: string; type?: string };
  }>("account show");
  return {
    user: a.user?.name,
    userType: a.user?.type,
    tenantId: a.tenantId,
    subscriptionId: a.id,
    subscriptionName: a.name,
    environmentName: a.environmentName,
  };
}

/**
 * Checks if Azure CLI is available and user is logged in.
 * Returns subscription info if successful.
 */
export async function checkAzureCliAuth(): Promise<{
  loggedIn: boolean;
  subscription?: string;
  tenant?: string;
  error?: string;
}> {
  try {
    const token = await getAzureCliToken();
    return {
      loggedIn: true,
      subscription: token.subscription,
      tenant: token.tenant,
    };
  } catch (error) {
    return {
      loggedIn: false,
      error: error instanceof McpError ? error.message : String(error),
    };
  }
}
