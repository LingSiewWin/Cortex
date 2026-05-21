/**
 * Phase 4 — EIP-712 + ERC-5267 tests.
 *
 * Pure crypto. No Braga RPC. Verifies:
 *   1. SessionAuthorization round-trips: sign → verify.
 *   2. The digest matches viem's `hashTypedData` directly.
 *   3. The ERC-5267 domain view exposes the same chainId / contract as the
 *      EIP-712 domain object.
 */

import { test, expect, describe } from "bun:test";
import { hashTypedData, verifyTypedData, keccak256, toBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "@arkiv-network/sdk/accounts";
import {
  CORTEX_DOMAIN_SALT,
  CORTEX_EIP712_DOMAIN,
  SESSION_AUTHORIZATION_TYPES,
  VERIFYING_CONTRACT_V1,
  eip712DomainView,
  getSessionAuthorizationTypedData,
  hashSessionAuthorization,
  type SessionAuthorization,
} from "../src/lib/eip712";
import { BRAGA, PROJECT_ATTRIBUTE } from "../src/constants";

function fixtureAuthorization(user: Hex, sessionKey: Hex): SessionAuthorization {
  return {
    user,
    sessionKey,
    scope: keccak256(toBytes("arkiv.write")),
    entityNamespace:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    maxWrites: 1000n,
    validAfter: 1_700_000_000n,
    validBefore: 1_700_014_400n,
    nonce:
      "0xabababababababababababababababababababababababababababababababab",
  };
}

describe("eip712 — SessionAuthorization", () => {
  test("round-trips signature with a freshly generated EOA", async () => {
    const userKey = generatePrivateKey();
    const userAccount = privateKeyToAccount(userKey);
    const sessionKey = privateKeyToAccount(generatePrivateKey()).address;

    const auth = fixtureAuthorization(userAccount.address, sessionKey);
    const typedData = getSessionAuthorizationTypedData(auth);

    const signature = await userAccount.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    const ok = await verifyTypedData({
      address: userAccount.address,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    });

    expect(ok).toBe(true);
  });

  test("hashSessionAuthorization matches viem's hashTypedData", () => {
    const auth = fixtureAuthorization(
      "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      "0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd",
    );
    const ours = hashSessionAuthorization(auth);
    const theirs = hashTypedData({
      domain: CORTEX_EIP712_DOMAIN,
      types: SESSION_AUTHORIZATION_TYPES,
      primaryType: "SessionAuthorization",
      message: auth,
    });
    expect(ours).toBe(theirs);
  });

  test("modifying any field changes the digest", () => {
    const base = fixtureAuthorization(
      "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      "0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd",
    );
    const baseHash = hashSessionAuthorization(base);

    const bumped = { ...base, maxWrites: base.maxWrites + 1n };
    expect(hashSessionAuthorization(bumped)).not.toBe(baseHash);

    const newNonce = {
      ...base,
      nonce:
        "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" as Hex,
    };
    expect(hashSessionAuthorization(newNonce)).not.toBe(baseHash);
  });

  test("rejects signature from wrong signer", async () => {
    const userAccount = privateKeyToAccount(generatePrivateKey());
    const attackerAccount = privateKeyToAccount(generatePrivateKey());
    const sessionKey = privateKeyToAccount(generatePrivateKey()).address;

    const auth = fixtureAuthorization(userAccount.address, sessionKey);
    const typedData = getSessionAuthorizationTypedData(auth);

    // Attacker signs the same typed data with a different key.
    const badSig = await attackerAccount.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    const ok = await verifyTypedData({
      address: userAccount.address,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature: badSig,
    });

    expect(ok).toBe(false);
  });
});

describe("eip712 — ERC-5267 domain view", () => {
  test("mirrors CORTEX_EIP712_DOMAIN's load-bearing fields including salt", () => {
    const view = eip712DomainView();
    expect(view.name).toBe("Cortex");
    expect(view.version).toBe("1");
    expect(view.chainId).toBe(BigInt(BRAGA.chainId));
    expect(view.verifyingContract).toBe(VERIFYING_CONTRACT_V1);
    // 0x1f = name+version+chainId+verifyingContract+salt (bit 0x10 set).
    expect(view.fields).toBe("0x1f");
    expect(view.salt).toBe(CORTEX_DOMAIN_SALT);
    expect(view.extensions).toEqual([]);
  });

  test("CORTEX_DOMAIN_SALT is keccak256(`${chainId}:${PROJECT_ATTRIBUTE.value}`)", () => {
    const expected = keccak256(
      toBytes(`${BRAGA.chainId}:${PROJECT_ATTRIBUTE.value}`),
    );
    expect(CORTEX_DOMAIN_SALT).toBe(expected);
  });

  test("CORTEX_EIP712_DOMAIN carries the deployment-specific salt", () => {
    expect(CORTEX_EIP712_DOMAIN.salt).toBe(CORTEX_DOMAIN_SALT);
  });
});
