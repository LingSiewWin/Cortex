/**
 * Cortex — Obsidian note codec tests (PURE: no I/O, no network).
 *
 * Covers:
 *   1. parse/serialize round-trip preserves user frontmatter + body
 *   2. parseNote splits the `cortex:` block out of user frontmatter
 *   3. splitSections offsets are correct (slicing body at offset returns section)
 *   4. contentSha256 is stable + matches a known vector
 *   5. stampCortexBlock adds the cortex block without clobbering user fields/body
 */

import { test, expect, describe } from "bun:test";
import {
  parseNote,
  serializeNote,
  splitSections,
  contentSha256,
  stampCortexBlock,
} from "../src/obsidian/note.ts";

describe("parseNote / serializeNote round-trip", () => {
  test("preserves user frontmatter fields and body", () => {
    const raw = `---
title: My Note
tags:
  - alpha
  - beta
aliases:
  - mn
custom: 42
---
# Heading

Some body text with **bold**.
`;
    const parsed = parseNote(raw);
    expect(parsed.frontmatter.title).toBe("My Note");
    expect(parsed.frontmatter.tags).toEqual(["alpha", "beta"]);
    expect(parsed.frontmatter.aliases).toEqual(["mn"]);
    expect(parsed.frontmatter.custom).toBe(42);
    expect(parsed.body).toContain("# Heading");
    expect(parsed.body).toContain("**bold**");
    expect(parsed.cortex).toBeUndefined();

    // Round-trip: re-parse the serialized form, fields survive.
    const serialized = serializeNote(parsed);
    const reparsed = parseNote(serialized);
    expect(reparsed.frontmatter.title).toBe("My Note");
    expect(reparsed.frontmatter.tags).toEqual(["alpha", "beta"]);
    expect(reparsed.frontmatter.aliases).toEqual(["mn"]);
    expect(reparsed.frontmatter.custom).toBe(42);
    expect(reparsed.body.trim()).toBe(parsed.body.trim());
  });

  test("a note with no frontmatter round-trips to body only", () => {
    const raw = "Just a body, no frontmatter.\n";
    const parsed = parseNote(raw);
    expect(parsed.frontmatter).toEqual({});
    const serialized = serializeNote(parsed);
    expect(serialized).toBe(raw);
  });

  test("splits the cortex: block out of user frontmatter", () => {
    const raw = `---
title: Sealed Note
cortex:
  docId: cx_abc123
  contentSha256: deadbeef
  arkivEntityKey: "0xfeed"
  tier: rule
  schemaVersion: 1
---
Body.
`;
    const parsed = parseNote(raw);
    // User frontmatter must NOT contain the cortex key.
    expect(parsed.frontmatter.cortex).toBeUndefined();
    expect(parsed.frontmatter.title).toBe("Sealed Note");
    // cortex block is surfaced separately.
    expect(parsed.cortex?.docId).toBe("cx_abc123");
    expect(parsed.cortex?.contentSha256).toBe("deadbeef");
    expect(parsed.cortex?.arkivEntityKey).toBe("0xfeed");
    expect(parsed.cortex?.tier).toBe("rule");
    expect(parsed.cortex?.schemaVersion).toBe(1);
  });
});

describe("splitSections", () => {
  test("offsets slice the body back into exact sections", () => {
    const body = `Preamble line.

# First

content one

## Second

content two
`;
    const spans = splitSections(body);
    // Preamble (synthetic ""), then two headings.
    expect(spans.map((s) => s.heading)).toEqual(["", "First", "Second"]);

    // Slicing at consecutive offsets must reproduce each section.
    for (let i = 0; i < spans.length; i++) {
      const start = spans[i]!.offset;
      const end = i + 1 < spans.length ? spans[i + 1]!.offset : body.length;
      const slice = body.slice(start, end);
      if (spans[i]!.heading !== "") {
        // Heading section starts with the heading text.
        expect(slice).toContain(spans[i]!.heading);
        expect(slice.trimStart().startsWith("#")).toBe(true);
      }
    }

    // Concatenating all slices reconstructs the body exactly.
    let rebuilt = "";
    for (let i = 0; i < spans.length; i++) {
      const start = spans[i]!.offset;
      const end = i + 1 < spans.length ? spans[i + 1]!.offset : body.length;
      rebuilt += body.slice(start, end);
    }
    expect(rebuilt).toBe(body);
  });

  test("a heading-only note (no preamble) has no synthetic preamble span", () => {
    const body = `# Only Heading

content
`;
    const spans = splitSections(body);
    expect(spans.map((s) => s.heading)).toEqual(["Only Heading"]);
    expect(spans[0]!.offset).toBe(0);
  });

  test("a note with no headings is one synthetic preamble span", () => {
    const body = "no headings here\njust text\n";
    const spans = splitSections(body);
    expect(spans.length).toBe(1);
    expect(spans[0]!.heading).toBe("");
    expect(spans[0]!.offset).toBe(0);
    expect(body.slice(spans[0]!.offset)).toBe(body);
  });

  test("does not treat a mid-line '#' as a heading", () => {
    const body = "text with a # in the middle\n# Real Heading\n";
    const spans = splitSections(body);
    expect(spans.map((s) => s.heading)).toEqual(["", "Real Heading"]);
  });
});

describe("contentSha256", () => {
  test("is stable and matches the known SHA-256 of 'abc'", async () => {
    // SHA-256("abc") canonical vector.
    const h = await contentSha256("abc");
    expect(h).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("same input → same hash; different input → different hash", async () => {
    const a = await contentSha256("hello world");
    const b = await contentSha256("hello world");
    const c = await contentSha256("hello worlD");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("stampCortexBlock", () => {
  test("adds the cortex block without clobbering user frontmatter or body", () => {
    const raw = `---
title: Keep Me
tags:
  - x
---
# Body Heading

Body content stays put.
`;
    const stamped = stampCortexBlock(raw, {
      docId: "cx_999",
      arkivEntityKey: "0xabc",
      contentSha256: "cafef00d",
      tier: "rule",
    });

    const parsed = parseNote(stamped);
    // User fields untouched.
    expect(parsed.frontmatter.title).toBe("Keep Me");
    expect(parsed.frontmatter.tags).toEqual(["x"]);
    // Body untouched.
    expect(parsed.body).toContain("# Body Heading");
    expect(parsed.body).toContain("Body content stays put.");
    // Cortex block present + schemaVersion defaulted.
    expect(parsed.cortex?.docId).toBe("cx_999");
    expect(parsed.cortex?.arkivEntityKey).toBe("0xabc");
    expect(parsed.cortex?.contentSha256).toBe("cafef00d");
    expect(parsed.cortex?.tier).toBe("rule");
    expect(parsed.cortex?.schemaVersion).toBe(1);
  });

  test("merges into an existing cortex block (new fields win, others kept)", () => {
    const raw = `---
title: T
cortex:
  docId: cx_keep
  contentSha256: oldsha
  schemaVersion: 1
---
Body.
`;
    const stamped = stampCortexBlock(raw, { contentSha256: "newsha", arkivEntityKey: "0x1" });
    const parsed = parseNote(stamped);
    expect(parsed.cortex?.docId).toBe("cx_keep"); // preserved
    expect(parsed.cortex?.contentSha256).toBe("newsha"); // overwritten
    expect(parsed.cortex?.arkivEntityKey).toBe("0x1"); // added
    expect(parsed.frontmatter.title).toBe("T");
  });

  test("stamps a note that had no frontmatter at all", () => {
    const raw = "Body only, no YAML.\n";
    const stamped = stampCortexBlock(raw, { docId: "cx_new" });
    const parsed = parseNote(stamped);
    expect(parsed.cortex?.docId).toBe("cx_new");
    expect(parsed.body.trim()).toBe("Body only, no YAML.");
  });
});
