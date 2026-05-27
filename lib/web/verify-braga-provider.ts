/**
 * Read chain id + balance from the wallet's own provider (MetaMask RPC).
 * Wagmi's useBalance({ chainId: braga }) uses our configured HTTP RPC and can
 * disagree with what MetaMask shows in the sign popup.
 */

import type { Address, WalletClient } from "viem";
import { createPublicClient, custom, formatEther } from "viem";
import { braga } from "@arkiv-network/sdk/chains";
import { BRAGA } from "@/src/constants";

export interface BragaProviderSnapshot {
  chainId: number;
  balanceWei: bigint;
  balanceGlm: string;
}

export async function readBragaProviderSnapshot(
  client: WalletClient,
  address: Address,
): Promise<BragaProviderSnapshot> {
  const chainIdHex = await client.request({ method: "eth_chainId" });
  const chainId = Number(chainIdHex);
  const publicClient = createPublicClient({
    chain: braga,
    transport: custom(client),
  });
  const balanceWei = await publicClient.getBalance({ address });
  return {
    chainId,
    balanceWei,
    balanceGlm: formatEther(balanceWei),
  };
}

/**
 * Call immediately before signing. Throws with actionable copy when MetaMask's
 * network/RPC does not match official Braga or reports zero GLM.
 */
export async function assertBragaProviderReady(
  client: WalletClient,
  address: Address,
  minWei: bigint = 100_000_000_000_000n, // 0.0001 GLM
): Promise<BragaProviderSnapshot> {
  const snap = await readBragaProviderSnapshot(client, address);

  if (snap.chainId !== braga.id) {
    throw new Error(
      `MetaMask is on chain ${snap.chainId}, not Arkiv Braga (${braga.id} / 0x${braga.id.toString(16)}). ` +
        `Open MetaMask → Networks → select Braga with chain ID ${braga.id} and RPC ${BRAGA.httpRpc}. ` +
        `A network named "Braga" or "Hackathon" with the wrong chain ID will show 0 GLM and reject the tx.`,
    );
  }

  if (snap.balanceWei < minWei) {
    throw new Error(
      `MetaMask's RPC reports ${snap.balanceGlm} GLM on Braga — not enough for this tx (need ~${formatEther(minWei)} GLM gas). ` +
        `If the Cortex banner showed more GLM, your MetaMask Braga network likely uses the wrong RPC URL. ` +
        `Fix: MetaMask → Braga network → RPC URL must be exactly ${BRAGA.httpRpc} · Chain ID ${braga.id}. ` +
        `Then fund: ${BRAGA.faucet}`,
    );
  }

  return snap;
}
