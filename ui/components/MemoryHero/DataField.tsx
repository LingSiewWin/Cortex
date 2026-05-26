import { useMemo } from "react";
import * as THREE from "three";
import { COLS, ROWS, HEIGHT, STEP, TOWER, PALETTE, sharedUniforms } from "./constants";

/**
 * DataField — a dense cloud of glowing "data" particles filling the tower volume.
 *
 * The cloud is invisible by default. Each point is only drawn when it sits inside
 * a thin spherical SHELL around the nearest influence point (jellyfish head or
 * cursor): the hollow-shell mask in the vertex shader sets gl_PointSize to 0
 * outside the ring (radius-thickness .. radius), so blocks reveal the data
 * "underneath" them only where energy passes — memory that activates on access.
 *
 * Uses a custom ShaderMaterial (NOT PointsMaterial) so gl_PointSize is authored
 * directly inside our vertex shader and the mask actually fires.
 */
export function DataField() {
  // ~5x the block count → cloud filling the tower bounding box.
  const COUNT = useMemo(() => 5 * (COLS * ROWS * HEIGHT), []);

  const geometry = useMemo(() => {
    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT); // per-point random for subtle flicker

    const halfW = TOWER.width / 2;
    const halfD = TOWER.depth / 2;

    for (let i = 0; i < COUNT; i++) {
      positions[i * 3 + 0] = -halfW + Math.random() * TOWER.width;
      positions[i * 3 + 1] = TOWER.yBase + Math.random() * TOWER.height;
      positions[i * 3 + 2] = -halfD + Math.random() * TOWER.depth;
      seeds[i] = Math.random() * 6.2831853; // [0, 2π)
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
    return geo;
  }, [COUNT]);

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        // EXACT shared uniform objects — one update elsewhere feeds this material.
        u_inflA: sharedUniforms.u_inflA,
        u_inflB: sharedUniforms.u_inflB,
        u_radius: sharedUniforms.u_radius,
        u_thickness: sharedUniforms.u_thickness,
        u_time: sharedUniforms.u_time,
        u_size: { value: 9.0 },
        u_color: {
          value: new THREE.Color(PALETTE.data),
        },
      },
      vertexShader: /* glsl */ `
        uniform vec3 u_inflA;
        uniform vec3 u_inflB;
        uniform float u_radius;
        uniform float u_thickness;
        uniform float u_time;
        uniform float u_size;

        attribute float seed;

        void main() {
          // Distance to the nearest influence point (jellyfish head or cursor).
          float d = min(distance(position, u_inflA), distance(position, u_inflB));

          // Hollow shell: 1.0 only inside the ring (u_radius - u_thickness .. u_radius).
          float vis = step(u_radius - u_thickness, d) * step(d, u_radius);

          // Subtle per-point flicker so the shell shimmers instead of reading static.
          float flicker = 0.85 + 0.15 * sin(u_time * 3.0 + seed);

          vec4 mv = modelViewMatrix * vec4(position, 1.0);

          // Size attenuation; multiplied by vis → 0 (invisible) outside the shell.
          gl_PointSize = u_size * vis * flicker * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 u_color;

        void main() {
          // Soft round glowing point.
          float a = smoothstep(0.5, 0.0, distance(gl_PointCoord, vec2(0.5)));
          if (a <= 0.0) discard;
          gl_FragColor = vec4(u_color * 0.75, a * 0.7); // dimmer so the revealed shell doesn't blow to white
        }
      `,
    });
  }, []);

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}

export default DataField;
