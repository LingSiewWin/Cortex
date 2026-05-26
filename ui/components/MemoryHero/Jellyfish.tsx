import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { PALETTE, TOWER } from "./constants";

/**
 * Jellyfish — a faithful 3D-billboarded recreation of the p5.js "Yuruyurau"
 * parametric point-jellyfish (your digital-jellyfish sketch).
 *
 * KEY FIX vs the earlier version: the original is a 2D form. Revolving it around
 * an axis (what I did before) destroyed the silhouette and made a featureless
 * blob. Instead we keep the EXACT 2D parametric (px, py) and BILLBOARD the whole
 * point cloud — every point is offset from the creature's center IN VIEW SPACE,
 * so the recognizable jellyfish shape always faces the camera while the cloud
 * swims around the tower. (No CPU per-point loop: the parametric math + the
 * billboard run in the vertex shader; only the orbit transform updates per frame.)
 *
 * Original sketch (reimplemented in GLSL, not copied):
 *   x = i % 200;  y = i / 43
 *   k = 5*cos(x/14)*cos(y/30);   e = y/8 - 13
 *   d = mag(k,e)^2/59 + 4
 *   q = 60 - 3*sin(atan2(k,e)*e) + k*(3 + 4/d*sin(d*d - t*2))
 *   rot = d/2 + e/99 - t/18
 *   px = q*sin(rot);  py = (q + d*9)*cos(rot)
 */

const POINT_COUNT = 10000;
const X_MOD = 200;
const Y_DIV = 43;
const OMEGA = 0.2; // orbit speed (rad/s) around the tower
const CLIMB_PERIOD = 24; // seconds per bottom→top climb

const _wp = new THREE.Vector3();

export interface JellyfishProps {
  headRef: React.MutableRefObject<THREE.Vector3>;
}

export function Jellyfish({ headRef }: JellyfishProps) {
  const groupRef = useRef<THREE.Group>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const indices = new Float32Array(POINT_COUNT);
    for (let i = 0; i < POINT_COUNT; i++) indices[i] = i;
    geo.setAttribute("a_index", new THREE.BufferAttribute(indices, 1));
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(POINT_COUNT * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 14);
    return geo;
  }, []);

  const uniforms = useMemo(
    () => ({
      u_time: { value: 0 },
      u_color: { value: new THREE.Color(PALETTE.jelly) },
      u_scale: { value: 0.045 }, // p5 form is ~hundreds of units; bring it to ~tower height
      u_size: { value: 30.0 },
    }),
    [],
  );

  const vertexShader = /* glsl */ `
    attribute float a_index;
    uniform float u_time;
    uniform float u_scale;
    uniform float u_size;
    varying float v_alpha;

    const float X_MOD = ${X_MOD.toFixed(1)};
    const float Y_DIV = ${Y_DIV.toFixed(1)};

    void main() {
      float t = u_time;
      float i = a_index;

      // --- exact 2D Yuruyurau parametric form (reimplemented) ---
      float x = mod(i, X_MOD);
      float y = i / Y_DIV;
      float k = 5.0 * cos(x / 14.0) * cos(y / 30.0);
      float e = y / 8.0 - 13.0;
      float d = (k*k + e*e) / 59.0 + 4.0;
      float q = 60.0 - 3.0 * sin(atan(k, e) * e) + k * (3.0 + 4.0 / d * sin(d*d - t*2.0));
      float rot = d / 2.0 + e / 99.0 - t / 18.0;
      float px = q * sin(rot);
      float py = (q + d * 9.0) * cos(rot);

      // 2D offset from the creature's center (flip Y: bell up, tentacles trail down)
      vec2 offset = vec2(px, -py) * u_scale;

      // BILLBOARD: place the creature's center (group origin) in view space, then
      // add the 2D offset in screen-aligned axes so the jellyfish always faces us.
      vec4 centerView = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      centerView.xy += offset;
      gl_Position = projectionMatrix * centerView;

      float dist = -centerView.z;
      gl_PointSize = clamp(u_size * u_scale * 34.0 / max(dist, 0.1), 2.0, 13.0);

      // tentacle tips (high d) a touch dimmer than the bell
      v_alpha = clamp(1.1 - d * 0.02, 0.25, 1.0);
    }
  `;

  const fragmentShader = /* glsl */ `
    precision mediump float;
    uniform vec3 u_color;
    varying float v_alpha;
    void main() {
      float r = length(gl_PointCoord - vec2(0.5));
      if (r > 0.5) discard;
      float glow = pow(smoothstep(0.5, 0.0, r), 2.2);
      // dim + additive so dense areas (the bell) read as glow without blowing white
      gl_FragColor = vec4(u_color * 1.1, glow * v_alpha * 0.55);
    }
  `;

  useFrame((state, delta) => {
    const uTime = matRef.current?.uniforms.u_time;
    if (uTime) uTime.value += delta;
    const group = groupRef.current;
    if (!group) return;

    const clock = state.clock.elapsedTime;
    const theta = clock * OMEGA;
    const maxWD = Math.max(TOWER.width, TOWER.depth);
    // swoop: fly out into open space, dive in to graze + bite the tower, repeat
    const R = maxWD * (1.15 + 0.35 * Math.sin(clock * 0.45));
    const climb = (clock % CLIMB_PERIOD) / CLIMB_PERIOD;
    group.position.set(
      R * Math.cos(theta),
      TOWER.yBase + climb * TOWER.height,
      R * Math.sin(theta),
    );

    // head world pos → influence system (so it bites the tower as it dives in)
    group.getWorldPosition(_wp);
    headRef.current.copy(_wp);
  });

  return (
    <group ref={groupRef}>
      <points geometry={geometry}>
        <shaderMaterial
          ref={matRef}
          uniforms={uniforms}
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}

export default Jellyfish;
