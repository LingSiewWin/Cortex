/**
 * Cortex — pinned project-wide constants.
 *
 * Per arkiv-best-practices SKILL §1: every entity create and every query MUST include
 * PROJECT_ATTRIBUTE. Without it, queries leak data from other projects in the shared DB.
 *
 * Per CLAUDE.md "Pinned facts": do not change without explicit user approval.
 */

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
  /** Citation record — links an act() call to the memory IDs it relied on. */
  CITATION: "citation",
  /** Synaptic Market listing — encrypted payload + public tags. */
  LISTING: "listing",
  /** Decryption grant — emitted when a buyer pays the listing price. */
  GRANT: "grant",
} as const;

export type EntityType = (typeof ENTITY_TYPE)[keyof typeof ENTITY_TYPE];

/**
 * Reinforcement parameters for the Darwinian engine. Per CLAUDE.md "Accumulative extend":
 *   new_btl_seconds = remaining_seconds + REINFORCEMENT_SECONDS
 *
 * 24h reinforcement is the working baseline. Tier promotions multiply this:
 *   working → episodic: +7 days
 *   episodic → semantic: distilled to a rule entity with 1-year initial TTL
 */
export const REINFORCEMENT = {
  initialWorkingSeconds: 60 * 60, // 1 hour
  workingReinforcementSeconds: 24 * 60 * 60, // 24 hours per citation
  episodicReinforcementSeconds: 7 * 24 * 60 * 60, // 7 days on promotion
  semanticInitialSeconds: 365 * 24 * 60 * 60, // 1 year (fee-model defensive)
  /** Citations needed to promote working → episodic. */
  promoteToEpisodic: 2,
  /** Citations needed to trigger LLM distillation to semantic. */
  promoteToSemantic: 5,
  /** Distinct sessions required for semantic promotion. */
  distinctSessionsForSemantic: 3,
} as const;

/**
 * Synaptic Market parameters. Pricing is illustrative for the demo — adjust based on
 * Arkiv's GLM fee resolution (currently unresolved per docs/Arkiv.md §3.1 Flaw 4).
 */
export const MARKET = {
  defaultListingPriceWei: 5_000_000_000_000_000n, // 0.005 GLM equivalent (demo)
  /** Number of seeded competitor agents for the demo. */
  seededAgentCount: 3,
} as const;

/**
 * Session authorization parameters. Bounds the trusted-relayer surface.
 * Per docs/ERC.md §2.1: defaults align with EIP-3009 patterns.
 */
export const SESSION = {
  defaultValidDurationSeconds: 4 * 60 * 60, // 4 hours
  defaultMaxWrites: 1000,
  /** Domain separator for deterministic key derivation. */
  keyDerivationDomain: "CORTEX_KEY_DERIVATION_v1",
} as const;
