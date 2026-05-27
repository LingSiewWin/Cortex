/**
 * Encode Arkiv createEntity calldata (RLP + brotli) for Braga gas estimation.
 */

import type { CreateEntityParameters } from "@arkiv-network/sdk";
import { toBytes, toHex, toRlp, type Hex } from "viem";

const BLOCK_TIME = 2;

export const ARKIV_SYSTEM_ADDRESS =
  "0x00000000000000000000000000000061726b6976" as const;

function formatAttribute<T extends string | number | bigint | boolean>(attribute: {
  key: string;
  value: T;
}): [Hex, Hex] {
  return [
    toHex(attribute.key),
    toHex(typeof attribute.value === "number" && attribute.value === 0 ? "" : attribute.value),
  ];
}

function encodeCreateEntityRlp(data: CreateEntityParameters): Hex {
  const payload = [
    [
      [
        toHex(Math.ceil(data.expiresIn / BLOCK_TIME)),
        toHex(data.contentType),
        toHex(data.payload),
        data.attributes.filter((a) => typeof a.value === "string").map(formatAttribute),
        data.attributes.filter((a) => typeof a.value === "number").map(formatAttribute),
      ],
    ],
    [],
    [],
    [],
    [],
  ];
  return toRlp(payload);
}

async function brotliCompress(data: Uint8Array): Promise<Uint8Array> {
  const isNode = typeof process !== "undefined" && process.versions?.node != null;
  if (isNode) {
    try {
      const zlib = await import("zlib");
      const compressed = zlib.brotliCompressSync(Buffer.from(data));
      return new Uint8Array(compressed);
    } catch {
      /* fall through */
    }
  }

  const brotliModule = await import("brotli-wasm");
  const brotli = (brotliModule.default ? await brotliModule.default : brotliModule) as {
    compress: (input: Uint8Array) => Uint8Array;
  };
  return brotli.compress(data);
}

export async function encodeCreateEntityCalldata(
  data: CreateEntityParameters,
): Promise<Hex> {
  const rlp = encodeCreateEntityRlp(data);
  const compressed = await brotliCompress(toBytes(rlp));
  return toHex(compressed);
}
