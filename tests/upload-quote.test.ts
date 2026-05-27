import { test, expect } from "bun:test";
import { quotePreparedUpload } from "../src/lib/upload-quote.ts";
import type { PreparedUpload } from "../src/lib/store-file-prepare.ts";

const SAMPLE: PreparedUpload = {
  text: "[cortex-upload]\nfilename: photo.png\nmime: image/png\nsha256: abcd",
  embedding: new Array(1536).fill(0),
  contentSha256: "abcd".repeat(16),
  filename: "photo.png",
  mime: "image/png",
  binary: true,
  title: "photo.png",
  kind: "upload",
  project: "cortex-ethns-2026",
  frontmatter: { upload: true, mime: "image/png", filename: "photo.png", bytesLength: 1200 },
};

test("quotePreparedUpload returns payload, lease, and gas estimates", async () => {
  const q = await quotePreparedUpload(SAMPLE, { sourceFileBytes: 1200 });
  expect(q.sealedPayloadBytes).toBeGreaterThan(500);
  expect(q.plainPayloadBytes).toBeLessThan(q.sealedPayloadBytes);
  expect(q.leaseLabel).toBe("1 year");
  expect(q.leaseSeconds).toBe(365 * 24 * 60 * 60);
  expect(BigInt(q.txGasMaxWei)).toBeGreaterThan(0n);
  expect(q.walletApprovalGlm).toContain("GLM");
  expect(BigInt(q.storageByteSeconds)).toBeGreaterThan(0n);
});
