import { dispatchSseRequest } from "@/src/server/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return dispatchSseRequest(req);
}
