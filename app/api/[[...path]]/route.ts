import type { NextRequest } from "next/server";
import { dispatchApiRequest } from "@/src/server/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: NextRequest, path: string[]) {
  const pathname = `/api/${path.join("/")}`;
  return dispatchApiRequest(req, pathname);
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await ctx.params;
  return handle(req, path);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await ctx.params;
  return handle(req, path);
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await ctx.params;
  return handle(req, path);
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await ctx.params;
  return handle(req, path);
}
