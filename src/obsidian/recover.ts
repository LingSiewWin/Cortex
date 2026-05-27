/**
 * Cortex — Obsidian vault recovery ("laptop died → rebuild from wallet").
 *
 * The sovereignty proof for the Document Tier: with only the user's wallet
 * (which derives the payload key) and the public Arkiv RPC, we can reconstruct
 * every sealed note as a real `.md` file — no Cortex backend, no SQLite mirror.
 *
 * Flow:
 *   1. Query all live `document` entities for this project (cortexQuery stamps
 *      PROJECT_ATTRIBUTE + filters to our session-key creator — see
 *      src/lib/arkiv-client.ts cortexQuery / decrypt-grant.ts for the query
 *      pattern this mirrors).
 *   2. getEntity to pull the sealed payload bytes.
 *   3. openPayload (wallet-derived key) → decodeDocumentPayload → { text,
 *      frontmatter, vaultPath, ... }.
 *   4. serializeNote(frontmatter + text) and write to outDir/<vaultPath>.
 *
 * I/O + network are injected via `deps` so this is unit-testable; the defaults
 * wire the real Arkiv client + crypto.
 */

import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import type { Hex } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { cortexQuery, getPublicClient } from "../lib/arkiv-client.ts";
import { getPayloadKey } from "../lib/payload-key.ts";
import { openPayload } from "../lib/crypto.ts";
import {
  decodeDocumentPayload,
  type DecodedDocumentPayload,
} from "../compression/document-payload.ts";
import { serializeNote } from "./note.ts";
import { ENTITY_TYPE } from "../constants.ts";

/** A getEntity result, narrowed to the fields recovery needs. */
export interface RecoverableEntity {
  key: Hex;
  /** Sealed (ciphertext) payload bytes — or null if the entity has none. */
  payload: Uint8Array | null;
}

export interface RecoverDeps {
  /** List live document entity keys for this project. */
  listDocumentKeys: () => Promise<Hex[]>;
  /** Fetch one entity (sealed payload + key). */
  getEntity: (key: Hex) => Promise<RecoverableEntity>;
  /** Decrypt sealed bytes → plaintext CBOR. Returns null if no wallet key. */
  open: (sealed: Uint8Array) => Promise<Uint8Array | null>;
  /** Write a recovered note to disk (ensures parent dirs exist). */
  writeFile: (absPath: string, data: string) => Promise<void>;
}

async function defaultListDocumentKeys(): Promise<Hex[]> {
  // Mirrors the query pattern in src/market/decrypt-grant.ts:browseListings —
  // cortexQuery() (PROJECT_ATTRIBUTE + createdBy=SESSION_KEY by default) plus a
  // where(eq("entityType", …)) narrowing, then .fetch() → result.entities.
  const result = await cortexQuery()
    .where(eq("entityType", ENTITY_TYPE.DOCUMENT))
    .withAttributes(true)
    .withMetadata(true)
    .limit(1000)
    .fetch();
  return result.entities.map((e) => e.key as Hex);
}

async function defaultGetEntity(key: Hex): Promise<RecoverableEntity> {
  const entity = await getPublicClient().getEntity(key);
  return { key, payload: entity.payload ?? null };
}

async function defaultOpen(sealed: Uint8Array): Promise<Uint8Array | null> {
  const payloadKey = await getPayloadKey();
  if (!payloadKey) return null; // no wallet material — cannot decrypt
  return openPayload(payloadKey, sealed);
}

async function defaultWriteFile(absPath: string, data: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await fsWriteFile(absPath, data, "utf8");
}

function resolveDeps(deps?: Partial<RecoverDeps>): RecoverDeps {
  return {
    listDocumentKeys: deps?.listDocumentKeys ?? defaultListDocumentKeys,
    getEntity: deps?.getEntity ?? defaultGetEntity,
    open: deps?.open ?? defaultOpen,
    writeFile: deps?.writeFile ?? defaultWriteFile,
  };
}

export interface RecoverVaultOptions {
  /** Directory to reconstruct the vault into. */
  outDir: string;
  deps?: Partial<RecoverDeps>;
  log?: (...args: unknown[]) => void;
}

export interface RecoverVaultResult {
  /** Absolute paths of notes written. */
  recovered: string[];
  /** Entity keys that were skipped (no payload / no key / decode failure). */
  skipped: { key: string; reason: string }[];
}

/**
 * Reconstruct the vault from sealed Arkiv document entities. Returns the list of
 * recovered note paths. Entities that can't be opened/decoded are skipped (the
 * public DB has noise + entities sealed under a different wallet), never fatal.
 */
export async function recoverVault(opts: RecoverVaultOptions): Promise<RecoverVaultResult> {
  const d = resolveDeps(opts.deps);
  const log = opts.log ?? ((..._a: unknown[]) => {});

  const keys = await d.listDocumentKeys();
  const recovered: string[] = [];
  const skipped: { key: string; reason: string }[] = [];

  for (const key of keys) {
    try {
      const entity = await d.getEntity(key);
      if (!entity.payload || entity.payload.byteLength === 0) {
        skipped.push({ key, reason: "no-payload" });
        continue;
      }
      const plaintext = await d.open(entity.payload);
      if (!plaintext) {
        skipped.push({ key, reason: "no-key" });
        continue;
      }

      let decoded: DecodedDocumentPayload;
      try {
        decoded = decodeDocumentPayload(plaintext);
      } catch (err) {
        skipped.push({ key, reason: `decode-failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      // Reconstruct the note: recovered frontmatter + recovered body text.
      const raw = serializeNote({
        frontmatter: decoded.frontmatter ?? {},
        body: decoded.text,
      });

      // Placement: the sealed vaultPath (relative), else a title/key fallback.
      const relPath =
        decoded.vaultPath && decoded.vaultPath.length > 0
          ? decoded.vaultPath
          : `${sanitizeName(decoded.title ?? key)}.md`;
      const absPath = join(opts.outDir, relPath);

      await d.writeFile(absPath, raw);
      recovered.push(absPath);
      log(`[obsidian-recover] wrote ${absPath} (${decoded.text.length} bytes)`);
    } catch (err) {
      skipped.push({ key, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  log(
    `[obsidian-recover] recovered ${recovered.length} note(s), skipped ${skipped.length}`,
  );
  return { recovered, skipped };
}

/** Make a filesystem-safe note name from a title/key (fallback placement only). */
function sanitizeName(s: string): string {
  const base = basename(s).replace(/[\\/:*?"<>|]/g, "_").trim();
  return base.length > 0 ? base : "untitled";
}
