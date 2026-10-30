/**
 * Auth module barrel file.
 * Re-exports all auth-related functions.
 */

// Azure CLI exports (for local development and integration tests)
export { getAzureCliToken, checkAzureCliAuth } from "./azureCli.js";
export type { AzureCliToken } from "./azureCli.js";

// Token manager (request-scoped passthrough, or Azure CLI in stdio mode)
export {
  getAccessToken,
  setSettings,
  initializeAuth,
  logout,
  setPassthroughToken,
  clearPassthroughToken,
  runWithToken,
  enableAzureCliAuth,
  getCallerCacheKey,
} from "./tokenManager.js";
