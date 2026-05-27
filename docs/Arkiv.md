# Arkiv Network — Protocol Research Notes

> Private research notes. Not for distribution. Sweep of the Arkiv-Network GitHub org and empirical probing of Braga testnet, conducted 2026-05-17 to 2026-05-19.
>
> Purpose: capture ground truth about how the protocol actually behaves (vs how docs claim it behaves), to inform an AI-agent memory product built on Arkiv for the ETHNS Builder Challenge (deadline 2026-05-25).

---

## TL;DR for product design

1. **The Solidity `EntityRegistry` contract in `arkiv-contracts` is NOT deployed on Braga.** The on-chain registry is a Rust precompile at `0x00000000000000000000000000000061726b6976` ("arkiv" in ASCII) running inside op-reth. It accepts brotli-compressed RLP, not ABI calldata. The Solidity source is the *future* design; the precompile is the *current* implementation. PR `arkiv-sdk-js#64` is the bridge.

2. **Historical recall via `atBlock` is silently broken.** SDK builds and sends the parameter correctly; the server ignores it and always returns latest state. Expired entities are unrecoverable via the public API. Previous design ideas based on "historical-query cold tier" are empirically dead.

3. **`EXPIRE` is automatic.** Every observed EXPIRE on Braga came from the OP-Stack system depositor (`0xdead...0001`) via the L1Block sync path — not from third-party callers. The "anyone can call EXPIRE for free permanence" loophole does not exist in practice.

4. **There is no fee model.** Storage-service architecture doc §9 says "Status: unresolved." CREATEs cost ~29k gas flat. The `pricePerBytePerBlock` model in the legacy spec is aspirational and may never ship.

5. **Effective max `btl` ≈ 272 years** (u32 cap on `btl` and `expiresAt`, 2-second blocks). No `MAX_BTL` guard anywhere — only Solidity 0.8 checked-arithmetic overflow on `currentBlock + btl`. No SDK validates upper bound.

6. **Extend is REPLACE not ADD, owner-only.** `newExpiresAt = currentBlock + btl`, must be strictly greater than `existingExpiresAt`. Cannot stack leases. Cannot delegate.

7. **Agent memory is officially endorsed** as a flagship Arkiv use case (ETHNS Theme 1: "Agents Whose Memory You Actually Own"). Team framing is "memory you own, with expiration" — explicitly NOT permanent. They concede Arweave wins for permanence.

---

## 1. The deployed reality on Braga (empirical truth)

### 1.1 What lives at which address

| Address | Bytecode | Activity |
|---|---|---|
| `0x4400000000000000000000000000000000000044` (claimed predeploy in op-reth code) | 0 bytes | None |
| `0x4200000000000000000000000000000000000044` (OP-Stack convention) | 2,059 bytes — uninitialized `Proxy.sol` | Reverts every call with `"Proxy: implementation not initialized"` |
| **`0x00000000000000000000000000000061726b6976`** | 0 bytes (precompile) | **All 1,054 Arkiv events in last 5,000 blocks come from here** |

The SDK's `src/consts.ts` hardcodes `ARKIV_ADDRESS = "0x00000000000000000000000000000061726b6976"`. The last 5 hex bytes (`61 72 6b 69 76`) spell "arkiv" in ASCII. The actual registry is a **Rust precompile inside op-reth**, not a Solidity contract.

### 1.2 Wire format

- Precompile accepts **brotli-compressed RLP** as calldata, not ABI.
- Every `eth_call` with standard ABI selectors returns errors like `brotli: PADDING_2`, `brotli: RESERVED`, `brotli: unexpected EOF`.
- The SDK's `src/utils/arkivTransactions.ts` confirms: `compress(toRlp([creates, updates, deletes, extensions, ownershipChanges]))`.
- This is the **legacy "golembase" wire format** — Arkiv was previously called Golem DB.

### 1.3 Events emitted on-chain (empirical histogram, last 5,000 blocks)

| Event | Topic 0 | Count | Share |
|---|---|---|---|
| `ArkivEntityCreated(uint256,address,uint256,uint256)` | `0x73dc52f9...` | 880 | 83.5% |
| `ArkivEntityBTLExtended(uint256,address,uint256,uint256,uint256)` | `0x0a5f98a4...` | 172 | 16.3% |
| `ArkivEntityExpired(uint256,address)` | `0xe3dbbcdb...` | 4 | 0.4% |
| `ArkivEntityUpdated(uint256,address,uint256,uint256,uint256)` | `0x7e0bc9ba...` | 2 | 0.2% |
| `ArkivEntityDeleted(uint256,address)` | `0x749d62ef...` | 2 | 0.2% |
| `ArkivEntityOwnerChanged(uint256,address,address)` | `0x7ccdcb52...` | 2 | 0.2% |

These match the SDK's `subscribeEntityEvents.ts` ABI definitions. The `EntityOperation` and `ChangeSetHashUpdate` events declared in the Solidity `IEntityRegistry.sol` appear in **zero** blocks — they are dead declarations in the future-design source.

### 1.4 Live state

- Total live entities on Braga: **186,058**
- Real producer: `block indexer` at at `0xf46e23f6a6f6336d4c64d5d1c95599bf77a536f0` (mirrors Ethereum mainnet block data into Arkiv)
- Modal `btl`: **1,296,000 blocks ≈ 30 days** (real production use)
- Real CREATE gas cost: **~29,000 gas** (flat, no per-byte-per-block scaling)

### 1.5 EXPIRE is system-driven

All 4 observed EXPIRE events were emitted by:
- `from`: `0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001` (OP-Stack system depositor)
- `to`: `0x4200000000000000000000000000000000000015` (L1Block predeploy)
- selector: `0x440a5e20` (`setL1BlockValues`)

**The Arkiv precompile is hooked into the L1Block sync transaction.** When each L2 block updates its L1 reference, the precompile sweeps any expired entities as a side effect. No user has ever called `EXPIRE` on Braga.

Consequence: the architecture doc's claim that `EXPIRE` is "callable by anyone — no ownership check" is technically true at the contract layer, but operationally moot because the system handles it for free. There is no "no eviction bounty" loophole.

### 1.6 Historical queries are broken

The SDK exposes `validAtBlock(N: bigint)` on the query builder. Path:
- `node_modules/@arkiv-network/sdk/src/query/queryBuilder.ts:243` (setter)
- `node_modules/@arkiv-network/sdk/src/query/engine.ts:116-117` (serializes to `{atBlock: hex}` over wire)

Empirical test on Braga:
- Entity `0x75671a2784e926afe8076018051f0196d7413fa03cc0662ea720ce6d011c5ad6` (owner `0xf46e...536f0`) expired at block 594509.
- `arkiv_query("$key = 0x75671a...")` at `latest` → empty
- Same query with `atBlock = 594000` (509 blocks BEFORE expiry) → empty
- Sanity check: query for live entity → returns it correctly
- Test with `atBlock = 1` (genesis) → returned current-state entities with `createdAtBlock = 598442` (impossible if filter worked)
- Test with `atBlock = 0xFFFFFFFF` (future) → `"context cancelled"`

**The server silently ignores the `atBlock` parameter.** This may be unimplemented rather than buggy — but either way, the public API does not support historical recall today.

### 1.7 Archive state is sparse

`eth_getBalance` probes from block 598500 backward:

| Offset | Block | State available? |
|---|---|---|
| -10, -50, -100, -128 | 598490..598372 | Yes |
| -256 | 598244 | **No** ("not supported") |
| -512 | 597988 | Yes |
| -1000 | 597500 | **No** |
| -2000, -5000, -10000, -50000 | down to 548500 | Yes |
| -100000 | 498500 | **No** |
| -200000 | 398500 | Yes |
| -300000, -400000, block 100 | | **No** |

Pattern matches op-reth's snapshot pruning — only specific snapshot blocks plus the last ~128 are queryable. Even if `atBlock` gets fixed, the underlying state isn't reliably preserved for arbitrary historical heights.

---

## 2. The architecture (what the team intended vs what shipped)

### 2.1 Three-layer system per docs

```
SDK / clients
  ↓ standard L3 transaction
EntityRegistry (predeploy on L3)
  ↓ emits events (consumed by ExEx)
arkiv-op-reth (reth fork + Execution Extension)
  ↓ HTTP JSON-RPC
arkiv-storage-service (Go, the "EntityDB")
  ↓ HTTP JSON-RPC
Query clients
```

### 2.2 What's actually deployed

| Layer | Documented as | Currently is |
|---|---|---|
| Contract | Solidity `EntityRegistry` at `0x4400...0044` | Rust precompile at `0x00000000000000000000000000000061726b6976`, accepts brotli-RLP |
| Events | `EntityOperation`, `ChangeSetHashUpdate` | `ArkivEntityCreated/Updated/Expired/Deleted/BTLExtended/OwnerChanged` |
| Wire format | ABI calldata `execute(Operation[])` with selector `0xba8ccf92` | brotli(RLP([creates, updates, deletes, extensions, ownershipChanges])) |
| Op count | 6 (CREATE, UPDATE, EXTEND, TRANSFER, DELETE, EXPIRE) | 5 categories per legacy RLP (no separate TRANSFER) |
| Fee model | `pricePerBytePerBlock × bytes × btl` paid in GLM via `transferFrom` | Not implemented; CREATE is flat ~29k gas |
| Housekeeping | "Periodic process in Go EntityDB" | Inside op-reth's L1Block handler |

### 2.3 Layer 1: `arkiv-contracts` (the future-design Solidity)

Repo: `Arkiv-Network/arkiv-contracts`

Active development by single author `Padraic-O-Mhuiris`. 38 PRs merged Mar 30 – May 8, 2026 (then quiet). The contract was rewritten from scratch over 6 weeks.

Key files:
- `contracts/EntityRegistry.sol` — main entry point with `execute(Operation[])`
- `contracts/Entity.sol` — types, errors, guards, op-code constants
- `contracts/IEntityRegistry.sol` — interface (declares dead events)
- `contracts/types/{BlockNumber32,Ident32,Mime128}.sol` — UDVTs
- `src/{lib,wire,encode,storage_layout}.rs` — Rust bindings consumed by op-reth
- `docs/architecture.md` — current design (truth)
- `docs/entity-registry-spec.md` — legacy design (stale, abandoned; ignore)

Type widths:
- `BlockNumber32` = uint32. Comment: *"uint32 overflows at block ~4.3 billion — ~272 years at 2s blocks, ~136 years at 1s blocks (L2). Sufficient for any foreseeable chain. The small width is intentional: three BlockNumber32s (12 bytes) pack alongside an address (20 bytes) into a single 32-byte storage slot."*
- `btl` typed as `BlockNumber32` (relative); `expiresAt` typed as `BlockNumber32` (absolute). Same width — they share overflow ceiling.
- `Ident32` = bytes32 UDVT, charset `a-z 0-9 . - _`, max 32 bytes, null-terminated
- `Mime128` = struct `{bytes32[4] data}`, fixed 128 bytes, RFC-2045 validated

Operations:
```solidity
uint8 public constant UNINITIALIZED = 0;
uint8 public constant CREATE = 1;
uint8 public constant UPDATE = 2;
uint8 public constant EXTEND = 3;
uint8 public constant TRANSFER = 4;
uint8 public constant DELETE = 5;
uint8 public constant EXPIRE = 6;
```

Validation guards (`Entity.sol`):
- `requirePositiveBtl(btl)` — reverts `ZeroBtl` if `btl == 0`. **Only btl check in the entire system.**
- `requireActive(c)` — reverts if expired (`expiresAt <= currentBlock`). Strict-leq — entity is expired at exactly its expiresAt block.
- `requireExpired(c)` — inverse, for EXPIRE op.
- `requireOwner(key, c)` — reverts `NotOwner` if `msg.sender != c.owner`. Applies to EXTEND, UPDATE, DELETE, TRANSFER.
- `requireExpiryIncreased(key, newExpiresAt, currentExpiresAt)` — reverts `ExpiryNotExtended` if `newExpiresAt <= currentExpiresAt`. **This is what makes extend REPLACE-not-ADD.**

Storage layout (`storage_layout.rs` mirrors `EntityRegistry.sol`):
| Slot | Field |
|---|---|
| 0,1 | OZ EIP712 fallbacks |
| 2 | `mapping(address => uint32) _nonces` |
| 3 | `mapping(bytes32 => Commitment) _commitments` |
| 4 | `mapping(OperationKey => bytes32) _hashAt` |
| 5 | `mapping(TransactionKey => uint32) _txOpCount` |
| 6 | `mapping(BlockNumber32 => BlockNode) _blocks` |
| 7 | `BlockNumber32 _headBlock` |

`Commitment` packs into 3 slots:
- slot 0: `creator(20) | createdAt(4) | updatedAt(4) | expiresAt(4)`
- slot 1: `owner(20)` + padding
- slot 2: `coreHash(32)`

**No `expiresAt → entityKey[]` index** — sweep would require external indexing.

Tests (`test/`): 200+ Foundry tests covering all op types, guards, EIP-712 hashing, the changeSetHash V3 mechanism. Notable:
- `RequirePositiveBtl.t.sol::test_largeBtl_succeeds` only tests btl = 999,999. **No test of `BlockNumber32.wrap(uint32.max)` overflow boundary.**
- `Extend.t.sol::test_extend_sameExpiry_reverts`, `test_extend_lowerExpiry_reverts` — confirms strict-increase
- `ExpiryLifecycle.t.sol::test_expiredEntityCannotBeExtended` — **cannot rescue an expired entity by calling extend**
- `ExpiryLifecycle.t.sol::test_nonOwnerCanExpire` — confirms EXPIRE has no owner check
- `OperationSequencing.t.sol::test_expireThenExtend_reverts` — once expired, gone

### 2.4 Layer 2: `arkiv-op-reth` (the execution client)

Repo: `Arkiv-Network/arkiv-op-reth`

Verdict: **pure pass-through observer** as documented. No expiration resolver, no sweep, no fee logic, no synthesized operations, no scheduler.

Workspace:
- `crates/arkiv-node` — the binary, embeds ExEx
- `crates/arkiv-cli` — operator CLI (`create`, `update`, `extend`, `expire`, `simulate`, `batch`, `inject-predeploy`, etc.)
- `crates/arkiv-genesis` — predeploy bytecode generator

Pinned dep: `arkiv-bindings = { git = "https://github.com/Arkiv-Network/arkiv-contracts.git", rev = "d6ebe18" }`

ExEx loop (`crates/arkiv-node/src/exex.rs`):
```rust
while let Some(notification) = ctx.notifications.try_next().await? {
    match &notification {
        ExExNotification::ChainCommitted { new } => {
            let prior_rolling = prior_rolling_hash(&ctx, new)?;
            let blocks = extract_blocks(new, prior_rolling);
            store.handle_commit(&blocks)?;
            ctx.events.send(ExExEvent::FinishedHeight(new.tip().num_hash()))?;
        }
        ExExNotification::ChainReorged { old, new } => { /* revert + commit */ }
        ExExNotification::ChainReverted { old } => { /* revert only */ }
    }
}
```

One iteration per reth chain notification. No buffering, no retry. ExEx activation requires explicit `--arkiv.db-url <URL>` or `--arkiv.debug` flag.

What's missing:
- **`crates/arkiv-node/tests/` directory does not exist.** No integration tests in-tree. `AGENTS.md`: *"There is no test suite in-tree. Verification today is the manual fixture-driven loop."*
- **CI does not run `cargo test`.** Only `cargo build --release`, `cargo fmt --check`, `cargo clippy`. No bytecode-equality drift check.
- No `MAX_BTL` validation in CLI. `extend --btl <u32>` accepts any value.

CLI `simulate` command (`crates/arkiv-cli/src/simulate.rs`): weighted random op generator. Default weights: `create=4, update=3, extend=2, transfer=1, delete=1`. Generated btls: CREATE in `[30, 299]` blocks, EXTEND in `[50, 400]` blocks. EXPIRE has event-driven priority (any past-expiry entity in pool gets expired before next random op). No long-lived entities are exercised.

Doc/code drift: `docs/architecture.md` shows batch JSON using `"expiresIn": "1h"` (humantime), but `BatchOp` deserializer in `crates/arkiv-cli/src/main.rs` only accepts `"btl": <u32>`. The `judge/fixtures/01-create.json` would fail to parse.

### 2.5 Layer 3: `arkiv-storage-service` (the Go EntityDB)

Repo: `Arkiv-Network/arkiv-storage-service`

This is the query index. Imports go-ethereum as a library (uses StateDB, Trie with HashScheme, PebbleDB). Does NOT run an Ethereum node — no P2P, no mempool, no engine API.

Architecture-doc claim of "background housekeeping process": **does not exist as a goroutine in this repo.** Searches for `housekeep|expir.*goroutine|time.NewTicker|cron|scheduler` return zero hits. The only `go func()` calls are the two HTTP servers.

`processExpire` is just a synonym for delete (`store/ops.go:254-258`):
```go
func processExpire(cs *CacheStore, op *types.ExpireOp) error {
    return deleteEntity(cs, common.Address(op.EntityKey[:20]))
}
```

`ExpireOp` is wire-delivered from op-reth. In production on Braga, op-reth synthesizes EXPIRE ops automatically when the L1Block sync runs (see §1.5).

Storage layout:
- Trie (committed in stateRoot, retained by HashScheme): system account slots (`entity_count`, `annot:K\x00V → bitmapHash`, `id:N → entityAddress`), entity accounts (`codeHash` only).
- PebbleDB (outside trie):
  - `"c" + codeHash` → `RLP(entity)` — **immutable, content-addressed, never deleted on forward path**
  - `"arkiv_bm" + keccak256(bitmap)` → bitmap bytes — same property
  - `"arkiv_annot"`, `"arkiv_id"`, `"arkiv_addr"` — mutable pointers, repopulated from trie on reorg
  - `"arkiv_pairs"` — append-only existence index
  - `"arkiv_root"`, `"arkiv_parent"`, `"arkiv_blknum"` — block index, deleted on reorg only
  - `"arkiv_head"` — canonical head pointer

HashScheme details:
- `triedb.NewDatabase(raw, &triedb.Config{HashDB: &hashdb.Config{CleanCacheSize: 64MB}})` — only HashDB, no PathDB
- `trieDB.Commit(newRoot, false)` — `report=false`, no GC of old nodes
- **All historical state roots are retained** as long as underlying node bytes exist in PebbleDB

**No prune/GC/eviction code exists in the storage service forward path.** The only `Delete` calls are on the revert path (reorg). All immutable PebbleDB entries accumulate forever.

**However:** the architecture-doc property "expired entities live in PebbleDB forever, accessible via historical query" is **not exposed via the public API** because `atBlock` is silently ignored at the query server (see §1.6).

Configuration surface (`cmd/arkiv-storaged/main.go`):
```go
type config struct {
    ChainAddr string `yaml:"chain-addr"`
    QueryAddr string `yaml:"query-addr"`
}
```
Plus flags: `chain-addr`, `query-addr`, `data-dir`, `version`. **That's it.** No `--prune-mode`, no `--keep-history`, no retention horizon flag.

Tests (`integration/full_test.go`, `store/*_test.go`, `query/evaluate_test.go`):
- `TestHistoricalQueries` covers explicit-delete-then-query-at-past-block (works in tests, ignored on live Braga).
- **No test covers create-then-let-expire-then-query-at-past-block.** The behavior is implemented but unverified.
- `TestExtend` shows the storage service receives `Extend.ExpiresAt = 200` as an **absolute** number, while the contract takes a **relative** btl. The ExEx does the conversion.

### 2.6 Layer 4: SDKs

Three SDKs at different stages:

| SDK | Repo | Wire path | Status |
|---|---|---|---|
| JS | `arkiv-sdk-js` | Currently legacy RLP; PR #64 transitions to Solidity ABI | v0.6.8 on npm, active |
| Python | `arkiv-sdk-python` | Legacy RLP only | v1.0.0b2, depends on web3 7.13.x |
| Rust | `arkiv-sdk-rust` | Legacy RLP only | v0.5.0, no bindings dep |

JS SDK `expiresIn` semantics:
- Input is seconds (JS `number` or `bigint`)
- Conversion: `BLOCK_TIME = 2`; sends `btl = ceil(expiresIn / 2)` over wire
- `ExpirationTime` helper: `fromSeconds`, `fromMinutes`, `fromHours`, `fromDays`, `fromWeeks`, `fromMonths`, `fromYears` — all multiply by seconds-per-unit
- **No upper-bound validation.** `fromYears(270)` succeeds; `fromYears(300)` overflows the u32 wire encoding.
- `query.validAtBlock(N)` builder exists and serializes correctly — but server ignores it.

Python SDK btl semantics (`src/arkiv/utils.py:163-185, 756-803`):
- `expires_in` in seconds, required (raises `ValueError` if `None`)
- `to_blocks(seconds=x) = x // 2`
- Update path requires `expires_in` (reset btl on update — different from contract semantics)
- **`at_block` historical query supported in SDK signatures**, propagated to engine

Rust SDK btl semantics (`src/entity/btl.rs:24-66`):
- `BlocksToLive(u64)` — wider than contract `uint32`
- Non-zero check only (`u64::MIN → panic`)
- `From<Duration>::from` does `value.as_secs() / 2`
- Default = `15` (30 seconds)
- `Update.btl` is **mandatory** (`src/tx/ops/update.rs:140-147 → MissingBtl`)

**Net client-side validation across all layers: none caps `btl`.** The effective ceiling is u32 overflow on the wire (~272 years at 2s blocks).

---

## 3. The flaws and the design opportunities

### 3.1 Real flaws for an agent-memory product

#### Flaw 1 — `extend` is REPLACE not ADD
Contract: `newExpiresAt = currentBlock + btl`, must be strictly greater than `c.expiresAt`. Source: `EntityRegistry.sol:350-368`.

If entity has 100 days left and you call `extend(btl = 30 days)`, you **lose the remaining 100 days** — the new lease is just 30 days from now. You cannot stack leases. Each extension must beat the current expiry.

Practical impact: a renewal cron must call `extend` with a btl > remaining-lifetime to make any progress. This gets harder as expiry approaches.

#### Flaw 2 — Only the owner can extend
Source: `Entity.requireOwner` at `EntityRegistry.sol:356`.

No third party can keep someone else's memory alive. So you cannot build:
- A treasury that funds extensions for all agent memories
- A "memory keeper" subscription service
- Delegated renewal via a backend wallet (without holding the owner's key)

The owner's wallet is a single point of failure. Lose the key → memory dies on schedule.

**Roadmap mitigation:** `arkiv-sdk-python/docs/ROADMAP.md` mentions an *"Unpermissioned extension"* creation flag — entity lifetime extendable by anyone, not just the owner. Not yet implemented; no PR/issue tracks it. File one to advocate.

#### Flaw 3 — Historical recall via `atBlock` is broken
Empirically verified (see §1.6). The SDK builds and sends `atBlock` correctly; the server ignores it. Expired entities are unrecoverable via the public API.

**No protocol-layer workaround exists today.** Roll your own indexer or accept the loss.

#### Flaw 4 — Fee model is unresolved and may be retroactive
Storage-service architecture.md §9: *"Status: unresolved."* CREATEs are free today (~29k gas only).

The legacy spec `entity-registry-spec.md` describes `pricePerBytePerBlock × bytes × btl` paid in GLM via `transferFrom` — but this code is not in the deployed contract. Whether/when/how it ships is uncertain. **If it ships retroactively, entities created during the free period could become expensive to retain.**

#### Flaw 5 — Payload is calldata-only
On-chain `coreHash` commits to the payload but does not store its bytes. Bytes live in (a) historical L1 calldata, (b) the storage service's PebbleDB. If `arkiv-storaged` loses data and you don't run your own indexer, only L1 archive nodes can replay it.

**Trust assumption:** Arkiv's "decentralized" pitch currently relies on one Go service operator preserving payload data. The team acknowledges this in their `arkiv-ethns-builder-challenge/AGENTS.md`: *"never describe Arkiv as 'trustless' or 'fully decentralised' — Arkiv launches with centralised sequencers."*

#### Flaw 6 — Massive spec drift
The legacy `docs/entity-registry-spec.md` describes a fundamentally different contract than what was built:

| Spec | Implementation |
|---|---|
| Absolute `expiresAt` parameter | Relative `btl` parameter |
| GLM payment required | No fee |
| Op codes `0..4` | Op codes `1..6`, +1 offset, +TRANSFER |
| `MAX_PAYLOAD_SIZE = 122880` | No payload size check |
| `MAX_STRING_ATTR_SIZE = 1024` | 128-byte fixed-width attribute value |
| Per-op events (`EntityCreated`, etc.) | Single `EntityOperation` event keyed by op type |
| Custom errors `PayloadTooLarge`, `InsufficientGLM` | Different error set |
| `expireEntities(bytes32[])` batch function | Single op type inside `execute([])` |

The legacy spec is **stale and not tracked by any issue.** Treat `docs/architecture.md` as the only source of truth for the *intended future*; treat the live precompile as the only source of truth for *current behavior*.

#### Flaw 7 — Silent ExEx drops on decode failure
`crates/arkiv-node/src/exex.rs:117-123`: malformed-but-on-chain registry tx logs an error and continues. The chain considers it executed; storaged never sees it. Permanent divergence catchable only by log scraping.

#### Flaw 8 — Zero CI test coverage for op-reth ExEx behavior
`AGENTS.md`: *"There is no test suite in-tree."* CI runs `cargo build`, `cargo fmt --check`, `cargo clippy` — no `cargo test`. Reorg semantics, rolling-hash carry-forward, expire-then-recall: all uncovered.

### 3.2 Design opportunities (the "turning point" framing)

#### Opportunity 1 — Writes are essentially free
CREATEs cost ~29k gas flat. No per-byte-per-block storage fee. **Until the fee model lands**, you can be generous with your hot tier. Long btls are free.

#### Opportunity 2 — Auto-eviction is reliable
The system depositor sweeps expired entities every L1Block update. You don't need to build a "garbage collector" — the chain has one.

#### Opportunity 3 — 272-year ceiling is effectively permanent
u32 overflow at ~272 years is far beyond any product timeline. The architectural cap is not a real constraint.

#### Opportunity 4 — Tag-based attribute queries are fast and work
`arkiv_query` at `latest` is the working primitive. Use Arkiv attributes liberally — that's the protocol's actual strength.

#### Opportunity 5 — Agent memory is officially endorsed
ETHNS Builder Challenge Theme 1: *"AI — Agents Whose Memory You Actually Own."* Direct quotes from `arkiv-ethns-builder-challenge/docs/builders-guide.md`:

> *"Most AI agents today store their memory in a vendor-locked vector DB or a local file. Switch agents, lose context. The opportunity here is to build agents whose memory lives on Arkiv — queryable by tags and time, wallet-owned, portable across any app that knows how to read Arkiv."*

Explicit build suggestions from the team:
- A personal research assistant that archives every paper it reads plus your notes
- A coding agent whose project context is a shared Arkiv DB
- An MCP server that hands any LLM a memory backend keyed to a user's wallet
- An agent that maintains a public reputation log of its own decisions
- A multi-agent system where agents read each other's public memory entities for coordination

"Directions to push it further" includes *"Memory hierarchy with differentiated expirations"* and *"'Memory portability' judge"*.

Team framing rules (from `AGENTS.md` in the challenge repo):
- *"All entities expire. Use 'expiration dates', never 'TTL'."*
- *"never describe Arkiv as 'trustless' or 'fully decentralised'"*
- *"NOT Permanent Storage by Default. ❌ Avoid: 'Store data forever on Arkiv'. ✅ Instead: 'Store time-limited data with configurable expiration'."*

---

## 4. Recommended product design

### 4.1 The architecture that actually works on Braga today

```
┌──────────────────────────────────────────────────────────────────┐
│  Agent Memory v3 — empirically grounded                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  PRIMARY STORE — Arkiv (queryable, decaying)                     │
│    Write entities with TTL matched to access cadence:            │
│      Working/scratch    → fromHours(6)                           │
│      Episodic           → fromDays(30)                           │
│      Semantic / core    → fromYears(5)                           │
│    Tag each memory with attributes for fast recall.              │
│                                                                  │
│  RENEWAL SERVICE (your backend, owner key required)              │
│    Daily cron: scan entities approaching expiry.                 │
│    If last-accessed within renewal window → extendEntity.        │
│    If not → let it expire.                                       │
│    Bug to avoid: extend is REPLACE not ADD — must always pass    │
│    btl > remaining-lifetime or call will revert.                 │
│                                                                  │
│  PERSISTENT MIRROR — your own indexer (off-Arkiv)                │
│    Subscribe to ArkivEntityCreated/Updated/BTLExtended events.   │
│    Store (entityKey, payload, attributes, createdAtBlock) in     │
│    sqlite/Postgres/IPFS — whatever you want.                     │
│    On recall miss in Arkiv, fall back to local mirror.           │
│    This is your true cold tier (NOT historical Arkiv queries).   │
│                                                                  │
│  PROMOTION                                                       │
│    Recalled-from-mirror memory: re-CREATE in Arkiv with fresh    │
│    TTL if likely to be accessed again.                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 The pitch

> *"Agent memory with biologically-faithful decay dynamics. We use Arkiv as a queryable working-memory tier with intelligent renewal — memories that get accessed stay alive, ones that don't fade out. A self-run mirror provides recall for expired memories that need resurrection. Arkiv is the perfect substrate because its time-scoped model matches how memory consolidation actually works in humans, and because writes are cheap (~29k gas, no storage fee today)."*

This matches the team's official framing. Don't claim "permanent." Claim "decay-aware with intelligent consolidation."

### 4.3 Renewal arithmetic gotcha

Because `extend` is REPLACE not ADD:

```typescript
// WRONG — will revert if remaining > new btl
async function naive_extend(entityKey: Hex) {
  await client.extendEntity({ entityKey, expiresIn: fromDays(7) });
}

// RIGHT — check remaining first, extend by enough
async function safe_extend(entityKey: Hex) {
  const entity = await client.getEntity({ entityKey });
  const currentBlock = await client.getBlockNumber();
  const remainingBlocks = entity.expiresAt - currentBlock;
  const remainingSeconds = Number(remainingBlocks) * 2;
  const newTtlSeconds = Math.max(
    remainingSeconds + 86400,  // at least 1 day longer than remaining
    fromDays(7)                 // or 7 days from now, whichever is larger
  );
  await client.extendEntity({ entityKey, expiresIn: newTtlSeconds });
}
```

### 4.4 Canary integration test

```typescript
// test/braga-canary.test.ts
import { test, expect } from "bun:test";

test("recall after expiry — verify protocol assumption", async () => {
  const created = await client.createEntity({
    data: encodePayload({ note: "canary" }),
    expiresIn: fromSeconds(10),
    attributes: [stringAttr("canary", "true")],
  });
  const createdAtBlock = await client.getBlockNumber();

  await waitBlocks(20); // past expiry (10s = 5 blocks; wait 20 for safety)

  // Test 1: at latest — must be empty (auto-eviction works)
  const atLatest = await client.buildQuery()
    .where(eq("canary", "true"))
    .fetch();
  expect(atLatest.filter(e => e.entityKey === created.entityKey)).toHaveLength(0);

  // Test 2: at past block — currently broken (atBlock ignored)
  // If this ever starts passing, historical recall is fixed and you can
  // simplify your cold tier.
  const atPastBlock = await client.buildQuery()
    .where(eq("canary", "true"))
    .validAtBlock(createdAtBlock)
    .fetch();
  // Document current behavior:
  expect(atPastBlock).toHaveLength(0); // expected today; will fail when fixed
});
```

If test 2 ever starts returning the entity, the SDK or precompile got fixed and the cold-tier-on-Arkiv design becomes viable. Until then, mirror-based cold tier.

---

## 5. What to watch (next 30-90 days)

### 5.1 Top items that could affect your design

1. **`arkiv-sdk-js` PR #64** — "Feature/use entity registry contract", opened 2026-05-13 by `krzysiekfonal`. Moves SDK from RLP-precompile to Solidity-ABI path. Currently paused awaiting "Warsaw workshops outcome." Pin SDK to **v0.6.8** for your judge; expect breakage when this lands.

2. **`arkiv-op-reth` PR #80** — "Add tier-2 indexes for range queries", opened 2026-05-18 by Martin Arrivets, +657 lines. May incidentally fix the `atBlock` silent-ignore bug — worth retesting after merge.

3. **`arkiv-op-reth` PR #72 / Issue #79** — Architectural fork: tight-coupled vs out-of-process EntityDB. Either decision affects public API stability.

4. **Python SDK ROADMAP.md "Unpermissioned extension"** — if/when shipped, you can build delegated renewal. File a GitHub issue advocating for this.

5. **Fee model (architecture.md §9 "Open Question")** — unresolved. Could land any time. Could be retroactive. **Mitigation:** keep a migration script ready.

6. **`arkiv_stateRoot` on-chain anchoring** — storage-service doc says **~1 year** of production operation before this ships. When it does, historical queries become cryptographically verifiable. Not relevant for ETHNS deadline.

7. **`arkiv-starlight-docs` Issue #42** — "When to use Arkiv" comparison page. When it lands, the team commits publicly to expiration semantics framing. Read on day-of-merge.

### 5.2 Protocol stability assessment

**The protocol is in active flux**, not stable:
- Contract was rewritten from scratch in 6 weeks (Mar 30 – May 8)
- SDK is mid-refactor (PR #64 paused)
- Query indexer is being redesigned (PR #80)
- No `cargo test` in op-reth CI
- Solidity contract has 200+ tests but isn't deployed
- Deployed Rust precompile has no public test coverage
- Three SDKs at different stages (JS active, Python/Rust on legacy path)
- Architecture docs describe an intended future, not the current state

**Be precise with judges**: *"I tested commit `<sha>` of `@arkiv-network/sdk@0.6.8` on Braga at `<datetime>` and verified these specific behaviors."* Avoid *"the protocol promises X"* — promises are a moving target.

### 5.3 Repos covered in this research

**Fully read:**
- `arkiv-contracts` — Solidity source, Rust bindings, all tests, all docs
- `arkiv-op-reth` — every .rs in `crates/arkiv-node`, `crates/arkiv-cli`, `crates/arkiv-genesis`, all docs, CI workflows
- `arkiv-storage-service` — every .go file, all tests, architecture.md
- `arkiv-sdk-js` — source + npm `node_modules/@arkiv-network/sdk` v0.6.5
- `arkiv-sdk-python` — full package, tests, ROADMAP, MARKETING
- `arkiv-sdk-rust` — full crate
- `arkiv-starlight-docs` — issues + recent merged PRs
- `skills` (Arkiv-Network) — both skills (`arkiv-best-practices`, `arkiv-feedback`)
- `arkiv-tests` — stress test harness
- `arkiv-js-sdk-test` — integration tests
- `arkiv-ethns-builder-challenge` — Theme 1 guide + AGENTS.md
- Litepaper PDF (`arkiv.network/pdf/ARKIV_Litepaper.pdf`)
- `usecases-*` (8 repos) — copypal, drawiodb, filedb, imagedb, portfolio, umamidb, webdb, forum-example

**Verified empirically on Braga RPC** (`https://braga.hoodi.arkiv.network/rpc`):
- Bytecode at predeploy candidates
- Recent on-chain activity (5,000 block scan)
- Gas costs and event histograms
- `atBlock` historical query behavior
- Archive state availability

**Inaccessible / blind spots:**
- Discord conversations referenced in ETHNS challenge — out of scope for `gh` API
- The brotli-RLP precompile's actual Rust source location inside op-reth — confirmed it exists and runs, but pinning the exact registrar file would need a deeper sweep
- Whether `atBlock` ignore is bug vs intentional unimplemented — empirically verified broken, intent unknown
- L1 → L2 → L3 settlement timing on Braga
- Future `arkiv_stateRoot` anchoring contract code (deferred to "~1 year")

---

## 6. Key file paths and commands for follow-up

### 6.1 Local files
- SDK source: `/Users/lingsiewwin/Documents/Github/Arkiv/node_modules/@arkiv-network/sdk/src/`
- Wallet address (test): `0x557e1e07652b75abaa667223b11704165fc94d09` — 0.021 GLM on Braga as of 2026-05-17
- Arkiv best-practices skill: `/Users/lingsiewwin/Documents/Github/Arkiv/.agents/skills/arkiv-best-practices/`

### 6.2 Braga network
- RPC: `https://braga.hoodi.arkiv.network/rpc`
- Chain ID: `60138453102`
- Block time: 2 seconds
- Explorer: `https://explorer.braga.hoodi.arkiv.network/`
- Faucet: `https://braga.hoodi.arkiv.network/faucet/`
- Real predeploy address: `0x00000000000000000000000000000061726b6976`
- L1Block predeploy: `0x4200000000000000000000000000000000000015`
- System depositor: `0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001`

### 6.3 Useful RPC commands

```bash
# Current block
curl -s -X POST https://braga.hoodi.arkiv.network/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# Live entity count
curl -s -X POST https://braga.hoodi.arkiv.network/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"arkiv_getEntityCount","params":[],"id":1}'

# Block timing (current_block, current_block_time, duration)
curl -s -X POST https://braga.hoodi.arkiv.network/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"arkiv_getBlockTiming","params":[],"id":1}'

# Native balance
curl -s -X POST https://braga.hoodi.arkiv.network/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["<addr>","latest"],"id":1}'
```

### 6.4 Critical GitHub URLs

- Contract source: https://github.com/Arkiv-Network/arkiv-contracts
- ExEx source: https://github.com/Arkiv-Network/arkiv-op-reth
- Storage service: https://github.com/Arkiv-Network/arkiv-storage-service
- JS SDK: https://github.com/Arkiv-Network/arkiv-sdk-js (`develop` branch is default)
- ETHNS challenge: https://github.com/Arkiv-Network/arkiv-ethns-builder-challenge
- Docs site source: https://github.com/Arkiv-Network/arkiv-starlight-docs

---

## 7. Bottom line for the hackathon

Three rounds of research said "is the TTL a flaw or a turning point." Fourth round empirical sweep says:

**It is the turning point — but the architectural beauty isn't accessible via the public API today.**

What works today:
- Cheap writes (~29k gas, no storage fee)
- Reliable auto-eviction at `expiresAt`
- Long btl allowed (no `MAX_BTL` in any layer)
- Owner-only extension (REPLACE not ADD semantics)
- Tag-based attribute queries at `latest`
- Public team endorsement of agent memory as flagship use case

What doesn't work today:
- Historical recall via `atBlock` (silently ignored by server)
- Third-party extension (owner-only until "unpermissioned extension" ships)
- Reliable archive-state access (sparse snapshot coverage)
- Cryptographic verification of query completeness (~1 year out)

The product to build:
- Arkiv as queryable hot/warm tier with intelligent renewal
- Self-run off-Arkiv mirror as cold tier
- Pitch: "decay-aware agent memory with intelligent consolidation"
- Match the team's official framing — don't say "permanent"
- Ship before fee model lands; prove it works in the free period
- Plan for "unpermissioned extension" landing — game-changer for delegated renewal

---

## Empirical finding (2026-05-23): Braga is precompile-only — no general contract deployment

Tested whether the memory-market path (ERC-8183 escrow / `contracts/SynapticMarket.sol`) is
even possible on Braga. Verdict: **no, not today.** Script: `scripts/braga-tx-diagnostic.ts`
(+ `scripts/braga-deploy-sdk.ts`).

Observed on the live Braga RPC with a funded session key (0.0129 GLM):
- Reads work: `eth_getBalance`, `eth_gasPrice` (1000251), `eth_getTransactionCount` all OK.
- `eth_estimateGas` works **even for contract creation** (56132) — the op-reth EVM will *simulate*
  a deploy. So the limit is not the EVM engine.
- **Every `eth_sendRawTransaction` for a non-precompile tx is rejected** with `-32602
  "Missing or invalid parameters"`: plain 0-value self-transfer AND contract-creation (`to: null`),
  in **both** EIP-1559 (type-2) and legacy (type-0) form, with manual gas to bypass estimation.
- The Arkiv SDK's own wallet client (same chain config) also fails for `to: null`.
- Yet SDK `mutateEntities` lands every time — because it always sends to the **Arkiv precompile**
  `ARKIV_ADDRESS` with `value: 0n` + brotli-RLP data (see `node_modules/@arkiv-network/sdk/dist/index.js`
  `sendArkivTransaction`).

**Conclusion:** Braga's public RPC only admits transactions directed at the Arkiv precompile.
General EVM deployment (and even ordinary transfers) are not exposed. This matches §1 above
(registry is a Rust precompile; the Solidity `EntityRegistry` is future design, not deployed).

**Implications for the product:**
- The on-chain memory **market cannot be built on Braga** — there is no contract to deploy escrow
  (ERC-8183) or `SynapticMarket.sol` into. `contracts/*.sol` in this repo are aspirational.
- Arkiv-as-deployed monetizes **persistence only** (precompile btl/rent) — not commerce. The
  market must live on a separate general-EVM chain (Arkiv as data substrate) OR wait for Arkiv to
  ship its Solidity `EntityRegistry` + general EVM (the "future design" in `arkiv-contracts`).
- The precise upstream ask (the "submit a PR" target): general EVM contract deployment on Arkiv,
  or a native escrow/conditional-reveal precompile op. Without it, no on-chain market on Arkiv.
- This retroactively validates deferring the market: it was never just "no escrow primitive" —
  it's "no contract deployment at all."
