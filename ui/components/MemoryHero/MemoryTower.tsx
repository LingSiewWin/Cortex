import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  COLS,
  ROWS,
  HEIGHT,
  STEP,
  BLOCK,
  PALETTE,
  sharedUniforms,
} from "./constants";

/**
 * MemoryTower — chrome "memory blocks" as a single InstancedMesh.
 *
 * Clean SPHERE-MASK voxel dissolve (the "bite"): each block's distance to the
 * nearest influence point (cursor and/or jellyfish) is computed in the vertex
 * shader; a `smoothstep` maps that distance to a scale in [0,1] — 0 inside the
 * radius (the block gracefully shrinks to nothing) and 1 outside. The soft
 * gradient at the edge is what makes the dissolve buttery-smooth. The hollow
 * shell of glowing data particles (see DataField) fills the bitten-out hole.
 *
 * 100% on the GPU: instance matrices are written once; no per-block CPU loop in
 * any frame. The cursor influence is a single raycast on this mesh (onPointerMove).
 */
export function MemoryTower() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = COLS * ROWS * HEIGHT;

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE.block),
      metalness: 0.9,
      roughness: 0.25,
    });

    mat.onBeforeCompile = (shader) => {
      // Shared influence uniforms by reference (updated by InfluenceController
      // for the jellyfish + by onPointerMove below for the cursor).
      shader.uniforms.u_inflA = sharedUniforms.u_inflA;
      shader.uniforms.u_inflB = sharedUniforms.u_inflB;
      shader.uniforms.u_radius = sharedUniforms.u_radius;

      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform vec3 u_inflA;
        uniform vec3 u_inflB;
        uniform float u_radius;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        // instance world position (group is at the origin, so local == world)
        vec3 insPos = instanceMatrix[3].xyz;
        float d = min(distance(insPos, u_inflA), distance(insPos, u_inflB));
        // buttery dissolve: 0 inside the bite, 1 outside, soft 1.2-unit gradient.
        float scale = smoothstep(u_radius - 1.2, u_radius, d);
        transformed *= scale; // shrink the block in place around its own center`,
      );
    };

    return mat;
  }, []);

  // Write instance matrices once. Tower centered on X/Z, rising in Y.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    let i = 0;
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        for (let h = 0; h < HEIGHT; h++) {
          const x = (c - (COLS - 1) / 2) * STEP;
          const y = -(HEIGHT * STEP) / 2 + h * STEP + STEP / 2;
          const z = (r - (ROWS - 1) / 2) * STEP;
          dummy.position.set(x, y, z);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(i++, dummy.matrix);
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [count]);

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, count]}
        material={material}
        onPointerMove={(e) => {
          // exact surface hit -> the cursor eats the blocks it's over
          e.stopPropagation();
          sharedUniforms.u_inflB.value.copy(e.point);
        }}
        onPointerOut={() => sharedUniforms.u_inflB.value.set(9999, 9999, 9999)}
      >
        <boxGeometry args={[BLOCK, BLOCK, BLOCK]} />
      </instancedMesh>
    </group>
  );
}

export default MemoryTower;
