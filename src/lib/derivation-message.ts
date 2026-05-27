/**
 * Cortex — the canonical key-derivation message (single source of truth).
 *
 * This module is INTENTIONALLY dependency-free: it is imported by both the Node
 * side (crypto.ts → constants.ts) AND the browser connect app (ui/connect), which
 * is bundled for the `cortex auth` flow. If it pulled in `src/constants.ts`
 * (which reads `process.env`), the browser bundle would crash with
 * `process is not defined`. Keep it pure.
 *
 * The message the user signs is the seed for their memory's encryption key. If
 * the text the browser signs ever drifts from the text the auth callback
 * verifies, the derived AES key silently mismatches and recall returns garbage —
 * so both sides import `keyDerivationMessage` from HERE, never re-implement it.
 */

/** Domain separator for deterministic key derivation. Changing it is a hard versioning boundary. */
export const KEY_DERIVATION_DOMAIN = "CORTEX_KEY_DERIVATION_v1";

/**
 * The EIP-191 personal_sign message that bootstraps a session. Including the
 * lowercased address makes the signature unique per-wallet.
 */
export function keyDerivationMessage(userAddress: string): string {
  return [
    KEY_DERIVATION_DOMAIN,
    "",
    "I authorise this device to derive encryption keys for my Cortex memory.",
    "This signature does not transfer funds and is safe to sign.",
    "",
    `Address: ${userAddress.toLowerCase()}`,
  ].join("\n");
}
