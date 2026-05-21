/**
 * Phase 4 — session-key lifecycle tests.
 *
 * Pure crypto. No Braga RPC. Verifies:
 *   1. `generateSessionKeyAccount` produces a usable PrivateKeyAccount with a
 *      32-byte hex private key.
 *   2. `buildSessionAuthorization` fills validAfter/validBefore correctly,
 *      uses the standard scope tag by default, and accepts overrides.
 *   3. The full flow — user signs the typed struct, relayer verifies — round-trips.
 *   4. `verifySessionAuthorization` rejects a tampered message.
 */

import { test, expect, describe } from "bun:test";
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "@arkiv-network/sdk/accounts";
import {
  generateSessionKeyAccount,
  buildSessionAuthorization,
  verifySessionAuthorization,
  SCOPE_ARKIV_WRITE,
} from "../src/lib/session-key";
import { getSessionAuthorizationTypedData } from "../src/lib/eip712";
import { SESSION } from "../src/constants";

describe("session-key — generation", () => {
  test("generateSessionKeyAccount returns a viable signer", () => {
    const { account, privateKey } = generateSessionKeyAccount();
    expect(privateKey.startsWith("0x")).toBe(true);
    expect(privateKey.length).toBe(66); // 0x + 64 hex chars
    expect(account.address.startsWith("0x")).toBe(true);
    expect(account.address.length).toBe(42);
  });

  test("each call returns a fresh key", () => {
    const a = generateSessionKeyAccount();
    const b = generateSessionKeyAccount();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.account.address).not.toBe(b.account.address);
  });
});

describe("session-key — buildSessionAuthorization", () => {
  test("fills validAfter / validBefore from current time + duration", () => {
    const now = 1_700_000_000;
    const duration = 4 * 60 * 60;
    const auth = buildSessionAuthorization({
      user: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
      sessionKey: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
      durationSeconds: duration,
      entityNamespace:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      nowSeconds: now,
    });

    expect(auth.validAfter).toBe(BigInt(now));
    expect(auth.validBefore).toBe(BigInt(now + duration));
    expect(auth.maxWrites).toBe(BigInt(SESSION.defaultMaxWrites));
    expect(auth.scope).toBe(SCOPE_ARKIV_WRITE);
    expect(auth.nonce.length).toBe(66); // 0x + 64 hex chars
  });

  test("default scope is keccak256('arkiv.write')", () => {
    expect(SCOPE_ARKIV_WRITE).toBe(keccak256(toBytes("arkiv.write")));
  });

  test("respects nonce and scope overrides (deterministic)", () => {
    const nonce: Hex =
      "0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe";
    const customScope = keccak256(toBytes("arkiv.read"));
    const auth = buildSessionAuthorization({
      user: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
      sessionKey: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
      durationSeconds: 60,
      maxWrites: 42n,
      entityNamespace:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      nowSeconds: 1_700_000_000,
      nonce,
      scope: customScope,
    });
    expect(auth.nonce).toBe(nonce);
    expect(auth.scope).toBe(customScope);
    expect(auth.maxWrites).toBe(42n);
  });
});

describe("session-key — verifySessionAuthorization", () => {
  test("round-trips: user signs → verifier accepts", async () => {
    const userAccount = privateKeyToAccount(generatePrivateKey());
    const { account: sessionKeyAccount } = generateSessionKeyAccount();

    const auth = buildSessionAuthorization({
      user: userAccount.address,
      sessionKey: sessionKeyAccount.address,
      durationSeconds: 60 * 60,
      entityNamespace:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      nowSeconds: 1_700_000_000,
    });

    const typedData = getSessionAuthorizationTypedData(auth);
    const signature = await userAccount.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    const ok = await verifySessionAuthorization(auth, signature);
    expect(ok).toBe(true);
  });

  test("rejects when validBefore is tampered after signing", async () => {
    const userAccount = privateKeyToAccount(generatePrivateKey());
    const { account: sessionKeyAccount } = generateSessionKeyAccount();

    const auth = buildSessionAuthorization({
      user: userAccount.address,
      sessionKey: sessionKeyAccount.address,
      durationSeconds: 60 * 60,
      entityNamespace:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      nowSeconds: 1_700_000_000,
    });

    const typedData = getSessionAuthorizationTypedData(auth);
    const signature = await userAccount.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    const tampered = { ...auth, validBefore: auth.validBefore + 10_000n };
    const ok = await verifySessionAuthorization(tampered, signature);
    expect(ok).toBe(false);
  });

  test("rejects when signer is not the declared user", async () => {
    const userAccount = privateKeyToAccount(generatePrivateKey());
    const impostor = privateKeyToAccount(generatePrivateKey());
    const { account: sessionKeyAccount } = generateSessionKeyAccount();

    const auth = buildSessionAuthorization({
      user: userAccount.address,
      sessionKey: sessionKeyAccount.address,
      durationSeconds: 60 * 60,
      entityNamespace:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      nowSeconds: 1_700_000_000,
    });

    const typedData = getSessionAuthorizationTypedData(auth);
    const badSig = await impostor.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    const ok = await verifySessionAuthorization(auth, badSig);
    expect(ok).toBe(false);
  });
});
