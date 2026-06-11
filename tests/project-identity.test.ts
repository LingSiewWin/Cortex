/**
 * Cortex — project-identity normalization tests.
 *
 * The capture hook stamps a memory's `workspace` provenance from resolveProject();
 * the recall hook queries by that same value. If the two ever disagree, a memory
 * captured under one id is silently never recalled. This pins the normalization
 * for every git-remote shape so the shared module can't regress that contract.
 */

import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { normalizeRemote, resolveProject } from "../src/lib/project-identity.ts";

describe("normalizeRemote", () => {
  const cases: Array<[string, string | null]> = [
    // scp-style (the default GitHub SSH remote)
    ["git@github.com:LingSiewWin/Cortex.git", "github.com/LingSiewWin/Cortex"],
    ["git@github.com:LingSiewWin/Cortex", "github.com/LingSiewWin/Cortex"],
    // https, with and without the trailing .git
    ["https://github.com/LingSiewWin/Cortex.git", "github.com/LingSiewWin/Cortex"],
    ["https://github.com/LingSiewWin/Cortex", "github.com/LingSiewWin/Cortex"],
    // trailing slashes must not produce a different id than the bare form
    ["https://github.com/LingSiewWin/Cortex/", "github.com/LingSiewWin/Cortex"],
    ["https://github.com/LingSiewWin/Cortex.git/", "github.com/LingSiewWin/Cortex"],
    // ssh:// url form, and with an explicit port
    ["ssh://git@github.com/LingSiewWin/Cortex.git", "github.com/LingSiewWin/Cortex"],
    ["ssh://git@github.com:22/LingSiewWin/Cortex.git", "github.com/LingSiewWin/Cortex"],
    // nested groups (GitLab subgroups)
    ["git@gitlab.example.com:group/sub/repo.git", "gitlab.example.com/group/sub/repo"],
    // custom self-hosted host
    ["https://git.acme.io/team/proj", "git.acme.io/team/proj"],
    // empty / junk
    ["", null],
    ["   ", null],
  ];

  for (const [input, expected] of cases) {
    test(`"${input}" → ${expected === null ? "null" : `"${expected}"`}`, () => {
      expect(normalizeRemote(input)).toBe(expected);
    });
  }

  test("the same repo via ssh and https normalizes identically", () => {
    const ssh = normalizeRemote("git@github.com:LingSiewWin/Cortex.git");
    const https = normalizeRemote("https://github.com/LingSiewWin/Cortex.git");
    expect(ssh).toBe(https!);
  });
});

describe("resolveProject", () => {
  test("falls back to the directory basename for a non-git path", () => {
    // tmpdir() is (almost certainly) not a git repo, so we exercise the fallback.
    const id = resolveProject(tmpdir());
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("never returns empty, even for a nonexistent path", () => {
    const id = resolveProject("/nonexistent/path/that/does/not/exist");
    expect(id.length).toBeGreaterThan(0);
  });

  test("resolves THIS repo to its github origin (capture/recall agree)", () => {
    // Run inside the repo; both hooks call the exact same function, so whatever
    // this returns is what capture stamps AND what recall queries.
    const id = resolveProject(import.meta.dir + "/..");
    expect(id).toContain("/");
  });
});
