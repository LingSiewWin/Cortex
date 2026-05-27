/**
 * Ensure MetaMask (or any injected wallet) is on Arkiv Braga before signing.
 *
 * GLM for gas is Braga's *native* currency — it never appears under MetaMask
 * "Tokens" on Ethereum. If the wallet is still on mainnet when a Braga tx is
 * built, MetaMask often shows "insufficient funds for network fees" even when
 * the user has GLM on Braga (visible only on the explorer / L3 dashboard).
 */

import type { WalletClient } from "viem";
import { braga } from "@arkiv-network/sdk/chains";
import { BRAGA } from "@/src/constants";

export async function ensureBragaNetwork(client: WalletClient): Promise<void> {
  const providerChainHex = await client.request({ method: "eth_chainId" });
  const providerChainId = Number(providerChainHex);
  if (providerChainId === Number(braga.id)) return;

  try {
    await client.switchChain({ id: braga.id });
  } catch {
    try {
      await client.addChain({ chain: braga });
      await client.switchChain({ id: braga.id });
    } catch {
      throw new Error(
        `Your wallet is not on Arkiv Braga (chain ${braga.id}). ` +
          `Open MetaMask → network picker → select Braga, or approve "Add Braga network" when prompted. ` +
          `Use RPC ${BRAGA.httpRpc} and chain ID ${braga.id}. ` +
          `GLM for gas is the native coin on Braga only — it does not show under Tokens while you are on Ethereum.`,
      );
    }
  }

  const afterHex = await client.request({ method: "eth_chainId" });
  if (Number(afterHex) !== Number(braga.id)) {
    throw new Error(
      `Still not on Braga after network switch (provider reports chain ${Number(afterHex)}). ` +
        `In MetaMask, select the Braga network with chain ID ${braga.id} and RPC ${BRAGA.httpRpc}, then retry.`,
    );
  }
}
