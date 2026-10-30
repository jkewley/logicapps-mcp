import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./azureCli.js", () => ({
  getAzureCliToken: vi.fn(),
}));

import { getAzureCliToken } from "./azureCli.js";
import {
  getAccessToken,
  runWithToken,
  enableAzureCliAuth,
  setPassthroughToken,
  clearPassthroughToken,
  getCallerCacheKey,
} from "./tokenManager.js";

describe("tokenManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPassthroughToken();
    enableAzureCliAuth(false);
  });

  it("throws when no token source is available", async () => {
    await expect(getAccessToken()).rejects.toThrow(/Bearer token required/);
  });

  it("uses the request-scoped token and isolates concurrent requests", async () => {
    const [a, b] = await Promise.all([
      runWithToken("token-a", async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getAccessToken();
      }),
      runWithToken("token-b", () => getAccessToken()),
    ]);
    expect(a).toBe("token-a");
    expect(b).toBe("token-b");
  });

  it("does not fall back to Azure CLI inside a request scope without a token", async () => {
    enableAzureCliAuth(true);
    await expect(runWithToken(undefined, () => getAccessToken())).rejects.toThrow(/No bearer token/);
    expect(getAzureCliToken).not.toHaveBeenCalled();
  });

  it("uses and caches the Azure CLI token in local mode", async () => {
    enableAzureCliAuth(true);
    vi.mocked(getAzureCliToken).mockResolvedValue({
      accessToken: "cli-token",
      expiresOn: new Date(Date.now() + 60 * 60 * 1000),
      subscription: "s",
      tenant: "t",
      tokenType: "Bearer",
    });
    expect(await getAccessToken()).toBe("cli-token");
    expect(await getAccessToken()).toBe("cli-token");
    expect(getAzureCliToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes the Azure CLI token near expiry", async () => {
    enableAzureCliAuth(true);
    vi.mocked(getAzureCliToken)
      .mockResolvedValueOnce({ accessToken: "old", expiresOn: new Date(Date.now() + 60 * 1000), subscription: "s", tenant: "t", tokenType: "Bearer" })
      .mockResolvedValueOnce({ accessToken: "new", expiresOn: new Date(Date.now() + 3600 * 1000), subscription: "s", tenant: "t", tokenType: "Bearer" });
    expect(await getAccessToken()).toBe("old");
    expect(await getAccessToken()).toBe("new");
  });

  it("prefers the passthrough token over Azure CLI", async () => {
    enableAzureCliAuth(true);
    setPassthroughToken("pt");
    expect(await getAccessToken()).toBe("pt");
    expect(getAzureCliToken).not.toHaveBeenCalled();
  });

  it("derives distinct cache keys per caller", () => {
    expect(getCallerCacheKey()).toBe("local");
    const a = runWithToken("a", () => getCallerCacheKey());
    const b = runWithToken("b", () => getCallerCacheKey());
    expect(a).not.toBe(b);
    expect(a).not.toContain("a".repeat(2));
  });
});
