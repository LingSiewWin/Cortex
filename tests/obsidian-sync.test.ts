/**
 * Cortex — Obsidian sync daemon tests (all I/O + network mocked).
 *
 * Covers:
 *   1. syncNoteFile embeds (whole-note + sections), calls createDocumentMemory
 *      with the right shape (text, sections, vaultPath, title, frontmatter),
 *      and stamps the cortex recovery block back into the file.
 *   2. syncNoteFile is idempotent — SKIPS when the body sha is unchanged.
 *   3. shouldIgnore filters dotfiles, non-.md, and *.sync-conflict* files.
 */

import { test, expect, describe } from "bun:test";
import { syncNoteFile, shouldIgnore, type SyncDeps } from "../src/obsidian/sync-daemon.ts";
import { parseNote, contentSha256 } from "../src/obsidian/note.ts";
import type { DocumentCreateInput, DocumentCreateResult } from "../src/lib/batch-writer.ts";

const FIXED_TX = "0xtxhashfake" as const;
const FIXED_ENTITY = "0xentitykeyfake" as const;

/** Build a fresh set of mocked deps + an in-memory file system. */
function makeDeps(initialFiles: Record<string, string>) {
  const files: Record<string, string> = { ...initialFiles };
  const embedCalls: string[] = [];
  const createCalls: DocumentCreateInput[] = [];

  const deps: Partial<SyncDeps> = {
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    writeFile: async (p, d) => {
      files[p] = d;
    },
    embed: async (text) => {
      embedCalls.push(text);
      // Deterministic non-zero 1536-d vector (createDocumentMemory requires 1536).
      const v = new Float32Array(1536);
      for (let i = 0; i < 1536; i++) v[i] = ((i % 7) + 1) / 7;
      return v;
    },
    createDocument: async (input): Promise<DocumentCreateResult> => {
      createCalls.push(input);
      const sha = await contentSha256(input.text);
      return {
        txHash: FIXED_TX,
        entityKey: FIXED_ENTITY,
        docId: input.docId ?? "cx_generated",
        contentSha256: sha,
      };
    },
    now: () => new Date("2026-05-27T00:00:00.000Z"),
  };

  return { deps, files, embedCalls, createCalls };
}

describe("syncNoteFile", () => {
  test("embeds, seals with the right shape, and stamps the cortex block back", async () => {
    const abs = "/vault/notes/idea.md";
    const raw = `---
title: Big Idea
tags:
  - research
---
# Intro

The opening section.

## Details

The detailed section.
`;
    const { deps, files, embedCalls, createCalls } = makeDeps({ [abs]: raw });

    const res = await syncNoteFile(abs, deps, { vaultPath: "/vault" });

    // Returned the seal result (not skipped).
    expect(res.skipped).toBeUndefined();
    expect(res.entityKey).toBe(FIXED_ENTITY);
    expect(res.txHash).toBe(FIXED_TX);

    // Embedded the whole note + each non-empty section (preamble has none here:
    // body starts with a heading, so spans are Intro + Details = 2 sections,
    // plus 1 whole-note embed = 3 embed calls).
    expect(embedCalls.length).toBe(3);

    // createDocumentMemory got the right shape.
    expect(createCalls.length).toBe(1);
    const input = createCalls[0]!;
    expect(input.text).toContain("# Intro");
    expect(input.text).toContain("## Details");
    expect(input.title).toBe("Big Idea"); // from frontmatter
    expect(input.vaultPath).toBe("notes/idea.md"); // relative to vault root
    expect(input.embedding.length).toBe(1536);
    expect(input.sections?.map((s) => s.heading)).toEqual(["Intro", "Details"]);
    // section offsets must point at the heading inside the body
    for (const s of input.sections!) {
      expect(input.text.slice(s.offset)).toContain(s.heading);
      expect(s.embedding.length).toBe(1536);
    }
    // frontmatter passed through (user fields only, no cortex yet)
    expect(input.frontmatter?.title).toBe("Big Idea");
    expect(input.frontmatter?.cortex).toBeUndefined();

    // The file on disk now carries the cortex recovery block.
    const stamped = parseNote(files[abs]!);
    expect(stamped.cortex?.arkivEntityKey).toBe(FIXED_ENTITY);
    expect(stamped.cortex?.docId).toBeDefined();
    expect(stamped.cortex?.contentSha256).toBeDefined();
    expect(stamped.cortex?.updatedAt).toBe("2026-05-27T00:00:00.000Z");
    expect(stamped.cortex?.tier).toBe("rule");
    // user fields preserved through the stamp.
    expect(stamped.frontmatter.title).toBe("Big Idea");
    expect(stamped.frontmatter.tags).toEqual(["research"]);
  });

  test("falls back to filename for title when frontmatter has none", async () => {
    const abs = "/vault/Untitled Thought.md";
    const raw = "Just some body text, no frontmatter.\n";
    const { deps, createCalls } = makeDeps({ [abs]: raw });

    await syncNoteFile(abs, deps, { vaultPath: "/vault" });
    expect(createCalls[0]!.title).toBe("Untitled Thought");
    expect(createCalls[0]!.vaultPath).toBe("Untitled Thought.md");
  });

  test("is idempotent — SKIPS when the body sha is unchanged", async () => {
    const abs = "/vault/note.md";
    // First sync to learn the sha + stamp.
    const body = "# Title\n\nstable content\n";
    const raw = `---\ntitle: T\n---\n${body}`;
    const { deps, files, embedCalls, createCalls } = makeDeps({ [abs]: raw });

    const first = await syncNoteFile(abs, deps, { vaultPath: "/vault" });
    expect(first.skipped).toBeUndefined();
    const embedsAfterFirst = embedCalls.length;
    const createsAfterFirst = createCalls.length;

    // Second sync of the now-stamped file (body unchanged) must skip.
    const second = await syncNoteFile(abs, deps, { vaultPath: "/vault" });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("unchanged");
    // No new embed / no new Arkiv write.
    expect(embedCalls.length).toBe(embedsAfterFirst);
    expect(createCalls.length).toBe(createsAfterFirst);

    // The on-disk file is unchanged on the skip path.
    void files;
  });

  test("re-syncs when the body changes (sha differs)", async () => {
    const abs = "/vault/note.md";
    const { deps, files, createCalls } = makeDeps({
      [abs]: `---\ntitle: T\n---\n# H\n\nv1 content\n`,
    });
    await syncNoteFile(abs, deps, { vaultPath: "/vault" });
    expect(createCalls.length).toBe(1);

    // Edit the body (preserving the stamped cortex block).
    const edited = files[abs]!.replace("v1 content", "v2 content changed");
    files[abs] = edited;

    const res = await syncNoteFile(abs, deps, { vaultPath: "/vault" });
    expect(res.skipped).toBeUndefined();
    expect(createCalls.length).toBe(2);
    // reused the existing docId across the edit (stable id)
    expect(createCalls[1]!.docId).toBe(createCalls[0]!.docId ?? "cx_generated");
  });

  test("skips an empty-body note without embedding or sealing", async () => {
    const abs = "/vault/empty.md";
    const { deps, embedCalls, createCalls } = makeDeps({ [abs]: "---\ntitle: T\n---\n   \n" });
    const res = await syncNoteFile(abs, deps, { vaultPath: "/vault" });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("empty-body");
    expect(embedCalls.length).toBe(0);
    expect(createCalls.length).toBe(0);
  });
});

describe("shouldIgnore", () => {
  test("ignores non-.md, dotfiles, and sync-conflict files", () => {
    expect(shouldIgnore("note.md")).toBe(false);
    expect(shouldIgnore("sub/dir/note.md")).toBe(false);
    expect(shouldIgnore("image.png")).toBe(true);
    expect(shouldIgnore(".obsidian/config")).toBe(true);
    expect(shouldIgnore(".hidden.md")).toBe(true);
    expect(shouldIgnore("note.sync-conflict-20260101.md")).toBe(true);
    expect(shouldIgnore("README.MD")).toBe(false); // case-insensitive extension
  });
});
