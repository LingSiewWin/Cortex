/**
 * Cortex — pinned project-wide constants.
 *
 * Per arkiv-best-practices SKILL §1: every entity create and every query MUST include
 * PROJECT_ATTRIBUTE. Without it, queries leak data from other projects in the shared DB.
 *
 * Per CLAUDE.md "Pinned facts": do not change without explicit user approval.
 */

import { KEY_DERIVATION_DOMAIN } from "./lib/derivation-message";

/**
 * Namespace tag stamped on every Cortex entity. Filters our data out of the shared
 * Arkiv state. The value should be globally unique — if a judge collides with us,
 * our reads pull their entities into our dashboard.
 */
export const PROJECT_ATTRIBUTE = {
  key: "project",
  value: "cortex-ethns-2026",
} as const;

if (!PROJECT_ATTRIBUTE.value) {
  throw new Error(
    "PROJECT_ATTRIBUTE.value must be set. Without it, Cortex queries will mix with other projects' entities on the shared Arkiv DB.",
  );
}

/**
 * Per-workspace provenance attribute key — tags which of the USER's repos /
 * workspaces a memory belongs to (drives project-scoped recall + per-project
 * graph clusters).
 *
 * MUST NOT be "project": that key is reserved by PROJECT_ATTRIBUTE (the global
 * Cortex namespace stamped on EVERY entity). Reusing "project" for per-repo
 * provenance collided — an entity got two `project` attributes, the namespace
 * value won, the repo value was silently dropped, and `project = "<repo>"`
 * queries returned 0. (Learned the hard way; do not change back to "project".)
 */
export const WORKSPACE_ATTR = "workspace" as const;

if ((WORKSPACE_ATTR as string) === PROJECT_ATTRIBUTE.key) {
  throw new Error(
    "WORKSPACE_ATTR must differ from PROJECT_ATTRIBUTE.key — reusing the namespace key collides and silently drops workspace provenance.",
  );
}

/**
 * Braga testnet — Cortex never touches mainnet. All facts below match
 * the official Arkiv-ETHNS challenge AGENTS.md.
 */
export const BRAGA = {
  chainId: 60138453102,
  httpRpc: "https://braga.hoodi.arkiv.network/rpc",
  wsRpc: "wss://braga.hoodi.arkiv.network/rpc/ws",
  faucet: "https://braga.hoodi.arkiv.network/faucet/",
  explorer: "https://explorer.braga.hoodi.arkiv.network/",
  blockTimeSeconds: 2,
  /** The Rust precompile that is the *actual* Arkiv registry on Braga. */
  precompileAddress: "0x00000000000000000000000000000061726b6976",
  /** OP-Stack L1Block predeploy — drives automatic EXPIRE events. */
  l1BlockPredeploy: "0x4200000000000000000000000000000000000015",
  /** OP-Stack system depositor — caller of L1Block.setL1BlockValues. */
  systemDepositor: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001",
} as const;

/**
 * Cortex entity types. Strings on the wire; numeric IDs would be cheaper to range-query
 * but lose readability in the explorer. The flat list is intentional — Arkiv attributes
 * have no nested type.
 */
export const ENTITY_TYPE = {
  /** Working-tier raw observation, RaBitQ-compressed embedding. */
  OBSERVATION: "observation",
  /** Episodic-tier event, promoted from observation after ≥2 citations. */
  EPISODE: "episode",
  /** Semantic-tier plain-text rule, LLM-distilled from episodes. */
  RULE: "rule",
  /**
   * Opt-in Document Tier — full-text long-form note (e.g. an Obsidian note).
   * Sealed payload is CBOR{ text, code, emb, sections… } (see
   * src/compression/document-payload.ts): the FULL text + embeddings, so the
   * vault is recoverable from the wallet alone (lossless), not just a lossy
   * RaBitQ fingerprint. Durable by default (sovereignty), reinforced on recall.
   */
  DOCUMENT: "document",
  /** Citation record — links an act() call to the memory IDs it relied on. */
  CITATION: "citation",
  /** Synaptic Market listing — encrypted payload + public tags. */
  LISTING: "listing",
  /** Decryption grant — emitted when a buyer pays the listing price. */
  GRANT: "grant",
  /**
   * Phase 13 — MMR state-root anchor. Payload = { rootHex, leafCount,
   * triggerReason }. Excluded from the MMR itself (would cause infinite
   * recursion). Verifier reads these to confirm an off-chain SQLite mirror
   * matches the on-chain commitment.
   */
  STATE_ROOT: "state_root",
} as const;

export type EntityType = (typeof ENTITY_TYPE)[keyof typeof ENTITY_TYPE];

/**
 * Content-type discriminator for memory payloads sealed with the wallet-derived
 * key (see `src/lib/crypto.ts` + `src/lib/payload-key.ts`). Memories
 * (observation/episode/rule) are encrypted client-side before being written to
 * Arkiv — the chain (and the local mirror) hold ciphertext; recall decrypts in
 * RAM with the user's wallet key. Recall keys off this contentType to decide
 * whether to `openPayload` before decoding. The `entityType` *attribute* (not
 * the contentType) remains the type-of-record. Non-memory writes (citation,
 * state_root, market listing/grant) keep their own contentTypes and are NOT
 * sealed here.
 */
export const SEALED_CONTENT_TYPE = "application/x-cortex-sealed";

/**
 * Reinforcement parameters for the Darwinian engine. Deployed Braga `extend` is
 * ADDITIVE (verified on-chain 2026-05-25), so each citation adds its reinforcement
 * to the existing lease:
 *   new_expires_at = current_expires_at + reinforcementSeconds
 * where reinforcementSeconds = base × utility factor (see darwinian/utility.ts
 * leaseSeconds — a proven memory earns up to 2.5× base [1 + gamma·(wMax−wInit) =
 * 1 + 0.5·3.0], an unproven one gets exactly base).
 *
 * 24h reinforcement is the working baseline. Tier promotions multiply this:
 *   working → episodic: +7 days
 *   episodic → semantic: distilled to a rule entity with 1-year initial TTL
 */
export const REINFORCEMENT = {
  initialWorkingSeconds: 60 * 60, // 1 hour
  workingReinforcementSeconds: 24 * 60 * 60, // 24 hours per citation
  episodicReinforcementSeconds: 7 * 24 * 60 * 60, // 7 days on promotion
  semanticInitialSeconds: 365 * 24 * 60 * 60, // 1 year expiration (fee-model defensive)
  /**
   * Document Tier starting lease — DURABLE. A user's own note is the substrate,
   * not ephemeral telemetry: "laptop dies → recover from chain" is a lie if the
   * note decayed off-chain first. 1 year (capped per CLAUDE.md "no >1y TTL"),
   * reinforced on recall/citation like every other tier.
   */
  documentInitialSeconds: 365 * 24 * 60 * 60, // 1 year (durable, reinforced on use)
  /** Citations needed to promote working → episodic. */
  promoteToEpisodic: 2,
  /** Citations needed to trigger LLM distillation to semantic. */
  promoteToSemantic: 5,
  /** Distinct sessions required for semantic promotion. */
  distinctSessionsForSemantic: 3,
} as const;

/**
 * SEDM-fusion utility-weight parameters (docs/research/2026-05-23-sedm-fusion-design.md).
 *
 * The hot loop computes a free proxy utility Û(m) per citation, evolves a
 * per-memory weight w via SEDM's update, scales the on-chain lease by w, and
 * fuses w into recall ranking. Replaces the crude flat "+24h per citation".
 *
 *   Û(m) = sigRecency·r + sigCoCite·c + sigRank·g + sigOutcome·o   (∈ [0,1])
 *   w_{t+1} = clamp(w_t + alpha·Û − beta·f_use, 0, wMax)
 *   reinforcementSeconds = round(base · (1 + gamma·clamp(w)))
 *   recallScore = rabitqInnerProduct · clamp(w, wMin, wMax)
 */
export const UTILITY = {
  alpha: 0.6, // utility learning rate
  beta: 0.1, // metabolic / anti-spam penalty per use
  gamma: 0.5, // lease sensitivity to weight
  wMax: 4.0, // weight ceiling (bounds lease growth → no fee runaway)
  wMin: 0.2, // recall floor (cold-start memories still surface)
  wInit: 1.0, // default weight for un-scored memories (recall-neutral)
  recencyTauMs: 6 * 60 * 60 * 1000, // 6h recency decay constant
  // Proxy-Û signal weights (sum to 1).
  sigRecency: 0.3,
  sigCoCite: 0.2,
  sigRank: 0.2,
  sigOutcome: 0.3,
  /** Default outcome signal when act() carries no explicit success flag. */
  defaultOutcome: 0.5,
} as const;

/**
 * Synaptic Market parameters. Pricing is illustrative for the walkthrough — adjust based on
 * Arkiv's GLM fee resolution (currently unresolved per docs/Arkiv.md §3.1 Flaw 4).
 *
 * `contractAddress` reads from MARKET_CONTRACT_ADDRESS at module load. When the
 * env var is missing we fall back to the zero address so the seeded agents can
 * detect that and short-circuit to a no-op handle instead of trying to spend
 * GLM into a sink. The judge runner should `deploy SynapticMarket.sol` and set
 * MARKET_CONTRACT_ADDRESS=0x… in .env before starting the agents.
 */
export const MARKET_ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

export const MARKET = {
  defaultListingPriceWei: 5_000_000_000_000_000n, // 0.005 GLM equivalent (judge)
  /** Number of seeded competitor agents for the walkthrough. */
  seededAgentCount: 3,
  /**
   * SynapticMarket Solidity escrow address. Set via MARKET_CONTRACT_ADDRESS
   * env var; falls back to the zero address so the seeded agents can detect
   * the "not deployed" state and idle gracefully.
   */
  contractAddress: ((process.env["MARKET_CONTRACT_ADDRESS"]?.toLowerCase() ??
    MARKET_ZERO_ADDRESS) as `0x${string}`),
} as const;

/**
 * Session authorization parameters. Bounds the trusted-relayer surface.
 * Per docs/ERC.md §2.1: defaults align with EIP-3009 patterns.
 */
export const SESSION = {
  defaultValidDurationSeconds: 4 * 60 * 60, // 4 hours
  defaultMaxWrites: 1000,
  /** Domain separator for deterministic key derivation. Single source: derivation-message.ts. */
  keyDerivationDomain: KEY_DERIVATION_DOMAIN,
} as const;
