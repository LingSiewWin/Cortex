/**
 * Cortex — Obsidian note codec (PURE: no I/O, no network, fully unit-testable).
 *
 * The Document Tier treats plain `.md` files as the source of truth (per
 * docs/obsidian/findings-repos.md §Synthesis): all three reference vaults keep
 * markdown as the canonical artifact and layer retrieval on top. Cortex adds ONE
 * namespaced `cortex:` block to the frontmatter carrying only recovery metadata
 * (docId, vaultPath, contentSha256, arkivEntityKey, tier, schemaVersion). Every
 * user YAML key + the raw body are preserved so the note still renders in
 * Obsidian and round-trips losslessly.
 *
 * gray-matter is the YAML engine. Per findings-official-docs.md §1 we never
 * string-concat frontmatter — Obsidian normalizes quoting/ordering and a naive
 * round-tripper loses bytes; gray-matter's js-yaml serializer is the safe path.
 */

import matter from "gray-matter";

/** The schema version stamped into every `cortex:` recovery block. */
export const CORTEX_BLOCK_VERSION = 1;

/**
 * Cortex's owned recovery block — the only frontmatter key Cortex writes. Keeps
 * the note's link back to its sovereign Arkiv entity. `docId` is stable across
 * edits/renames; `vaultPath`/`docId` split means a rename doesn't orphan the
 * entity.
 */
export interface CortexBlock {
  /** Stable id for the note across edits + renames (matches the Arkiv `docId` attr). */
  docId?: string;
  /** Vault-relative path at last seal (for recovery placement; renames update it). */
  vaultPath?: string;
  /** sha-256 hex of the body at last seal — the idempotency / round-trip gate. */
  contentSha256?: string;
  /** Arkiv entity key of the sealed document (the recovery handle). */
  arkivEntityKey?: string;
  /** Constellation tier label (documents render as `rule`-tier nodes). */
  tier?: string;
  /** Cortex block schema version. */
  schemaVersion?: number;
  /** ISO timestamp of the last successful seal. */
  updatedAt?: string;
}

export interface ParsedNote {
  /** User frontmatter (the `cortex` key is extracted out into `cortex`). */
  frontmatter: Record<string, unknown>;
  /** The note body (everything after the frontmatter fence). */
  body: string;
  /** Cortex's recovery block, if present. */
  cortex?: CortexBlock;
}

export interface SectionSpan {
  /** Heading text WITHOUT the leading `#`s (empty string for the preamble). */
  heading: string;
  /** Char index of the section start within the FULL note text. */
  offset: number;
}

/**
 * Parse a raw note into `{ frontmatter, body, cortex? }`. The `cortex:` key
 * inside the frontmatter is split out into `cortex` so callers see only the
 * user's fields in `frontmatter`.
 */
export function parseNote(raw: string): ParsedNote {
  const parsed = matter(raw);
  // gray-matter returns `data: {}` for no-frontmatter; clone so we can strip
  // the cortex key without mutating gray-matter's internal object.
  const data: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>) };

  let cortex: CortexBlock | undefined;
  if (data.cortex && typeof data.cortex === "object" && !Array.isArray(data.cortex)) {
    cortex = data.cortex as CortexBlock;
    delete data.cortex;
  }

  return {
    frontmatter: data,
    body: parsed.content,
    ...(cortex ? { cortex } : {}),
  };
}

/**
 * Serialize `{ frontmatter, body }` back to a raw note string. Round-trip
 * guarantee: `parseNote(serializeNote(x))` preserves user fields and body.
 *
 * If the input carries a `cortex` block (e.g. round-tripped from `parseNote`),
 * it is folded back under the `cortex:` frontmatter key.
 */
export function serializeNote(note: {
  frontmatter: Record<string, unknown>;
  body: string;
  cortex?: CortexBlock;
}): string {
  const data: Record<string, unknown> = { ...note.frontmatter };
  if (note.cortex) {
    data.cortex = note.cortex;
  }
  // gray-matter omits the frontmatter fence entirely when data is empty, which
  // is the correct behavior for a note that never had frontmatter.
  if (Object.keys(data).length === 0) {
    return note.body;
  }
  return matter.stringify(note.body, data);
}

/**
 * Split a note body into section spans by markdown ATX headings (lines starting
 * with `#`). `offset` is the char index of the section start within `body`.
 *
 * The first span is a synthetic `""`-heading preamble covering everything before
 * the first heading (only emitted if there is non-empty preamble text, or if the
 * note has no headings at all). Slicing `body` at consecutive offsets reproduces
 * each section exactly.
 *
 * NOTE: callers pass the BODY (post-frontmatter). Offsets are body-relative,
 * matching `splitSections(parseNote(raw).body)`.
 */
export function splitSections(body: string): SectionSpan[] {
  const spans: SectionSpan[] = [];
  // Match ATX headings at the start of a line: one-to-six '#' then a space.
  // Multiline so `^` anchors to each line; we walk matches to get char offsets.
  const headingRe = /^(#{1,6})\s+(.*)$/gm;

  const headings: { offset: number; heading: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    headings.push({ offset: m.index, heading: m[2]!.trim() });
  }

  if (headings.length === 0) {
    // No headings — the whole body is one synthetic preamble section.
    spans.push({ heading: "", offset: 0 });
    return spans;
  }

  // Preamble (text before the first heading) — only if non-whitespace exists.
  const firstOffset = headings[0]!.offset;
  if (body.slice(0, firstOffset).trim().length > 0) {
    spans.push({ heading: "", offset: 0 });
  }

  for (const h of headings) {
    spans.push({ heading: h.heading, offset: h.offset });
  }
  return spans;
}

/** sha-256 hex of a UTF-8 string. Mirrors batch-writer's `sha256Hex`. */
export async function contentSha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Merge a `cortex:` recovery block into a raw note string WITHOUT disturbing the
 * user's other frontmatter fields or the body. Existing cortex fields are
 * shallow-merged with the new ones (new wins). Returns the new raw string.
 *
 * This is the mangle-safe stamp path: parse → set `cortex` → serialize, so the
 * YAML engine owns formatting (per findings-official-docs.md §Gotchas — only a
 * structured frontmatter write is safe).
 */
export function stampCortexBlock(raw: string, cortexFields: CortexBlock): string {
  const parsed = parseNote(raw);
  const merged: CortexBlock = {
    schemaVersion: CORTEX_BLOCK_VERSION,
    ...(parsed.cortex ?? {}),
    ...cortexFields,
  };
  return serializeNote({
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    cortex: merged,
  });
}
