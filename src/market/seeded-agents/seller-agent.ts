/**
 * Cortex — seeded seller agent for the live demo.
 *
 * Behaviour:
 *   - On start, publishes two pre-canned anti-rug rules to the Synaptic Market.
 *   - Each listing is encrypted with a fresh per-listing AES key (publishListing
 *     handles this).
 *   - The decryption keys are kept in memory and exported via getKeyMap() so
 *     the demo runner can hand them to startGrantWatcher.
 *
 * This is "seeded" in that the *rules* are pre-canned, but the Arkiv writes and
 * the encryption are real. The judges see live listings on the chain explorer.
 */

import type { Hex } from "@arkiv-network/sdk";
import type { Database } from "bun:sqlite";
import { publishListing } from "../publish";
import { MARKET, MARKET_ZERO_ADDRESS } from "../../constants";

interface SeededRule {
  ruleText: string;
  ruleTag: string;
  confidence: number;
}

const SEEDED_RULES: readonly SeededRule[] = [
  {
    ruleTag: "anti_rug_v1",
    confidence: 92,
    ruleText:
      "If a freshly-deployed ERC-20 has (a) deployer-owned >70% of supply, " +
      "(b) no renounced ownership, and (c) a transfer hook calling an " +
      "unverified contract, treat as rug: decline trades, do not approve " +
      "router spending. Empirical false-positive rate <4% over 1,200 launches.",
  },
  {
    ruleTag: "memecoin_safety",
    confidence: 81,
    ruleText:
      "For memecoin entries, cap position at 0.5% of portfolio NAV and " +
      "require LP locked >=30 days. If LP unlock is within 7 days, halve " +
      "position size or skip. This rule survived 5 distinct sessions of " +
      "drawdown analysis.",
  },
];

export interface SellerAgentHandle {
  stop: () => void;
  /**
   * The seller's per-listing decryption keys. Hand this to startGrantWatcher
   * so the relayer can fulfil Grant events.
   */
  getKeyMap: () => Map<Hex, Uint8Array>;
  /** Entity keys of published listings, in publish order. */
  getListingKeys: () => Hex[];
}

/**
 * Start the seller agent. Publishes seeded rules in the background and resolves
 * the handle synchronously so the demo can wire up the grant watcher
 * immediately.
 */
export function start(opts?: {
  priceWei?: bigint;
  onLog?: (msg: string) => void;
  /** SQLite mirror handle. Forwarded to publishListing for restart-safe key persistence. */
  db?: Database;
  /** User-derived wrap key. Required alongside `db` to persist sealed listing keys. */
  userKey?: CryptoKey;
}): SellerAgentHandle {
  const price = opts?.priceWei ?? MARKET.defaultListingPriceWei;
  const log = opts?.onLog ?? (() => {});
  const keyMap = new Map<Hex, Uint8Array>();
  const listingKeys: Hex[] = [];
  let stopped = false;

  // Short-circuit when the SynapticMarket contract isn't deployed. The seller
  // still gets a handle so the demo runner doesn't crash; it just never
  // publishes (a buyer with no contract has no way to pay anyway).
  if (MARKET.contractAddress.toLowerCase() === MARKET_ZERO_ADDRESS) {
    console.warn(
      "[seller-agent] MARKET_CONTRACT_ADDRESS not set; seller agent will be " +
        "idle. Deploy SynapticMarket.sol and set the env var to enable.",
    );
    return {
      stop: () => {
        log("[seller-agent] stopped (was idle — no contract address)");
      },
      getKeyMap: () => keyMap,
      getListingKeys: () => [],
    };
  }

  (async () => {
    for (const rule of SEEDED_RULES) {
      if (stopped) return;
      try {
        const result = await publishListing({
          ruleText: rule.ruleText,
          ruleTag: rule.ruleTag,
          confidence: rule.confidence,
          priceWei: price,
          ...(opts?.userKey ? { userKey: opts.userKey } : {}),
          ...(opts?.db ? { db: opts.db } : {}),
        });
        keyMap.set(result.entityKey, result.decryptionKey);
        listingKeys.push(result.entityKey);
        log(
          `[seller-agent] published ${rule.ruleTag} ` +
            `entity=${result.entityKey} tx=${result.txHash}`,
        );
      } catch (err) {
        console.error(
          `[seller-agent] failed to publish ${rule.ruleTag}:`,
          err,
        );
      }
    }
  })();

  return {
    stop: () => {
      stopped = true;
      log("[seller-agent] stopped");
    },
    getKeyMap: () => keyMap,
    getListingKeys: () => [...listingKeys],
  };
}
