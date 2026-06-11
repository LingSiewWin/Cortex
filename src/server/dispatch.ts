/**
 * Cortex — HTTP API dispatch (shared by Bun.serve and Next.js route handlers).
 */

import { handlePlaygroundEncode, handlePlaygroundRecall } from "../api/playground";
import {
  handleCreateAllowance,
  handleGetAllowance,
  handleRefillAllowance,
  handleRecordSpend,
} from "../api/allowance";
import {
  handleStateRootRequest,
  handleStateCommitRequest,
  handleStateAnchorRequest,
  handleStateProofRequest,
} from "../api/state";
import { handleSSE } from "../api/sse";
import { handleTopologyRequest } from "../topology/build-from-mirror";
import { handleManualCitation } from "../api/citation";
import { handleDecayTimelineRequest } from "./decay-timeline";
import { handleAdoptRequest, handleAuthMe } from "../api/auth-adopt";
import { handleSeedRequest } from "../api/seed";
import { handleStoreFileRequest, handleStoreFilePrepareRequest } from "../api/store-file";
import { handleMemoryRegisterRequest } from "../api/memory-register";
import { handleLoopStatus, handleLoopControl } from "../agent/loop-singleton";
import {
  handleHealth,
  handleMemoriesRequest,
  handleMemoryDetailRequest,
  handleDecisionsRequest,
  handleListingsRequest,
  handleEconomicsRequest,
  handleDecayRequest,
  handleSiweInit,
  handleSiweVerify,
  handleSessionAuth,
} from "../ui-server";
import { startCortexWorkers } from "./bootstrap";

type RouteHandler = (req: Request) => Response | Promise<Response>;

type RouteEntry =
  | RouteHandler
  | { GET?: RouteHandler; POST?: RouteHandler; PUT?: RouteHandler; DELETE?: RouteHandler };

const ROUTES: Record<string, RouteEntry> = {
  "/api/health": handleHealth,
  "/api/memories": handleMemoriesRequest,
  "/api/memories/detail": handleMemoryDetailRequest,
  "/api/memories/register": { POST: handleMemoryRegisterRequest },
  "/api/decisions": handleDecisionsRequest,
  "/api/listings": handleListingsRequest,
  "/api/economics": handleEconomicsRequest,
  "/api/decay": handleDecayRequest,
  "/api/decay/timeline": handleDecayTimelineRequest,
  "/api/topology": handleTopologyRequest,
  "/api/auth/siwe/init": { POST: handleSiweInit },
  "/api/auth/siwe/verify": { POST: handleSiweVerify },
  "/api/auth/session": { POST: handleSessionAuth },
  "/api/auth/adopt": { POST: handleAdoptRequest },
  "/api/auth/me": handleAuthMe,
  "/api/seed-memories": { POST: handleSeedRequest },
  "/api/store-file": { POST: handleStoreFileRequest },
  "/api/store-file/prepare": { POST: handleStoreFilePrepareRequest },
  "/api/playground/encode": { POST: handlePlaygroundEncode },
  "/api/playground/recall": { POST: handlePlaygroundRecall },
  "/api/allowance": handleGetAllowance,
  "/api/allowance/create": { POST: handleCreateAllowance },
  "/api/allowance/refill": { POST: handleRefillAllowance },
  "/api/allowance/spend": { POST: handleRecordSpend },
  "/api/state/root": handleStateRootRequest,
  "/api/state/commit": { POST: handleStateCommitRequest },
  "/api/state/anchor": { POST: handleStateAnchorRequest },
  "/api/state/proof": { POST: handleStateProofRequest },
  "/api/citation/manual": {
    POST: (req) => handleManualCitation(req, undefined, "unknown"),
  },
  "/api/loop/status": handleLoopStatus,
  "/api/loop/control": { POST: handleLoopControl },
};

let _workersPromise: Promise<void> | null = null;

function ensureWorkers(): Promise<void> {
  if (!_workersPromise) _workersPromise = startCortexWorkers();
  return _workersPromise;
}

export async function dispatchApiRequest(req: Request, path: string): Promise<Response> {
  await ensureWorkers();

  const entry = ROUTES[path];
  if (!entry) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const method = req.method.toUpperCase();

  if (typeof entry === "function") {
    return entry(req);
  }

  const handler = entry[method as keyof typeof entry];
  if (!handler) {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  return handler(req);
}

export async function dispatchSseRequest(req: Request): Promise<Response> {
  await ensureWorkers();
  return handleSSE(req);
}
