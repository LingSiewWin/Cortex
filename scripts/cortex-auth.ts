#!/usr/bin/env bun
/**
 * `cortex auth` — frictionless wallet onboarding for the Cortex plugin.
 *
 * The `gh auth login --web` pattern, for a wallet. No pasted private keys, no env
 * vars. One command, one signature:
 *   1. generate a session keypair locally (the hot key that signs Arkiv writes),
 *   2. serve a tiny connect page on 127.0.0.1:<ephemeral port>,
 *   3. open the browser; the user connects their wallet + signs ONE message and
 *      (optionally) pastes an embedding key,
 *   4. verify the signature recovers to the connected address, then write
 *      ~/.cortex/config.json (atomic, 0600) and print a faucet link.
 *
 * Security: 127.0.0.1 only; the signature (not the wallet key) is the real
 * authenticator (we verify recoverMessageAddress === address); the session
 * PRIVATE key never leaves this process (the page only sees its address); the
 * embedding key is POSTed to localhost only. See the design spec.
 */

import { join, normalize } from "node:path";
import { existsSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress, type Hex } from "viem";
import { keyDerivationMessage } from "../src/lib/crypto.ts";
import { writeConfig, type EmbeddingProvider } from "../src/lib/cortex-config.ts";
import { BRAGA } from "../src/constants.ts";

/**
 * The connect page is a RainbowKit React app built SEPARATELY to dist/connect/
 * (browser target — see scripts/build-plugin.ts for why it can't be bundled into
 * this server file). We serve those static files at runtime. Resolved relative to
 * wherever this file runs from:
 *   - standalone bundle:  cortex-plugin/dist/cortex-auth.js  → ./connect
 *   - dev (bun scripts/): scripts/cortex-auth.ts             → ../cortex-plugin/dist/connect
 * Run `bun run build:plugin` once so dist/connect exists before `cortex auth` in dev.
 */
function resolveConnectDir(): string {
  const candidates = [
    join(import.meta.dir, "connect"),
    join(import.meta.dir, "..", "cortex-plugin", "dist", "connect"),
  ];
  return candidates.find((c) => existsSync(join(c, "index.html"))) ?? candidates[0]!;
}

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const VALID_PROVIDERS: EmbeddingProvider[] = ["openai", "openrouter", "voyage", "cohere"];

interface CallbackBody {
  address?: string;
  signature?: string;
  embeddingKey?: string;
  embeddingProvider?: string;
  state?: string;
}

function log(...a: unknown[]): void {
  console.error("[cortex/auth]", ...a);
}

/** Open `url` in the default browser, cross-platform. Best-effort. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {
    /* fall back to the printed URL */
  }
}

async function main(): Promise<void> {
  // 1. Generate the session key locally (never leaves this process).
  const sessionKeyPrivate = generatePrivateKey();
  const sessionAddress = privateKeyToAccount(sessionKeyPrivate).address;
  const state = crypto.randomUUID();

  // 2/3. Serve the connect page + callback on 127.0.0.1; resolve on success.
  const done = Promise.withResolvers<{
    ownerAddress: Hex;
    userSignature: Hex;
    embeddingKey?: string;
    embeddingProvider?: EmbeddingProvider;
  }>();

  const handleCallback = async (req: Request): Promise<Response> => {
    // Loopback-origin guard (defense-in-depth; signature is the real auth).
    const origin = req.headers.get("origin");
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return new Response("bad origin", { status: 403 });
    }
    let body: CallbackBody;
    try {
      body = (await req.json()) as CallbackBody;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (body.state !== state) return new Response("bad state", { status: 403 });
    const address = body.address;
    const signature = body.signature;
    if (!address || !signature) return new Response("missing fields", { status: 400 });

    // THE real authenticator: the signature must recover to the connected
    // address over the EXACT canonical message — else the derived key won't
    // match and recall would silently miss.
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message: keyDerivationMessage(address),
        signature: signature as Hex,
      });
    } catch {
      return new Response("bad signature", { status: 400 });
    }
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return new Response("signature does not match address", { status: 400 });
    }

    const provider =
      body.embeddingProvider && VALID_PROVIDERS.includes(body.embeddingProvider as EmbeddingProvider)
        ? (body.embeddingProvider as EmbeddingProvider)
        : "openai";

    done.resolve({
      ownerAddress: address as Hex,
      userSignature: signature as Hex,
      ...(body.embeddingKey ? { embeddingKey: body.embeddingKey, embeddingProvider: provider } : {}),
    });
    return new Response("ok", { status: 200 });
  };

  const connectDir = resolveConnectDir();
  if (!existsSync(join(connectDir, "index.html"))) {
    throw new Error(
      `connect page not built (looked in ${connectDir}). Run \`bun run build:plugin\` first.`,
    );
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0, // ephemeral
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/callback") return handleCallback(req);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

      // Static serve from connectDir. `/` → index.html; the built index.html
      // references its assets as ./chunk-*.js|css → requested at /chunk-*.
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      // Path-traversal guard: normalize and reject anything escaping connectDir.
      const safe = normalize(join(connectDir, rel));
      if (!safe.startsWith(connectDir)) return new Response("forbidden", { status: 403 });
      const file = Bun.file(safe);
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
  });

  const url = `http://127.0.0.1:${server.port}/?state=${state}`;
  log(`generated your session key (${sessionAddress}).`);
  log(`opening your browser to connect your wallet…\n   ${url}`);
  openBrowser(url);

  const timeout = setTimeout(() => done.reject(new Error("timed out waiting for wallet connection")), AUTH_TIMEOUT_MS);

  let result;
  try {
    result = await done.promise;
  } finally {
    clearTimeout(timeout);
    server.stop(true);
  }

  // 4. Persist + report.
  writeConfig({
    ownerAddress: result.ownerAddress,
    sessionKeyPrivate,
    userSignature: result.userSignature,
    ...(result.embeddingKey ? { embeddingKey: result.embeddingKey, embeddingProvider: result.embeddingProvider } : {}),
  });

  console.error("");
  log(`✓ authed as ${result.ownerAddress}`);
  log(`  encryption key derived from your wallet · config written to ~/.cortex/config.json`);
  if (!result.embeddingKey) log(`  (no embedding key set — add one later, or it'll prompt)`);
  log(`  fund the session key so it can write to Arkiv:`);
  log(`    ${sessionAddress}`);
  log(`    ${BRAGA.faucet}`);
  console.error("");
  log(`you're set — start coding; Cortex will remember.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log(`auth not completed: ${err instanceof Error ? err.message : String(err)}`);
    log(`re-run \`cortex auth\` to try again.`);
    process.exit(1);
  });
