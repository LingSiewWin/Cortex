import * as THREE from "three";
export const COLS = 6, ROWS = 6, HEIGHT = 20, STEP = 1.0, BLOCK = 0.9;
export const RADIUS = 4.2, THICKNESS = 1.7;
export const PALETTE = { bg: "#0A0B0E", block: "#C8CDD6", data: "#8CFF8A", jelly: "#5EEAD4", accent: "#5EEAD4" };
export const TOWER = { width: COLS * STEP, depth: ROWS * STEP, height: HEIGHT * STEP, yBase: -(HEIGHT * STEP) / 2 };
export const sharedUniforms = {
  u_inflA: { value: new THREE.Vector3(9999, 9999, 9999) }, // jellyfish head world pos
  u_inflB: { value: new THREE.Vector3(9999, 9999, 9999) }, // cursor world pos
  u_radius: { value: RADIUS },
  u_thickness: { value: THICKNESS },
  u_time: { value: 0 },
};
