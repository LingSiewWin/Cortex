/**
 * Browser wallet → Arkiv SDK bridge.
 *
 * Official Arkiv MetaMask sketch pattern: reuse the connected wallet's EIP-1193
 * transport via `custom()` so the user signs Braga writes in-wallet.
 *
 * @see https://docs.arkiv.network/learn/metamask-sketch-app/
 */

import {
  createWalletClient,
  custom,
  type WalletClient,
} from "@arkiv-network/sdk";
import { braga } from "@arkiv-network/sdk/chains";

export function createBrowserArkivWallet(
  transport: WalletClient["transport"],
  account: NonNullable<WalletClient["account"]>,
) {
  return createWalletClient({
    chain: braga,
    transport: custom(transport),
    account,
  });
}
