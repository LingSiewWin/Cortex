/**
 * Cortex — SQLite driver shim for Bun (bun:sqlite) and Node (better-sqlite3).
 *
 * Next.js API routes run on Node during `next build` and on Vercel; the mirror
 * still needs a local SQLite file. Bun keeps using bun:sqlite; Node falls back
 * to better-sqlite3 with the same prepare/run/get/all surface.
 */

export type MirrorStatement = {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

export type MirrorDatabase = {
  exec(sql: string): void;
  prepare(sql: string): MirrorStatement;
  close(): void;
  transaction<T>(fn: () => T): () => T;
};

async function openWithBun(path: string): Promise<MirrorDatabase | null> {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { create: true }) as unknown as MirrorDatabase;
  } catch {
    return null;
  }
}

async function openWithNode(path: string): Promise<MirrorDatabase> {
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  return new BetterSqlite3(path) as unknown as MirrorDatabase;
}

export async function openMirrorDatabase(path: string): Promise<MirrorDatabase> {
  const bunDb = await openWithBun(path);
  if (bunDb) return bunDb;
  return openWithNode(path);
}
