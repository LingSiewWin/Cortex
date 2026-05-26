/**
 * Cortex — generate CORTEX_USER_SIGNATURE for memory encryption-at-rest.
 *
 * Signs the fixed key-derivation message with your PRIMARY wallet and prints the
 * 65-byte EIP-191 signature. Put it in .env as CORTEX_USER_SIGNATURE so the daemon
 * / scripts can seal + open memories with no private key in the environment.
 *
 * Run:  CORTEX_USER_PRIVATE_KEY=0x<primary-eoa-key> bun scripts/derive-user-signature.ts
 *       (or pass the key as argv[2]). The private key is used only to sign locally.
 */

import { privateKeyToAccount } from "@arkiv-network/sdk/accounts";
import type { Hex } from "@arkiv-network/sdk";
import { keyDerivationMessage } from "../src/lib/crypto";

const pk = (process.argv[2] ?? process.env.CORTEX_USER_PRIVATE_KEY ?? "").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error(
    "Provide the primary EOA key: CORTEX_USER_PRIVATE_KEY=0x<64hex> bun scripts/derive-user-signature.ts",
  );
  process.exit(2);
}

const account = privateKeyToAccount(pk as Hex);
const message = keyDerivationMessage(account.address);
const signature = await account.signMessage({ message });

console.log(`# wallet:  ${account.address}`);
console.log(`CORTEX_USER_SIGNATURE=${signature}`);
