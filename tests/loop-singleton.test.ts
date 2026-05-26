/**
 * Cortex — loop-singleton.ts tests (offline; never starts a real Braga loop).
 *
 * Guards the control surface:
 *   - no USER_PRIMARY_ADDRESS → startSingletonLoop returns null (read-only mode)
 *   - status reports not-configured when no loop
 *   - control returns 409 when no loop, 400 on bad action / bad JSON
 *
 * We never call startSingletonLoop with a wallet configured (that would start a
 * real timer + hit Braga), so these stay pure.
 */

import { test, expect, afterEach } from "bun:test";
import {
  startSingletonLoop,
  handleLoopStatus,
  handleLoopControl,
  _resetLoopSingleton,
} from "../src/agent/loop-singleton";

afterEach(() => {
  _resetLoopSingleton();
});

function controlReq(body: string): Request {
  return new Request("http://localhost/api/loop/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("startSingletonLoop returns null with no USER_PRIMARY_ADDRESS (read-only)", () => {
  const saved = process.env.USER_PRIMARY_ADDRESS;
  delete process.env.USER_PRIMARY_ADDRESS;
  _resetLoopSingleton();
  try {
    expect(startSingletonLoop()).toBeNull();
  } finally {
    if (saved !== undefined) process.env.USER_PRIMARY_ADDRESS = saved;
  }
});

test("handleLoopStatus reports not-configured when no loop is running", async () => {
  _resetLoopSingleton();
  const body = (await handleLoopStatus().json()) as {
    running: boolean;
    configured: boolean;
  };
  expect(body.running).toBe(false);
  expect(body.configured).toBe(false);
});

test("handleLoopControl returns 409 when no loop is running", async () => {
  _resetLoopSingleton();
  const res = await handleLoopControl(controlReq(JSON.stringify({ action: "pause" })));
  expect(res.status).toBe(409);
});

test("handleLoopControl rejects an invalid action with 400", async () => {
  const res = await handleLoopControl(controlReq(JSON.stringify({ action: "nope" })));
  expect(res.status).toBe(400);
});

test("handleLoopControl rejects invalid JSON with 400", async () => {
  const res = await handleLoopControl(controlReq("{ not json"));
  expect(res.status).toBe(400);
});
