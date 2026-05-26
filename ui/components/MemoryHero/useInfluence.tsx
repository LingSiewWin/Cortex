/**
 * InfluenceController — the single per-frame GPU handoff for the MemoryHero scene.
 *
 * Rendered INSIDE the <Canvas>. Each frame it:
 *   1. copies the jellyfish head world-pos (written by Jellyfish into headRef) → u_inflA
 *   2. raycasts the cursor onto a camera-facing plane through the world origin → u_inflB
 *      (falls back to a far point (9999) when the pointer has never moved or misses)
 *   3. advances u_time
 *
 * No per-object loops. The tower + data materials both reference the same
 * sharedUniforms objects, so these ~5 writes feed the entire scene.
 */

import * as React from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { sharedUniforms } from "./constants";


export function InfluenceController({
  headRef,
}: {
  headRef: React.MutableRefObject<THREE.Vector3>;
}) {
  useFrame((_state, delta) => {
    // Jellyfish head → u_inflA. (Cursor → u_inflB is driven by the tower's OWN
    // pointer raycast in MemoryTower, so the eaten spot lands on the surface the
    // user is actually pointing at — not a plane through the tower's center,
    // which sat behind the front face and never reached the visible blocks.)
    if (headRef.current) {
      sharedUniforms.u_inflA.value.copy(headRef.current);
    }
    sharedUniforms.u_time.value += delta;
  });

  return null;
}
