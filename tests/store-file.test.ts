import { describe, expect, test } from "bun:test";
import {
  buildBinaryRecallText,
  isTextLikeUpload,
  sha256Bytes,
} from "../src/lib/store-file";

describe("store-file helpers", () => {
  test("isTextLikeUpload detects markdown and code", () => {
    expect(isTextLikeUpload("notes.md", "application/octet-stream")).toBe(true);
    expect(isTextLikeUpload("app.ts", "")).toBe(true);
    expect(isTextLikeUpload("readme.txt", "text/plain")).toBe(true);
  });

  test("isTextLikeUpload treats images as binary", () => {
    expect(isTextLikeUpload("photo.png", "image/png")).toBe(false);
    expect(isTextLikeUpload("data.bin", "application/octet-stream")).toBe(false);
  });

  test("buildBinaryRecallText includes hash and caption", () => {
    const text = buildBinaryRecallText({
      filename: "diagram.png",
      mime: "image/png",
      bytesSha256: "abc123",
      caption: "system architecture sketch",
    });
    expect(text).toContain("filename: diagram.png");
    expect(text).toContain("sha256: abc123");
    expect(text).toContain("system architecture sketch");
  });

  test("sha256Bytes is stable", async () => {
    const bytes = new TextEncoder().encode("hello");
    const a = await sha256Bytes(bytes);
    const b = await sha256Bytes(bytes);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});
