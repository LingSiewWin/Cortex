/**
 * Cortex — Arkiv error taxonomy.
 *
 * Pattern adapted from p2pmentor (per docs/Pass-Winning.md): the SDK does NOT
 * retry. We must classify failures and decide retry-vs-bail per category.
 *
 * Known error families on Braga:
 *   - 429 / "too many requests" → rate limit, exponential backoff
 *   - JSON-RPC code -32016 → Arkiv-specific (queueing / submission), retry once
 *   - "nonce too low" / "replacement transaction underpriced" → nonce race, refresh
 *   - "insufficient funds" → faucet, do NOT retry
 *   - "entity has expired" → caller logic bug, do NOT retry
 *   - "ExpiryNotExtended" → REPLACE-not-ADD revert, caller used wrong math
 */

export type ArkivErrorCategory =
  | "rate_limit"
  | "arkiv_submission"
  | "nonce_race"
  | "insufficient_funds"
  | "expired_entity"
  | "extend_too_short"
  | "user_rejected"
  | "network"
  | "unknown";

export interface ClassifiedError {
  category: ArkivErrorCategory;
  retryable: boolean;
  backoffMs: number;
  raw: unknown;
  message: string;
}

const DEFAULT_BACKOFF_MS = 500;

export function classifyError(err: unknown): ClassifiedError {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  const lower = message.toLowerCase();
  const code = (err as { code?: number })?.code;

  if (lower.includes("429") || lower.includes("too many requests")) {
    return { category: "rate_limit", retryable: true, backoffMs: 2000, raw: err, message };
  }
  if (code === -32016 || lower.includes("-32016")) {
    return {
      category: "arkiv_submission",
      retryable: true,
      backoffMs: 1000,
      raw: err,
      message,
    };
  }
  if (
    lower.includes("nonce too low") ||
    lower.includes("replacement transaction underpriced") ||
    lower.includes("already known")
  ) {
    return { category: "nonce_race", retryable: true, backoffMs: 500, raw: err, message };
  }
  if (lower.includes("insufficient funds") || lower.includes("insufficient balance")) {
    return {
      category: "insufficient_funds",
      retryable: false,
      backoffMs: 0,
      raw: err,
      message,
    };
  }
  if (lower.includes("expired") || lower.includes("entity not found")) {
    return { category: "expired_entity", retryable: false, backoffMs: 0, raw: err, message };
  }
  if (lower.includes("expirynotextended") || lower.includes("expiry not extended")) {
    return {
      category: "extend_too_short",
      retryable: false,
      backoffMs: 0,
      raw: err,
      message,
    };
  }
  if (lower.includes("user rejected") || lower.includes("user denied")) {
    return { category: "user_rejected", retryable: false, backoffMs: 0, raw: err, message };
  }
  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("connection")
  ) {
    return { category: "network", retryable: true, backoffMs: 1500, raw: err, message };
  }
  return { category: "unknown", retryable: false, backoffMs: DEFAULT_BACKOFF_MS, raw: err, message };
}

/**
 * Retry an async operation with exponential backoff, gated by the classifier.
 * Bails immediately on non-retryable errors. Caller-tunable max attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; label?: string } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const label = options.label ?? "arkiv-call";
  let lastErr: ClassifiedError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = classifyError(err);
      if (!lastErr.retryable || attempt === maxAttempts) {
        throw new Error(
          `[${label}] failed after ${attempt} attempt(s) (${lastErr.category}): ${lastErr.message}`,
          { cause: err },
        );
      }
      const delay = lastErr.backoffMs * Math.pow(2, attempt - 1);
      console.warn(
        `[${label}] attempt ${attempt}/${maxAttempts} → ${lastErr.category}, retry in ${delay}ms`,
      );
      await Bun.sleep(delay);
    }
  }
  // unreachable, but TS doesn't know that
  throw new Error(`[${label}] retry loop exited unexpectedly`);
}
