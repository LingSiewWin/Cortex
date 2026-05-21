/**
 * Shared formatting helpers for the ambient dashboard.
 *
 * Keep them pure — no React imports — so they can be unit-tested or reused
 * inside the server's JSON shapers if we ever want server-rendered fallbacks.
 */

export function truncateAddress(addr: string | null | undefined): string {
  if (!addr) return "—";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "expired";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

/**
 * Render an Arkiv on-chain price (wei) as GLM with up to 4 decimals.
 * Arkiv prices fit in BigInt; we never see floats on the wire.
 */
export function formatGlm(weiString: string): string {
  let wei: bigint;
  try {
    wei = BigInt(weiString);
  } catch {
    return "0 GLM";
  }
  if (wei === 0n) return "0 GLM";
  const whole = wei / 1_000_000_000_000_000_000n;
  const frac = wei % 1_000_000_000_000_000_000n;
  // Show 4 decimals max — enough resolution for micro-tx demos.
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
  const trimmedFrac = fracStr.replace(/0+$/, "");
  return trimmedFrac.length > 0
    ? `${whole.toString()}.${trimmedFrac} GLM`
    : `${whole.toString()} GLM`;
}

export function tierLabel(tier: string): string {
  switch (tier) {
    case "working":
      return "Working";
    case "episodic":
      return "Episodic";
    case "rule":
      return "Rule";
    default:
      return "Other";
  }
}
