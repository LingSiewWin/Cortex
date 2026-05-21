/**
 * Phase 4 — ERC-4361 SIWE builder tests.
 *
 * Pure string formatting + EIP-191 round-trip. No Braga RPC.
 *
 * Verifies:
 *   1. Fixed input → exact expected output (line-by-line).
 *   2. `buildCortexSiwe` populates the required fields and the round-trip
 *      formatter produces a SIWE-spec-valid string.
 *   3. The signed message recovers back to the signer's address via viem
 *      `verifyMessage`.
 */

import { test, expect, describe } from "bun:test";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "@arkiv-network/sdk/accounts";
import {
  buildCortexSiwe,
  formatSiweMessage,
  parseSiweMessage,
  randomSiweNonce,
} from "../src/lib/siwe";
import { BRAGA } from "../src/constants";

describe("siwe — formatSiweMessage", () => {
  test("matches known-good fixture line-by-line", () => {
    const formatted = formatSiweMessage({
      domain: "cortex.app",
      address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      statement: "Authorize Cortex session for 4 hours, max 1000 writes",
      uri: "https://cortex.app",
      chainId: BRAGA.chainId,
      nonce: "abcdef0123456789",
      issuedAt: "2026-05-20T12:00:00.000Z",
      expirationTime: "2026-05-20T16:00:00.000Z",
      resources: [
        "arkiv://cortex/0xabcdef0123456789abcdef0123456789abcdef01",
      ],
    });

    const expected = [
      "cortex.app wants you to sign in with your Ethereum account:",
      "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      "",
      "Authorize Cortex session for 4 hours, max 1000 writes",
      "",
      "URI: https://cortex.app",
      "Version: 1",
      `Chain ID: ${BRAGA.chainId}`,
      "Nonce: abcdef0123456789",
      "Issued At: 2026-05-20T12:00:00.000Z",
      "Expiration Time: 2026-05-20T16:00:00.000Z",
      "Resources:",
      "- arkiv://cortex/0xabcdef0123456789abcdef0123456789abcdef01",
    ].join("\n");

    expect(formatted).toBe(expected);
  });

  test("omits Resources block when none provided", () => {
    const formatted = formatSiweMessage({
      domain: "localhost:3000",
      address: "0x1111111111111111111111111111111111111111",
      statement: "Sign in to Cortex",
      uri: "http://localhost:3000",
      chainId: BRAGA.chainId,
      nonce: "0000000000abcdef",
      issuedAt: "2026-05-20T12:00:00.000Z",
      expirationTime: "2026-05-20T16:00:00.000Z",
    });

    expect(formatted.includes("Resources:")).toBe(false);
    // Last line must be `Expiration Time: ...` with no trailing newline.
    expect(formatted.endsWith("Expiration Time: 2026-05-20T16:00:00.000Z")).toBe(true);
  });
});

describe("siwe — buildCortexSiwe", () => {
  test("populates required fields with Braga chain ID", () => {
    const user = "0x1234567890abcdefABCDEF1234567890ABCDef12" as `0x${string}`;
    const input = buildCortexSiwe({
      user,
      durationSeconds: 4 * 60 * 60,
      maxWrites: 500,
      domain: "cortex.app",
      uri: "https://cortex.app",
    });

    expect(input.address).toBe(user);
    expect(input.chainId).toBe(BRAGA.chainId);
    expect(input.statement).toBe(
      "Authorize Cortex session for 4 hours, max 500 writes",
    );
    expect(input.resources).toEqual([
      `arkiv://cortex/${user.toLowerCase()}`,
    ]);
    expect(input.nonce.length).toBeGreaterThanOrEqual(8);

    // Issued and expiration must be valid ISO 8601 and ~ duration apart.
    const issued = Date.parse(input.issuedAt);
    const expires = Date.parse(input.expirationTime);
    expect(Number.isFinite(issued)).toBe(true);
    expect(Number.isFinite(expires)).toBe(true);
    expect(expires - issued).toBe(4 * 60 * 60 * 1000);
  });

  test("formatted message verifies via personal_sign / viem.verifyMessage", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const input = buildCortexSiwe({
      user: account.address,
      durationSeconds: 3600,
      maxWrites: 100,
      domain: "cortex.app",
      uri: "https://cortex.app",
    });
    const message = formatSiweMessage(input);

    const signature = await account.signMessage({ message });
    const ok = await verifyMessage({
      address: account.address,
      message,
      signature,
    });
    expect(ok).toBe(true);
  });
});

describe("siwe — randomSiweNonce", () => {
  test("returns 32-char fixed-length hex values and is non-deterministic", () => {
    const a = randomSiweNonce();
    const b = randomSiweNonce();
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("siwe — parseSiweMessage", () => {
  const fixture = {
    domain: "localhost:3000",
    address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" as const,
    statement: "Authorize Cortex session for 4 hours, max 1000 writes",
    uri: "http://localhost:3000",
    chainId: BRAGA.chainId,
    nonce: "abcdef0123456789abcdef0123456789",
    issuedAt: "2026-05-20T12:00:00.000Z",
    expirationTime: "2026-05-20T16:00:00.000Z",
  };

  test("round-trips format -> parse exactly", () => {
    const formatted = formatSiweMessage(fixture);
    const parsed = parseSiweMessage(formatted);
    expect(parsed.domain).toBe(fixture.domain);
    expect(parsed.address).toBe(fixture.address);
    expect(parsed.statement).toBe(fixture.statement);
    expect(parsed.uri).toBe(fixture.uri);
    expect(parsed.chainId).toBe(fixture.chainId);
    expect(parsed.nonce).toBe(fixture.nonce);
    expect(parsed.issuedAt).toBe(fixture.issuedAt);
    expect(parsed.expirationTime).toBe(fixture.expirationTime);
    expect(parsed.resources).toBeUndefined();
  });

  test("parses Resources block when present", () => {
    const formatted = formatSiweMessage({
      ...fixture,
      resources: ["arkiv://cortex/0xabc", "arkiv://cortex/0xdef"],
    });
    const parsed = parseSiweMessage(formatted);
    expect(parsed.resources).toEqual(["arkiv://cortex/0xabc", "arkiv://cortex/0xdef"]);
  });

  test("throws on malformed preamble", () => {
    expect(() => parseSiweMessage("garbage")).toThrow();
  });

  test("throws on bad address", () => {
    const bad = formatSiweMessage(fixture).replace(fixture.address, "0xNOTHEX");
    expect(() => parseSiweMessage(bad)).toThrow();
  });

  test("throws on unsupported version", () => {
    const bad = formatSiweMessage(fixture).replace("Version: 1", "Version: 2");
    expect(() => parseSiweMessage(bad)).toThrow();
  });

  test("throws on non-numeric Chain ID", () => {
    const bad = formatSiweMessage(fixture).replace(
      `Chain ID: ${BRAGA.chainId}`,
      "Chain ID: not-a-number",
    );
    expect(() => parseSiweMessage(bad)).toThrow();
  });
});
