/**
 * MemoryHero — the full-viewport 3D hero for the Cortex landing page.
 *
 * Composes the chrome memory tower, the glowing data field, and the spiraling
 * jellyfish energy source, plus the per-frame InfluenceController that drives
 * the shared GPU uniforms. HeroOverlay sits as an HTML sibling over the canvas.
 *
 * MemoryTower / DataField / Jellyfish are authored by sibling agents. Contract:
 *   <MemoryTower />            — no props
 *   <DataField />              — no props
 *   <Jellyfish headRef={...} /> — writes its head world-pos into headRef each frame
 */

import * as React from "react";
import { useRef } from "react";
import * as THREE from "three";
import { Canvas } from "@react-three/fiber";
import { Environment, OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { PALETTE } from "./constants";
import { InfluenceController } from "./useInfluence";
import { MemoryTower } from "./MemoryTower";
import { DataField } from "./DataField";
import { Jellyfish } from "./Jellyfish";
import { HeroOverlay } from "./HeroOverlay";

export default function MemoryHero() {
  // One shared head-position ref: Jellyfish writes it, InfluenceController reads it.
  const headRef = useRef<THREE.Vector3>(new THREE.Vector3());

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100vh",
        background: PALETTE.bg,
        overflow: "hidden",
      }}
    >
      <Canvas
        camera={{ position: [14, 7, 22], fov: 42 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.62 }}
        dpr={[1, 2]}
        style={{ position: "absolute", inset: 0 }}
        onCreated={({ scene }) => {
          scene.background = new THREE.Color(PALETTE.bg);
        }}
      >
        {/* chrome reflections */}
        <Environment preset="city" />

        {/* lighting: ambient fill + key + rim */}
        <ambientLight intensity={0.35} />
        <directionalLight position={[10, 18, 12]} intensity={1.6} color="#FFFFFF" />
        <directionalLight position={[-12, 6, -10]} intensity={0.9} color={PALETTE.accent} />

        {/* scene */}
        <MemoryTower />
        <DataField />
        <Jellyfish headRef={headRef} />
        <InfluenceController headRef={headRef} />

        {/* glow */}
        <EffectComposer>
          <Bloom
            intensity={0.14}
            luminanceThreshold={0.75}
            luminanceSmoothing={0.9}
            mipmapBlur
          />
        </EffectComposer>

        <OrbitControls
          enableDamping
          autoRotate
          autoRotateSpeed={0.35}
          enablePan={false}
          minDistance={14}
          maxDistance={40}
        />
      </Canvas>

      <HeroOverlay />
    </div>
  );
}
