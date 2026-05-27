# Synapse — ERC Composition Research (Multi-Agent Debate)

**Corpus:** `/docs/ERC/erc-knowledge-base/` — 583 ERCs indexed
**Methodology:** 4 specialist agents in parallel (Identity/Auth, Storage/Data, Sessions/Signatures, AI-Agent-Specific) → 1 red-team agent debate → synthesis below
**Date:** 2026-05-20
**Context:** Synapse — agent memory engine on Arkiv L3 with TurboQuant/RaBitQ compression, EIP-712 session keys, local SQLite mirror, 3-tier biological consolidation. See `/docs/idea.md`.

---

## 0. TL;DR — the 6-ERC ship-now stack

After 4 specialist briefs + red-team adversarial review, the ship list collapses from 15+ proposed standards to **six**:

| # | ERC | Status | Role | Person-days |
|---|---|---|---|---|
| 1 | **EIP-712 + ERC-5267** | Final | Typed session-authorization signature + discoverable domain | 1.5 |
| 2 | **ERC-1271 + ERC-6492** | Final | Signature validation for smart-contract wallets + counterfactual | 0.5 |
| 3 | **ERC-4361 (SIWE)** | Final | One-prompt login that pairs with session-key issuance | 0.5 |
| 4 | **ERC-5792** (`wallet_sendCalls` / `getCapabilities`) | Final | Feature-detect what user's wallet can batch/sponsor; degrade gracefully | 1 |
| 5 | **ERC-5169** (`scriptURI`) | Final | Tiny Synapse registry points at the SQLite-mirror replay script — chain-native sovereignty proof | 0.5 |
| 6 | **ERC-8004 event-shape mimicry** (not dependency) | Draft | Emit `Registered`/`MetadataSet` events from a 50-line custom registry — forward-compatible if 8004 wins, free to swap if 8122 wins | 1 |

**Total ERC-touching budget: ~10 person-days** (excluding the relayer service and SQLite daemon, which are application code, not ERC integration). All six are Final status (except deliberately-mimicked-not-implemented ERC-8004). Zero new infrastructure required on Arkiv Braga.

**Explicitly dead** (cut for concrete technical reasons, not aesthetics): ERC-7857, ERC-6551, ERC-2535 (Diamonds), ERC-4337, ERC-7702 (until Braga tx-type-4 is verified), ERC-2771, ERC-7715/7710, ERC-8001, ERC-8183, ERC-7683.

---

## 1. The load-bearing constraint that killed half the picks

The four Phase 1 specialists each produced careful analyses of agent-identity, storage, session, and AI-agent ERCs in isolation. **None of them internalized the Arkiv ground truth** from `/docs/idea.md` §C.1:

> **Arkiv's "EntityRegistry" is not a Solidity contract.** Empirical RPC tests on Braga:
> - `0x4400...0044` (architecture doc's claimed address) → 0 bytes of code
> - `0x4200...0044` (OP-Stack convention) → uninitialized proxy
> - `0x00000000000000000000000000000061726b6976` (last 5 bytes spell "arkiv") → **the actual registry; all 1,054 Arkiv events in the last 5,000 blocks emit from here**
>
> **It's a Rust precompile inside op-reth, not a Solidity contract.** Wire format is **brotli-compressed RLP** (legacy "golembase" format), not ABI calldata. The Solidity `EntityRegistry.sol` in `arkiv-contracts` is the *future*, not the *present*.

This wrecks several Phase 1 recommendations:

- **ERC-2771 (trusted forwarder).** Pattern applies to EVM contracts that implement `_msgSender()`. The Arkiv precompile is Rust; it has no concept of `_msgSender()`. ERC-2771 cannot make Arkiv writes "invisible." It can only forward to *intermediate EVM helpers Synapse deploys*.
- **ERC-6551 (token-bound accounts).** A smart-contract account can't easily emit the brotli-RLP transaction envelope the precompile expects — the op-reth ExEx loop watches L2 blocks for "Arkiv-flavored" transactions from EOAs, not for internal contract calls. The "memory follows the NFT via 6551" architecture is unbuildable on Braga today.
- **ERC-4337 paymaster** (account abstraction). No bundler is deployed on Braga. Adding one is a 2-week yak shave for a hackathon.
- **ERC-7702 (EOA delegation).** Whether Braga's op-reth accepts `0x04` transaction type is undocumented. Until you've broadcast one and watched it land, **do not assume EIP-7702 works on Arkiv.** Same goes for 7702 derivatives (ERC-7821, ERC-7779).

What survives are the ERCs that operate at the *off-chain signing* layer and the *Synapse-deployed helper contract* layer — not the Arkiv write path itself. **The Arkiv precompile is not addressable by EVM contract patterns.** A relayer-style backend that holds a session-key EOA and submits brotli-RLP directly is the only path that works today.

This is what the red-team agent surfaced and what makes the final 6-ERC stack so different from what each Phase 1 specialist would have shipped in isolation.

---

## 2. Ship-now stack — full justification

### 2.1 EIP-712 + ERC-5267 — typed session signatures

**The foundation.** Every Phase 1 agent picked EIP-712. Adoption: universal. The novelty in the stack is pairing it with ERC-5267 (`eip712Domain()`), Final since 2022, so wallets and downstream tools can *discover* Synapse's domain instead of hard-coding the verifying contract address.

**The typed struct** (from Agent 3, refined):

```typescript
const types = {
  SessionAuthorization: [
    { name: "user",            type: "address" },  // signer / Arkiv owner
    { name: "sessionKey",      type: "address" },  // ephemeral EOA held by Synapse
    { name: "scope",           type: "bytes32" },  // keccak256("arkiv.write") — capability tag
    { name: "entityNamespace", type: "bytes32" },  // restrict to user's Arkiv subtree
    { name: "maxWrites",       type: "uint256" },  // hard cap on write count
    { name: "validAfter",      type: "uint256" },  // unix seconds
    { name: "validBefore",     type: "uint256" },  // unix seconds (now + 4h typical)
    { name: "nonce",           type: "bytes32" },  // random — supports cancellation
  ],
};
```

Pattern borrowed from ERC-3009 (`validAfter` / `validBefore` / `bytes32 nonce`) — battle-tested by USDC. Allows out-of-order cancellation by burning the nonce.

**ERC-5267 interface (from `/docs/ERC/erc-knowledge-base/ercs/erc-5267.md` lines 17–20):**
```solidity
function eip712Domain() external view returns (
  bytes1 fields, string name, string version, uint256 chainId,
  address verifyingContract, bytes32 salt, uint256[] extensions
);
event EIP712DomainChanged();
```

**Person-days: 1.5.** OpenZeppelin's `EIP712Upgradeable` covers both.

### 2.2 ERC-1271 + ERC-6492 — signature validation that doesn't break Safe/CB Smart Wallet users

The pitch claims "memory you own, portable across any tool that reads Arkiv." If ~15% of judge users show up with a Safe or Coinbase Smart Wallet and `ecrecover` fails on their session authorization, the walkthrough dies. ERC-1271 (Final, universal smart-wallet adoption) handles smart-contract signers; ERC-6492 (Final) handles counterfactual smart wallets that haven't been deployed yet (Coinbase Smart Wallet first-time users).

**ERC-1271 interface** (`/docs/ERC/erc-knowledge-base/ercs/erc-1271.md` lines 17–23):
```solidity
function isValidSignature(bytes32 _hash, bytes memory _signature)
    public view returns (bytes4 magicValue);  // returns 0x1626ba7e on success
```

**ERC-6492 magic suffix** (`/docs/ERC/erc-knowledge-base/ercs/erc-6492.md`):
```
0x6492649264926492649264926492649264926492649264926492649264926492
```

**Implementation:** use OpenZeppelin's `SignatureChecker.isValidSignatureNow(signer, hash, sig)` or viem's `verifyTypedData` — both handle the EOA / 1271 / 6492 fork transparently. **Person-days: 0.5.**

### 2.3 ERC-4361 (SIWE) — one-prompt login

The session-key authorization signature is functional but renders as opaque hex in some wallets. SIWE (Final, used by every web3 auth library) renders as plain English:

```
synapse.app wants you to sign in with your Ethereum account:
0xUser...

Authorize Synapse session for 4 hours, max 1000 writes
URI: https://synapse.app
Version: 1
Chain ID: <arkiv-l3-chain-id>
Nonce: 0xab...
Issued At: 2026-05-20T...
Expiration Time: 2026-05-20T...
Resources:
- arkiv://synapse/<userId>
```

Pairs naturally with the EIP-712 session-key issuance — SIWE for the human-readable consent, EIP-712 for the structured authorization the relayer enforces. **Person-days: 0.5** with `siwe-viem`.

### 2.4 ERC-5792 — capability discovery

`wallet_getCapabilities` lets the dapp probe what the user's wallet actually supports — atomic batch, paymaster sponsorship, session-key issuance — and degrade gracefully. The red-team agent flagged this as the single most-important ERC that all four specialists missed.

Why it matters: the four Phase 1 agents debated ERC-7715 vs custom EIP-712 vs ERC-7702 *abstractly*. But the realistic answer at the wallet boundary in May 2026 is: **detect at runtime, branch.** Coinbase Smart Wallet supports atomic batching; MetaMask Extension does in newer builds; Rabby varies. Hard-coding any single path locks out a chunk of judge users.

**Pattern:**
```typescript
const caps = await provider.request({
  method: "wallet_getCapabilities",
  params: [userAddress]
});

if (caps.atomicBatch?.supported) {
  // Batch: SIWE login + session-key seed transfer in one prompt
  await provider.request({ method: "wallet_sendCalls", params: [...] });
} else {
  // Fall back to two sequential prompts
  await signSIWE();
  await signSessionAuth();
}
```

**Person-days: 1.**

### 2.5 ERC-5169 — `scriptURI()` makes the SQLite mirror chain-native

**The sleeper pick.** None of the four Phase 1 agents named it. The interface (`/docs/ERC/erc-knowledge-base/ercs/erc-5169.md`):
```solidity
function scriptURI() external view returns (string[] memory);
```

The pitch's Pillar 4 is the local SQLite event mirror — the "data sovereignty" story. ERC-5169 (Final, TokenScript ecosystem) lets a contract publish URIs to a *client-side replay script*. For Synapse, the `SynapseAgentRegistry` contract publishes `scriptURI = ["ipfs://...synapse-mirror.js", "https://github.com/.../synapse-mirror.js"]` pointing to the SQLite-mirror replay logic. Any wallet, explorer, or third-party tool that supports 5169 can auto-fetch and run the replay to render rich memory views — without trusting Synapse's backend.

This is the *judge-defensible* version of "your memory works without us." Anyone can reconstruct the mirror from chain events using a script the chain itself canonically points at.

**Person-days: 0.5** (one view function returning a static array; host the script as an IPFS pin + GitHub raw URL fallback).

### 2.6 ERC-8004 — event shape only, never a dependency

ERC-8004 (Trustless Agents Registry, Draft, created 2025-08-13, authors from EF/MetaMask/Google/Coinbase) is the most-debated ERC in the brief. Agent 4 called it MUST-HAVE; Agent 1 rated YELLOW; the red team called it neither.

**The resolution:** mimic the event shape, take no hard dependency.

ERC-8004's load-bearing events (`/docs/ERC/erc-knowledge-base/ercs/erc-8004.md`):
```solidity
event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
```

A 50-line `SynapseAgentRegistry.sol` (Ownable, no proxy) emits these events with this exact shape on:
- First session for a wallet → `Registered(agentId, "arkiv://synapse/<userId>", owner)`
- Tier promotion / settings change → `MetadataSet(agentId, "memoryRoot" | "tier" | "model", ...)`
- Agent migration → `URIUpdated(agentId, newURI, updatedBy)`

**Why this works:** if ERC-8004 wins, the events already match — any 8004 indexer reads Synapse for free. If competing ERC-8122 wins, swap the registry implementation; events are cheap. If both go Stagnant in 6 months, Synapse loses nothing because it never depended on a spec, only on its event shape.

**Risk:** ERC-8004 is 9 months old, Draft, with a competing draft (ERC-8122 by Prem Makeig, created 2025-12-17). Two competing drafts ≠ converged ecosystem. Treat 8004 as marketing/positioning, not infrastructure.

**Person-days: 1** to write and deploy the tiny registry. Skip Diamonds, skip 6551, skip 7857 — none are needed.

---

## 3. The debate — major contradictions resolved

### 3.1 ERC-7857 (AI Agents NFT with Private Metadata)

| Agent | Verdict | Reasoning |
|---|---|---|
| Identity (Agent 1) | **RED** | Conflates identity with encrypted metadata; ERC-8004 does identity better |
| Storage (Agent 2) | **GREEN at agent level** | The "transferable mind" primitive done right |
| AI (Agent 4) | **GREEN for private memory** | TEE-verified ownership transfer is the right encryption model |
| **Red team** | **DEAD** | Requires `TransferValidityProof[]` via TEE oracle; no TEE oracle deployed on Braga; stub verifier is a credibility liability |

**Resolution: Agent 1 was right.** ERC-7857's interface (`/docs/ERC/erc-knowledge-base/ercs/erc-7857.md`):
```solidity
function iTransfer(address _to, uint256 _tokenId, TransferValidityProof[] calldata _proofs) external;
function verifier() external view returns (IERC7857DataVerifier);
function teeOracleVerify(bytes32 messageHash, bytes memory signature) internal view returns (bool);
```

Every transfer path requires a `TransferValidityProof` validated by a TEE oracle or ZK verifier configured per `AttestationConfig[]`. **No such oracle exists on Arkiv Braga.** Shipping with a stub verifier that always returns `true` is worse than not shipping the ERC at all — any judge familiar with 7857 will see through it instantly. Cut.

Additionally: ERC-7857 conflates *agent identity* (which ERC-8004 already does) with *encrypted metadata transfer* (which Synapse doesn't need — Arkiv attributes are public-by-default and queryable, that's the point). Forcing memory into the NFT envelope fights Arkiv's design.

### 3.2 ERC-6551 (Token Bound Accounts) — the "transferable mind" architecture

| Agent | Verdict |
|---|---|
| Storage (Agent 2) | **GREEN — keystone** of the transferable-mind architecture |
| AI (Agent 4) | Not included in 5-ERC composition (implicit NO) |
| **Red team** | **DEAD on technical grounds** |

**Resolution: Agent 4 was implicitly correct.** Two killers:

1. **The transferable-mind narrative isn't actually in the Synapse pitch.** The pitch optimizes for *cost + sovereignty + UX*, not asset-style transfer. There's no judge flow where Alice sells her agent to Bob. Gifting/selling is a v3 feature at most.
2. **Even if the narrative were in scope, 6551 accounts can't speak brotli-RLP to the Arkiv precompile.** Per `/docs/idea.md` §C.1, the precompile is registered at the op-reth ExEx layer and watches for L2 blocks containing Arkiv-flavored transactions from EOAs. A smart-contract account submitting `CALL` opcodes doesn't produce that envelope. The "memory follows the NFT" flow Agent 2 sketched requires Arkiv to expose a Solidity adapter contract that wraps the precompile — that adapter doesn't exist yet.

If transferability is ever needed, the right primitive is Arkiv's native `TRANSFER` op (op code 4 in `arkiv-contracts/src/lib.rs`) — change ownership of the entity directly. No NFT layer, no 6551 indirection. Cut.

### 3.3 ERC-8004 (Trustless Agents) — MUST-HAVE or YELLOW

| Agent | Verdict |
|---|---|
| Identity (Agent 1) | **YELLOW** — Draft + young, implement minimal slice |
| AI (Agent 4) | **MUST-HAVE** — identity backbone, EF/MetaMask/Google/Coinbase backing |
| **Red team** | **Event-shape only — never a dependency** |

**Resolution: Red team correct.** Heavyweight authorship is a signal of *intent*, not of *stable spec*. A 9-month-old Draft with a competing 5-month-old Draft (ERC-8122) means the ecosystem hasn't picked a winner. Synapse should not gate on either. Mimicking the event shape gives forward compatibility at zero risk.

The Agent 4 framing of "8004 as identity backbone" also mis-positions 8004 itself: 8004 is a *reputation + validation + cross-agent-discovery* registry, not a user-to-agent identity protocol. Synapse's single-user product doesn't need the reputation half.

### 3.4 Session keys — ERC-7715 vs custom EIP-712

| Agent | Verdict |
|---|---|
| Identity (Agent 1) | ERC-7715 + ERC-7710 + Delegation Framework eventually; EIP-712 today |
| Sessions (Agent 3) | **Custom EIP-712 for hackathon; ERC-7715 for v2** |
| **Red team** | **Agent 3 correct** — ERC-7715's `DelegationManager` isn't deployed on Braga |

**Resolution: Agent 3 wins.** ERC-7715's `wallet_requestExecutionPermissions` returns a `permissionsContext` that must be redeemed via a `DelegationManager` contract. MetaMask's canonical DelegationManager is deployed on mainnet + a few major L2s — **not on Arkiv Braga**. Deploying it ourselves is a 3-week integration with audit risk.

Custom EIP-712 sessions (the ocean pattern) work on every wallet today with zero new infrastructure. Ship them. Migrate to 7715 when (a) the wallet ecosystem unifies and (b) Braga has a deployed DelegationManager.

### 3.5 ERC-2771 vs EIP-7702 — invisible write path

| Agent | Verdict |
|---|---|
| Identity (Agent 1) | EIP-7702 + ERC-7821 delegated execution |
| Sessions (Agent 3) | ERC-2771 trusted forwarder |
| **Red team** | **Neither works for the Arkiv write itself** |

**Resolution: Both agents were partially right but solving the wrong layer.** The Arkiv precompile isn't an EVM contract — it doesn't implement `_msgSender()` (kills 2771) and Braga's tx-type support for 7702's `0x04` is unverified. The actual invisible-write path is:

1. User signs EIP-712 `SessionAuthorization` (one prompt).
2. Synapse backend holds a session-key EOA funded with a tiny amount of Arkiv gas token.
3. The session-key EOA submits brotli-RLP transactions directly to the precompile via the Arkiv SDK.

This is plain EIP-712 + a backend relayer holding an EOA. Not 7702, not 2771, not 4337. Both Phase 1 agents were anchored on EVM-contract patterns; the precompile isn't one.

ERC-2771 still applies to *intermediate EVM helpers Synapse deploys* (e.g., the agent registry). Useful as a pattern for those. But it doesn't make Arkiv writes invisible — only the EIP-712 session + backend relayer does.

---

## 4. Sleepers — ERCs the specialists almost missed

The red-team agent found 5 ERCs none of the four specialists named. Two are GREEN for the ship-now stack:

### 4.1 ERC-5792 — wallet_sendCalls + getCapabilities — **GREEN, included in stack**

The single most important runtime primitive of 2025–2026. Already covered in §2.4.

### 4.2 ERC-5169 — scriptURI for token contracts — **GREEN, included in stack**

The sleeper that makes the SQLite mirror story chain-native. Already covered in §2.5.

### 4.3 ERC-1167 — Minimal Proxy / Clone — **YELLOW for v2**

Final, universal. `function clone(address implementation) external returns (address)`. Only matters if Synapse adopts per-user agent contracts (one tiny `SynapseAgent` per user with EIP-712 domain separation). Default to a single shared registry; revisit only if per-user isolation is needed.

### 4.4 ERC-6909 — Minimal Multi-Token Interface — **YELLOW for v2 UI gamification**

Final. The minimalist alternative to ERC-1155, used as foundation of competing ERC-8122. If Synapse adds memory-tier badges (working/episodic/semantic as soulbound tokens for UI flair), 6909 is the right primitive — smaller surface than 1155, no callbacks, no batching. Only if we add gamification later.

### 4.5 ERC-7943 — `canTransfer` policy hook pattern — **YELLOW (pattern, not literal adoption)**

Last Call. The relevant pattern, not the literal RWA use case: a small `canExtend(entityKey, msgSender, newExpiresAt)` adapter that the session-key relayer consults *before* submitting brotli-RLP extends. Encodes tier-promotion policy (working → episodic → semantic) on-chain as data, not as backend logic. Worth implementing if consolidation policy becomes complex enough to need verifiable on-chain rules.

---

## 5. Skip list with reasoning

### 5.1 Cut for the walkthrough (concrete technical reasons)

| ERC | Why cut |
|---|---|
| **ERC-7857** | TEE oracle not deployed on Braga; stub verifier is a credibility liability; conflates identity with encrypted metadata |
| **ERC-6551** | Smart-contract account can't speak brotli-RLP to the precompile; transferable-mind story isn't in the pitch |
| **ERC-2535 (Diamonds)** | Weeks of yak-shaving for a registry that's 80 lines of Solidity |
| **ERC-4337** | No bundler on Braga; 7702 ate the AA roadmap |
| **ERC-7702** | Braga tx-type-4 support is unverified — DON'T BET ON IT |
| **ERC-7821** | Batch executor on a 7702 delegate we're not deploying |
| **ERC-7779** | Only matters if using 7702 (which we're not) |
| **ERC-2771** | Forwarder pattern requires `_msgSender()`; precompile doesn't implement it |
| **ERC-7715 + 7710** | DelegationManager not deployed on Braga; ship custom EIP-712 sessions |
| **ERC-8001** | KB says Final but spec is months old; multi-party agent coordination Synapse doesn't need at single-user MVP |
| **ERC-8183** | Job/escrow lifecycle; Synapse isn't an agent marketplace |
| **ERC-7683** | Cross-chain intents; Synapse is single-chain |
| **ERC-7992 (ZKML)** | LLM inference proofs cost-prohibitive in 2026 |
| **ERC-8033 (Oracle Councils)** | Solving a problem Synapse doesn't have |
| **ERC-8107 (ENS Trust)** | Synapse agents don't all have ENS names |
| **ERC-7506 (Hint Registry)** | Solving a problem Synapse doesn't have |
| **ERC-6147 (NFT Guard)** | Memory isn't an NFT |
| **ERC-7496 (Dynamic Traits)** | Same — memory isn't an NFT |
| **ERC-4626 (Vault)** | Treasury-funded renewal is v2 |

### 5.2 Cut for non-technical reasons

| ERC | Why cut |
|---|---|
| **ERC-7521 (General Intents)** | Wallet-side intent abstraction; not agent-to-agent |
| **ERC-3475 (Storage Bonds)** | DeFi-bond complexity for a feature users don't want |
| **ERC-7726 (Oracle)** | Asset-pricing oracle; wrong axis |
| **ERC-7662 (AI Agent NFTs)** | Strictly dominated by ERC-7857 (which is itself dead) |
| **ERC-7913 (Universal Sig Verifier)** | For passkey-derived signers; Synapse uses EOA session keys |
| **ERC-5630 (Encryption KDF)** | `eth_getEncryptionPublicKey` deprecated by MetaMask 2024 |
| **ERC-7920 (Merkle EIP-712)** | Premature optimization; one signature is fine |
| **ERC-1271 grief mitigation patterns** | Use `SignatureChecker` from OpenZeppelin; don't reinvent |
| **ERC-7572 (contractURI)** | Branding metadata; can add in 1 line if needed |
| **ERC-2477 (Token Metadata Integrity)** | Stagnant; coreHash exposure isn't load-bearing |
| **ERC-5008 (NFT Nonce)** | Memory isn't an NFT |
| **ERC-7641 (Revshare tokens)** | Monetization is v3 |
| **ERC-1155** | Memory isn't a token |

---

## 6. Trust assumptions to disclose honestly

The ship-now stack works today on Arkiv Braga. But three trust assumptions deserve explicit disclosure in the README — judges will ask, and pre-empting is stronger than dodging:

1. **The session-key relayer is a trusted intermediary.** Until ERC-5792 atomic-batch + a real on-chain DelegationManager exist on Braga, Synapse's backend holds the session EOA and the user trusts that backend not to abuse it. The EIP-712 authorization bounds the scope (`maxWrites`, `validBefore`, `entityNamespace`) but does not eliminate the trust. Statement to include: *"In v1, Synapse runs a trusted relayer that holds your session key. In v2 (when Braga supports EIP-7702 or has a DelegationManager deployed), the relayer becomes either an on-chain delegate or unnecessary."*

2. **The ERC-8004-shaped event registry is cosmetic forward-compatibility, not a real 8004 implementation.** Synapse doesn't implement reputation, validation, or feedback flows. It just emits 8004-shaped events so if 8004 wins the ecosystem race, the data is already in the right format. Statement: *"Synapse mimics ERC-8004 event signatures for forward compatibility. The full 8004 reputation/validation stack is out of scope for v1."*

3. **The SQLite mirror is single-host in the walkthrough.** The pitch's sovereignty story requires that the mirror is self-runnable by any user. Ship the script via IPFS pin (referenced via ERC-5169 `scriptURI`) and verify the daemon is reproducible. Statement: *"Synapse's local mirror replays public chain events. Anyone can run a clean instance with the published script — verified by including the mirror's hash in the registry's `scriptURI`."*

---

## 7. v2 / future map

When the ecosystem catches up, swap-ins:

| Ship-now | v2 upgrade | Trigger |
|---|---|---|
| EIP-712 session + backend relayer | EIP-7702 + ERC-7821 delegated execution | Braga publishes tx-type-4 support |
| EIP-712 session + backend relayer (alt path) | ERC-7715 + ERC-7710 + DelegationManager | Canonical DelegationManager deployed on Braga |
| ERC-8004-shaped events | Real ERC-8004 registry integration | ERC-8004 reaches Final and reference impl exists |
| Custom session-key relayer for `extendEntity` | Treasury-funded renewal via ERC-4626 vault | Arkiv ships "unpermissioned extension" + ERC-4626 vault for pooled funds |
| Single shared registry | ERC-1167 cloned per-user agent contracts | When per-user isolation matters |
| No on-chain consolidation policy | ERC-7943 `canExtend` policy hook | When promotion rules grow beyond what backend logic should hold |
| (Nothing) | ERC-6909 memory-tier badges | When UI gamification is added |

Explicitly *never*: ERC-7857 (wrong shape), ERC-6551 (precompile incompatibility), ERC-2535 (overhead).

---

## 8. The four-agent landscape (preserved for reference)

For full traceability, the four Phase 1 agents reached these recommended compositions before the red-team debate collapsed them:

| Agent | Recommended composition (their version) |
|---|---|
| Identity/Auth | **EIP-7702 + ERC-7821 + ERC-1271** (+ ERC-8004 for identity) |
| Storage/Data | **ERC-7857 (agent NFT) + ERC-6551 (token-bound account) + ERC-6147 (guard) + ERC-4906 (metadata events) + ERC-7201 (storage layout)** |
| Sessions/Signatures | **EIP-712 + ERC-1271 + ERC-2771** (+ ERC-4361 SIWE, ERC-7821 batching) |
| AI-Agent-Specific | **ERC-8004 + ERC-7857 + ERC-8001 + ERC-2535 + ERC-3668** |

The red-team agent killed most of these picks for one of three reasons:
1. **Precompile incompatibility** (Arkiv isn't a Solidity contract) — killed 7702-derivatives, 2771, 6551
2. **Infrastructure that doesn't exist on Braga** — killed 4337, 7715/7710, 7857's TEE oracle
3. **Spec immaturity / overengineering for hackathon scope** — killed 2535, 8001, 8183, 7683

The convergent picks across multiple agents that survived: **EIP-712, ERC-1271, ERC-6492, ERC-4361 (SIWE)**. These plus the red-team's two sleepers (ERC-5792, ERC-5169) plus event-shape-only ERC-8004 = the final six.

---

## 9. Sources

**Per-agent briefs (this session, May 2026):**
- Identity/Auth specialist (agent ID `a8ecc75fae1c77968`) — 73k tokens, 41 tool calls
- Storage/Data specialist (`aa3045ccd52416712`) — 87k tokens, 41 tool calls
- Sessions/Signatures specialist (`a1f13ee5ba78f985e`) — 66k tokens, 43 tool calls
- AI-Agent-Specific (`aebd485d33b42e156`) — 109k tokens, 68 tool calls
- Red-team debate (`a85d450c9dd3d7515`) — 78k tokens, 13 tool calls

**Key ERC files (full paths):**
- `/docs/ERC/erc-knowledge-base/erc-index.md` — 583 ERCs indexed
- `/docs/ERC/erc-knowledge-base/ercs/erc-1271.md` — smart-account signature validation
- `/docs/ERC/erc-knowledge-base/ercs/erc-4361.md` — SIWE
- `/docs/ERC/erc-knowledge-base/ercs/erc-5169.md` — scriptURI (sleeper)
- `/docs/ERC/erc-knowledge-base/ercs/erc-5267.md` — EIP-712 domain disclosure
- `/docs/ERC/erc-knowledge-base/ercs/erc-5792.md` — wallet capability discovery
- `/docs/ERC/erc-knowledge-base/ercs/erc-6492.md` — counterfactual signature validation
- `/docs/ERC/erc-knowledge-base/ercs/erc-6551.md` — token-bound accounts (cut)
- `/docs/ERC/erc-knowledge-base/ercs/erc-7857.md` — AI agents NFT with private metadata (cut)
- `/docs/ERC/erc-knowledge-base/ercs/erc-8004.md` — trustless agents (event-shape only)
- `/docs/ERC/erc-knowledge-base/ercs/erc-8122.md` — minimal agent registry (competing draft)

**Related Synapse docs:**
- `/docs/idea.md` — Synapse pitch + feasibility validation + protocol-archaeology (the Arkiv precompile finding)
- `/docs/rabitQ.md` — RaBitQ technical brief (the embedding-store compression option)
- `/docs/Turboquant.md` — TurboQuant technical brief (the cold-tier S3-mapping angle)

---

## 10. One-paragraph judge-defense

> *"We picked the standards that work today on Arkiv Braga without new infrastructure. EIP-712 + ERC-5267 + ERC-1271 + ERC-6492 + ERC-4361 cover the signature surface — including counterfactual smart wallets. ERC-5792 lets the dapp adapt to what the user's wallet can actually do. ERC-5169 turns our SQLite-mirror script into a chain-native recovery artifact, which is the sovereignty pitch made concrete. We mimic ERC-8004 event shapes for forward compatibility without taking a hard dependency on a 9-month-old Draft that has a competing draft. We explicitly skipped ERC-7857, ERC-6551, ERC-4337, ERC-7702, ERC-2771, and full ERC-8004 because Arkiv's registry is a Rust precompile that doesn't speak EVM ABI — those standards solve problems that don't exist in this stack yet, or require infrastructure that doesn't exist on Braga today."*

That paragraph survives any judge who reads the Arkiv contract layout.
