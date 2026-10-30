/**
 * Helpers for sanitizing run payloads before returning them to an LLM or
 * persisting them as test fixtures.
 */

export const REDACTED = "[REDACTED]";

// Header / property names that always carry credentials
const SENSITIVE_EXACT_KEYS =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-functions-key|x-ms-client-secret|ocp-apim-subscription-key|x-api-key|api-key|apikey|key|sig)$/i;

// Property names that contain a credential-like word
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|connectionstring|connection_string|accountkey|access_?key|private_?key|client_?secret|sas_?token|signature|credential)/i;

// Credential-bearing URL query parameters (SAS signatures, Functions keys, tokens)
const SENSITIVE_QUERY_PARAM =
  /([?&](?:sig|code|key|token|secret|password|api[-_]?key|access_token|client_secret)=)[^&\s"'#]+/gi;

// Credentials embedded in connection strings
const CONNECTION_STRING_SECRET =
  /\b(AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd|ClientSecret)=([^;"'\s]+)/gi;

const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/g;

export interface RedactionStats {
  redactedCount: number;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_EXACT_KEYS.test(key) || SENSITIVE_KEY_PATTERN.test(key);
}

export function redactString(value: string, stats?: RedactionStats): string {
  let count = 0;
  const out = value
    .replace(SENSITIVE_QUERY_PARAM, (_m, prefix: string) => {
      count++;
      return `${prefix}${REDACTED}`;
    })
    .replace(CONNECTION_STRING_SECRET, (_m, name: string) => {
      count++;
      return `${name}=${REDACTED}`;
    })
    .replace(BEARER_TOKEN, (_m, scheme: string) => {
      count++;
      return `${scheme} ${REDACTED}`;
    });
  if (stats) stats.redactedCount += count;
  return out;
}

/**
 * Deep-copy a value, replacing values of sensitive keys and scrubbing
 * credential patterns inside strings.
 */
export function redactValue<T>(value: T, stats: RedactionStats = { redactedCount: 0 }): T {
  return redactInner(value, stats, 0) as T;
}

function redactInner(value: unknown, stats: RedactionStats, depth: number): unknown {
  if (depth > 64) return value;
  if (typeof value === "string") return redactString(value, stats);
  if (Array.isArray(value)) return value.map((v) => redactInner(v, stats, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && v !== null && v !== undefined) {
        out[k] = REDACTED;
        stats.redactedCount++;
      } else {
        out[k] = redactInner(v, stats, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export interface TruncatedPayload {
  _truncated: true;
  originalBytes: number;
  preview: string;
}

/**
 * Replace a payload with a preview if its JSON size exceeds maxBytes.
 */
export function truncatePayload(
  value: unknown,
  maxBytes: number
): { value: unknown; truncated: boolean } {
  if (value === undefined) return { value, truncated: false };
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = Buffer.byteLength(json ?? "", "utf8");
  if (bytes <= maxBytes) return { value, truncated: false };
  const preview: TruncatedPayload = {
    _truncated: true,
    originalBytes: bytes,
    preview: json.slice(0, Math.min(1024, maxBytes)),
  };
  return { value: preview, truncated: true };
}

/**
 * Map over items with bounded concurrency, preserving order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
