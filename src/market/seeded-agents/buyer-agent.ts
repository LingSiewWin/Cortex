/**
 * Cortex — seeded buyer agent for the live demo.
 *
 * Behaviour:
 *   - Every 30 seconds, calls browseListings({})
 *   - Picks the highest-confidence listing with confidence >= 80 that this
 *     buyer hasn't already purchased.
 *   - Calls buyAndDecrypt() — sends real GLM on Braga, polls Arkiv for the
 *     seller's grant entity, decrypts the rule, logs it.
 *
 * The behaviour is scripted (always buys highest-confidence) but the txs are
 * real — judges can click into the explorer and see real on-chain activity.
 */

import type { Hex, WalletArkivClient } from "@arkiv-network/sdk";
import { browseListings, buyAndDecrypt } from "../decrypt-grant";
import { MARKET, MARKET_ZERO_ADDRESS } from "../../constants";

const POLL_INTERVAL_MS = 30_000;
const MIN_CONFIDENCE = 80;

export interface BuyerAgentHandle {
  stop: () => void;
  /** Listing keys this buyer has already bought (in-memory dedupe). */
  getPurchased: () => Hex[];
}

export function start(opts: {
  buyerWalletClient: WalletArkivClient;
  /**
   * SynapticMarket contract address. Optional — defaults to
   * `MARKET.contractAddress` (which reads MARKET_CONTRACT_ADDRESS env var).
   * If neither is set (i.e. the contract hasn't been deployed), we log a
   * warning and return an idle handle so the demo doesn't try to pay GLM
   * into the zero address.
   */
  marketContract?: Hex;
  intervalMs?: number;
  minConfidence?: number;
  maxPriceWei?: bigint;
  onLog?: (msg: string) => void;
  onDecrypted?: (info: {
    listingKey: Hex;
    plaintext: string;
    grantTxHash: string;
  }) => void;
}): BuyerAgentHandle {
  const log = opts.onLog ?? (() => {});
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  const minConfidence = opts.minConfidence ?? MIN_CONFIDENCE;
  const purchased = new Set<Hex>();
  let stopped = false;

  const marketContract = opts.marketContract ?? MARKET.contractAddress;

  // Short-circuit if the SynapticMarket contract isn't deployed. Returning an
  // idle handle keeps the demo runner alive — buyer just won't try to spend.
  if (marketContract.toLowerCase() === MARKET_ZERO_ADDRESS) {
    console.warn(
      "[buyer-agent] MARKET_CONTRACT_ADDRESS not set; buyer agent will be " +
        "idle. Deploy SynapticMarket.sol and set the env var to enable.",
    );
    return {
      stop: () => {
        log("[buyer-agent] stopped (was idle — no contract address)");
      },
      getPurchased: () => [],
    };
  }

  const tick = async () => {
    if (stopped) return;
    try {
      const listings = await browseListings({
        ...(opts.maxPriceWei !== undefined ? { maxPriceWei: opts.maxPriceWei } : {}),
      });
      const target = listings.find(
        (l) => l.confidence >= minConfidence && !purchased.has(l.entityKey),
      );
      if (!target) {
        log("[buyer-agent] no new listings worth buying");
        return;
      }
      log(
        `[buyer-agent] buying ${target.entityKey} ` +
          `(tag=${target.ruleTag}, confidence=${target.confidence}, ` +
          `price=${target.priceWei})`,
      );
      const result = await buyAndDecrypt({
        listingKey: target.entityKey,
        buyerWalletClient: opts.buyerWalletClient,
        marketContract,
      });
      purchased.add(target.entityKey);
      log(
        `[buyer-agent] decrypted ${target.entityKey} grantTx=${result.grantTxHash}`,
      );
      opts.onDecrypted?.({
        listingKey: target.entityKey,
        plaintext: result.plaintext,
        grantTxHash: result.grantTxHash,
      });
    } catch (err) {
      console.error("[buyer-agent] tick failed:", err);
    }
  };

  // Run an immediate tick so the demo doesn't sit idle for 30s.
  void tick();
  const handle = setInterval(() => {
    void tick();
  }, interval);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
      log("[buyer-agent] stopped");
    },
    getPurchased: () => [...purchased],
  };
}
