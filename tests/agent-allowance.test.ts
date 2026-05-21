/**
 * Phase 11 — Agent Allowance tests.
 *
 * Pure. No Braga RPC. Uses a temp SQLite path so the project mirror DB isn't
 * touched.
 *
 * Covers:
 *   1. buildSessionAuthorizationV2 + sign + verifySessionAuthorizationV2 round-trip
 *   2. DB layer: createAllowance → getAllowanceBySessionKey returns the row
 *   3. recordSpend increments spent_wei + write_count
 *   4. recordSpend returns false when applying the spend would exceed maxGasWei
 *   5. Refill: createAllowance for prev, then refill marks prev=expired + creates new
 *   6. V1 SessionAuthorization (existing) STILL signs + verifies after V2 lands
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { keccak256, toBytes, type Hex } from "viem";
import {
  privateKeyToAccount,
  generatePrivateKey,
} from "@arkiv-network/sdk/accounts";
import {
  buildSessionAuthorization,
  buildSessionAuthorizationV2,
  generateSessionKeyAccount,
  verifySessionAuthorization,
  verifySessionAuthorizationV2,
  SCOPE_ARKIV_WRITE,
} from "../src/lib/session-key";
import {
  getSessionAuthorizationTypedData,
  getSessionAuthorizationV2TypedData,
  hashSessionAuthorization,
  hashSessionAuthorizationV2,
} from "../src/lib/eip712";
import {
  closeMirrorDb,
  createAllowance,
  getAllowanceBySessionKey,
  getAllowancesByMaster,
  initMirrorDb,
  markPaused,
  recentSpends,
  recordSpend,
} from "../src/mirror/db";

const TEST_DB_PATH = `./cortex-mirror.allowance-test-${Date.now()}.sqlite`;

beforeAll(() => {
  process.env.CORTEX_MIRROR_PATH = TEST_DB_PATH;
});

afterAll(async () => {
  closeMirrorDb();
  try {
    await Bun.file(TEST_DB_PATH).delete();
    await Bun.file(`${TEST_DB_PATH}-wal`).delete();
    await Bun.file(`${TEST_DB_PATH}-shm`).delete();
  } catch {
    /* ignore */
  }
});

beforeEach(async () => {
  // Truncate allowance tables between tests so each one starts from a known
  // state. We don't drop the schema — initMirrorDb caches the connection.
  const db = await initMirrorDb();
  db.exec("DELETE FROM allowance_spends;");
  db.exec("DELETE FROM agent_allowances;");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NAMESPACE: Hex =
  "0x9999999999999999999999999999999999999999999999999999999999999999";

async function signedV2(opts: {
  master?: ReturnType<typeof privateKeyToAccount>;
  maxGasWei?: bigint;
  refillThresholdWei?: bigint;
  estimatedDailyCostWei?: bigint;
  maxWrites?: bigint;
  durationSeconds?: number;
  nonce?: Hex;
  nowSeconds?: number;
}) {
  const master = opts.master ?? privateKeyToAccount(generatePrivateKey());
  const { account: sessionAcct } = generateSessionKeyAccount();
  const auth = buildSessionAuthorizationV2({
    user: master.address,
    sessionKey: sessionAcct.address,
    entityNamespace: NAMESPACE,
    maxGasWei: opts.maxGasWei ?? 1_000_000_000_000_000n, // 0.001 GLM
    refillThresholdWei: opts.refillThresholdWei ?? 100_000_000_000_000n,
    estimatedDailyCostWei:
      opts.estimatedDailyCostWei ?? 500_000_000_000_000n, // 0.0005 GLM/day
    ...(opts.maxWrites !== undefined ? { maxWrites: opts.maxWrites } : {}),
    durationSeconds: opts.durationSeconds ?? 60 * 60,
    ...(opts.nowSeconds !== undefined ? { nowSeconds: opts.nowSeconds } : {}),
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
  });
  const typed = getSessionAuthorizationV2TypedData(auth);
  const signature = await master.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  return { master, sessionAcct, auth, signature };
}

// ---------------------------------------------------------------------------
// 1. round-trip
// ---------------------------------------------------------------------------

describe("SessionAuthorizationV2 — sign + verify", () => {
  test("round-trips signature with a freshly generated EOA", async () => {
    const { master, auth, signature } = await signedV2({});
    const ok = await verifySessionAuthorizationV2(auth, signature);
    expect(ok).toBe(true);
    expect(auth.user.toLowerCase()).toBe(master.address.toLowerCase());
  });

  test("rejects signature from an attacker EOA", async () => {
    const { auth } = await signedV2({});
    const attacker = privateKeyToAccount(generatePrivateKey());
    const typed = getSessionAuthorizationV2TypedData(auth);
    const badSig = await attacker.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    const ok = await verifySessionAuthorizationV2(auth, badSig);
    expect(ok).toBe(false);
  });

  test("V2 typeHash differs from V1 (cannot replay across versions)", () => {
    // Same logical fields where they overlap → still different digest because
    // the EIP-712 typeHash incorporates the struct name + field list.
    const u = privateKeyToAccount(generatePrivateKey()).address;
    const s = privateKeyToAccount(generatePrivateKey()).address;
    const v1 = buildSessionAuthorization({
      user: u,
      sessionKey: s,
      entityNamespace: NAMESPACE,
      nowSeconds: 1_700_000_000,
      nonce:
        "0xcafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe",
    });
    const v2 = buildSessionAuthorizationV2({
      user: v1.user,
      sessionKey: v1.sessionKey,
      entityNamespace: v1.entityNamespace,
      maxGasWei: 1_000n,
      refillThresholdWei: 100n,
      estimatedDailyCostWei: 100n,
      nowSeconds: 1_700_000_000,
      nonce: v1.nonce,
    });
    const h1 = hashSessionAuthorization(v1);
    const h2 = hashSessionAuthorizationV2(v2);
    expect(h1).not.toBe(h2);
  });

  test("default scope is keccak256('arkiv.write')", () => {
    expect(SCOPE_ARKIV_WRITE).toBe(keccak256(toBytes("arkiv.write")));
  });
});

// ---------------------------------------------------------------------------
// 2. DB: create + read
// ---------------------------------------------------------------------------

describe("agent allowance DB — create + read", () => {
  test("createAllowance + getAllowanceBySessionKey round-trips", async () => {
    const db = await initMirrorDb();
    const { master, auth, signature } = await signedV2({
      maxGasWei: 1_000_000n,
      refillThresholdWei: 100_000n,
      estimatedDailyCostWei: 50_000n,
    });
    const row = await createAllowance(db, auth, signature, master.address);
    expect(row.sessionKey.toLowerCase()).toBe(auth.sessionKey.toLowerCase());
    expect(row.master.toLowerCase()).toBe(master.address.toLowerCase());
    expect(row.maxGasWei).toBe(1_000_000n);
    expect(row.refillThresholdWei).toBe(100_000n);
    expect(row.estimatedDailyCostWei).toBe(50_000n);
    expect(row.spentWei).toBe(0n);
    expect(row.writeCount).toBe(0);
    expect(row.state).toBe("active");

    const fetched = getAllowanceBySessionKey(db, auth.sessionKey);
    expect(fetched).not.toBeNull();
    expect(fetched!.sessionKey).toBe(row.sessionKey);
    expect(fetched!.maxGasWei).toBe(1_000_000n);
  });

  test("createAllowance rejects when signer != auth.user", async () => {
    const db = await initMirrorDb();
    const { auth, signature } = await signedV2({});
    const wrongSigner = privateKeyToAccount(generatePrivateKey()).address;
    let threw = false;
    try {
      await createAllowance(db, auth, signature, wrongSigner);
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("signer does not match");
    }
    expect(threw).toBe(true);
  });

  test("createAllowance rejects bad signature", async () => {
    const db = await initMirrorDb();
    const { master, auth } = await signedV2({});
    const bogusSig: Hex = ("0x" + "ab".repeat(65)) as Hex;
    let threw = false;
    try {
      await createAllowance(db, auth, bogusSig, master.address);
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("signature did not verify");
    }
    expect(threw).toBe(true);
  });

  test("getAllowancesByMaster lists in created_at_ms desc", async () => {
    const db = await initMirrorDb();
    const master = privateKeyToAccount(generatePrivateKey());
    const a = await signedV2({ master, nonce: ("0x" + "11".repeat(32)) as Hex });
    await createAllowance(db, a.auth, a.signature, master.address);
    // Tiny delay so the second row's created_at_ms is strictly later.
    await Bun.sleep(5);
    const b = await signedV2({ master, nonce: ("0x" + "22".repeat(32)) as Hex });
    await createAllowance(db, b.auth, b.signature, master.address);

    const rows = getAllowancesByMaster(db, master.address);
    expect(rows.length).toBe(2);
    // Most-recent first.
    expect(rows[0]!.sessionKey.toLowerCase()).toBe(
      b.auth.sessionKey.toLowerCase(),
    );
    expect(rows[1]!.sessionKey.toLowerCase()).toBe(
      a.auth.sessionKey.toLowerCase(),
    );
  });

  test("createAllowance is idempotent on same session_key (insert-or-fetch)", async () => {
    const db = await initMirrorDb();
    const { master, auth, signature } = await signedV2({});
    const r1 = await createAllowance(db, auth, signature, master.address);
    const r2 = await createAllowance(db, auth, signature, master.address);
    expect(r1.sessionKey).toBe(r2.sessionKey);
    const all = getAllowancesByMaster(db, master.address);
    expect(all.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. Spend tracking
// ---------------------------------------------------------------------------

describe("agent allowance — recordSpend", () => {
  test("increments spent_wei + write_count", async () => {
    const db = await initMirrorDb();
    const { master, auth, signature } = await signedV2({
      maxGasWei: 1_000_000n,
    });
    await createAllowance(db, auth, signature, master.address);

    expect(recordSpend(db, auth.sessionKey, null, 100_000n)).toBe(true);
    expect(recordSpend(db, auth.sessionKey, null, 200_000n)).toBe(true);

    const row = getAllowanceBySessionKey(db, auth.sessionKey);
    expect(row).not.toBeNull();
    expect(row!.spentWei).toBe(300_000n);
    expect(row!.writeCount).toBe(2);
    expect(row!.state).toBe("active");

    const recent = recentSpends(db, auth.sessionKey, 12);
    expect(recent.length).toBe(2);
    expect(recent[0]!.gasWei).toBe(200_000n);
    expect(recent[1]!.gasWei).toBe(100_000n);
  });

  test("refuses (returns false) when spend would exceed maxGasWei", async () => {
    const db = await initMirrorDb();
    const { master, auth, signature } = await signedV2({
      maxGasWei: 1_000_000n,
    });
    await createAllowance(db, auth, signature, master.address);
    expect(recordSpend(db, auth.sessionKey, null, 900_000n)).toBe(true);
    // 900k + 200k = 1.1M > 1.0M cap.
    expect(recordSpend(db, auth.sessionKey, null, 200_000n)).toBe(false);
    const row = getAllowanceBySessionKey(db, auth.sessionKey);
    expect(row!.spentWei).toBe(900_000n);
    expect(row!.writeCount).toBe(1);
  });

  test("flips to exhausted when spent_wei hits maxGasWei", async () => {
    const db = await initMirrorDb();
    const { master, auth, signature } = await signedV2({
      maxGasWei: 1_000_000n,
    });
    await createAllowance(db, auth, signature, master.address);
    expect(recordSpend(db, auth.sessionKey, null, 1_000_000n)).toBe(true);
    const row = getAllowanceBySessionKey(db, auth.sessionKey);
    expect(row!.state).toBe("exhausted");
    // Subsequent spend should refuse because state is no longer active.
    expect(recordSpend(db, auth.sessionKey, null, 1n)).toBe(false);
  });

  test("refuses when allowance is paused", async () => {
    const db = await initMirrorDb();
    const { master, auth, signature } = await signedV2({
      maxGasWei: 1_000_000n,
    });
    await createAllowance(db, auth, signature, master.address);
    markPaused(db, auth.sessionKey);
    expect(recordSpend(db, auth.sessionKey, null, 1n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Refill flow
// ---------------------------------------------------------------------------

describe("agent allowance — refill", () => {
  test("refill marks prev=expired and creates a new row with refilled_from", async () => {
    const db = await initMirrorDb();
    const master = privateKeyToAccount(generatePrivateKey());

    const prev = await signedV2({
      master,
      maxGasWei: 1_000_000n,
      nonce: ("0x" + "01".repeat(32)) as Hex,
    });
    const prevRow = await createAllowance(
      db,
      prev.auth,
      prev.signature,
      master.address,
    );
    expect(prevRow.state).toBe("active");

    // New allowance — same master, fresh session key, larger budget.
    const next = await signedV2({
      master,
      maxGasWei: 5_000_000n,
      nonce: ("0x" + "02".repeat(32)) as Hex,
    });
    const nextRow = await createAllowance(
      db,
      next.auth,
      next.signature,
      master.address,
      { refilledFrom: prev.auth.sessionKey },
    );
    // Mark prev as expired (the API handler does this; we replicate here).
    db.prepare(
      "UPDATE agent_allowances SET state = 'expired' WHERE session_key = ?",
    ).run(prev.auth.sessionKey.toLowerCase());

    expect(nextRow.refilledFrom?.toLowerCase()).toBe(
      prev.auth.sessionKey.toLowerCase(),
    );
    const reread = getAllowanceBySessionKey(db, prev.auth.sessionKey);
    expect(reread!.state).toBe("expired");

    const allActive = getAllowancesByMaster(db, master.address).filter(
      (r) => r.state === "active",
    );
    expect(allActive.length).toBe(1);
    expect(allActive[0]!.sessionKey.toLowerCase()).toBe(
      next.auth.sessionKey.toLowerCase(),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. V1 still works
// ---------------------------------------------------------------------------

describe("v1 SessionAuthorization still works after v2 lands", () => {
  test("v1 sign + verify round-trip is intact", async () => {
    const master = privateKeyToAccount(generatePrivateKey());
    const { account: sessionAcct } = generateSessionKeyAccount();
    const auth = buildSessionAuthorization({
      user: master.address,
      sessionKey: sessionAcct.address,
      entityNamespace: NAMESPACE,
      durationSeconds: 60 * 60,
      nowSeconds: 1_700_000_000,
    });
    const typed = getSessionAuthorizationTypedData(auth);
    const signature = await master.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    const ok = await verifySessionAuthorization(auth, signature);
    expect(ok).toBe(true);
  });
});
