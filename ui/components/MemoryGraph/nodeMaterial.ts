/**
 * Cortex — node ShaderMaterial for the Mapper graph.
 *
 * One material shared by the single InstancedMesh that draws every node. Per
 * the TouchDesigner skill: emissive intensity is DATA, not a constant —
 *
 *   vGlow = (0.25 + aLease * 1.4) * breathe + aPulse * 2.5
 *
 * which pushes warm/cited nodes HDR-bright (>1.0) so `<Bloom>` isolates them,
 * while cold/decaying nodes dim toward the near-black background. Tier hue rides
 * on the built-in `instanceColor`; the fragment is a soft radial-falloff
 * billboard disc (cheapest glow primitive — no sphere tessellation).
 *
 * Authored as a raw THREE.ShaderMaterial to match the repo convention
 * (`ui/components/MemoryHero/DataField.tsx`), not drei's shaderMaterial.
 *
 * Per-instance attributes the InstancedMesh must provide (InstancedBufferAttribute):
 *   aPulse  float  citation flash, 0..N (decays in the store)
 *   aLease  float  0..1 lease remaining → brightness baseline
 *   aBirth  float  birth time (store seconds) → secondary modulation
 *   aPhase  float  0..2π deterministic phase → organic multi-sine pulse
 *   aSpawn  float  0..1 spawn-in (alpha + scale ease)
 */

import * as THREE from "three";

export function createNodeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false, // additive glow discs must not occlude each other
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aPulse;
      attribute float aLease;
      attribute float aBirth;
      attribute float aPhase;
      attribute float aSpawn;

      uniform float uTime;

      varying float vGlow;
      varying float vAlpha;
      varying float vFlicker;
      varying vec3  vTier;
      varying vec2  vUv;

      // NOTE: do NOT declare the instanceColor attribute here. When the
      // InstancedMesh has an instanceColor buffer (we call setColorAt), three.js
      // sets USE_INSTANCING_COLOR and injects the instanceColor attribute
      // declaration into the vertex prefix itself. Re-declaring it duplicates the
      // attribute, so the program fails to link (WebGL INVALID_OPERATION:
      // useProgram: program not valid) and the whole InstancedMesh draws nothing.
      // We only READ it below, guarded by the same define three provides.

      void main() {
        vUv = uv;

        #ifdef USE_INSTANCING_COLOR
          vTier = instanceColor;
        #else
          vTier = vec3(1.0);
        #endif

        // Organic multi-frequency "neural" pulse — dim/bright like living tissue.
        // Lease sets the baseline metabolism; phase desynchronizes nodes.
        float t = uTime;
        float slow = sin(t * 0.48 + aPhase);
        float mid  = sin(t * 0.92 + aPhase * 1.73 + aBirth * 0.4);
        float fast = sin(t * 1.65 + aPhase * 2.41);
        float organic = 0.58 + 0.22 * slow + 0.14 * mid + 0.06 * fast;
        organic = clamp(organic, 0.35, 1.0);

        float pulse = aPulse;
        float leaseGlow = 0.1 + aLease * 1.65;
        vGlow = leaseGlow * organic + pulse * 2.8;
        vFlicker = 0.82 + 0.18 * sin(t * 1.08 + aPhase * 0.55);

        // Fade-in on spawn; subtle scale breathe on the billboard.
        vAlpha = clamp(aSpawn, 0.0, 1.0);
        float scaleBreathe = 0.92 + 0.08 * organic;

        // Standard instanced billboard: instanceMatrix carries position+scale,
        // the quad is oriented to face the camera in view space.
        vec4 mvCenter = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float scale = length(instanceMatrix[0].xyz) * scaleBreathe;
        mvCenter.xy += position.xy * scale;
        gl_Position = projectionMatrix * mvCenter;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      varying float vGlow;
      varying float vAlpha;
      varying float vFlicker;
      varying vec3  vTier;
      varying vec2  vUv;

      void main() {
        // Soft radial falloff billboard disc.
        float d = distance(vUv, vec2(0.5));
        // smooth core + halo; discard outside the disc to save overdraw.
        float disc = smoothstep(0.5, 0.0, d);
        if (disc <= 0.0) discard;

        // Bright core, softer rim.
        float core = pow(disc, 1.5);
        vec3 col = vTier * vGlow * core;
        float a = core * vAlpha * vFlicker;
        gl_FragColor = vec4(col, a);
      }
    `,
  });
}
