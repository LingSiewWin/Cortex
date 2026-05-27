/**
 * Pixel mosaic transition: mosaic sharpen, then blocks dissolve left → right.
 * No liquid UV distortion — see docs/landing-page/pixel-wave.md
 */

/** Progress 0–1: pixelation finishes, then dissolve wave runs. */
const PIXEL_END = 0.5;
const DISSOLVE_START = 0.5;
const DURATION_MS = 2200;

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_progress;
uniform vec2 u_texSize;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec3 bg = vec3(0.04, 0.04, 0.05);

  // Phase A: grow mosaic block size (full frame stays visible)
  float pixelT = clamp(u_progress / ${PIXEL_END.toFixed(2)}, 0.0, 1.0);
  float blockSize = mix(2.0, 52.0, pow(pixelT, 0.85));
  vec2 blockCount = max(floor(u_texSize / blockSize), vec2(1.0));

  vec2 blockId = floor(v_uv * blockCount);
  blockId = clamp(blockId, vec2(0.0), blockCount - 1.0);
  vec2 blockCenter = (blockId + 0.5) / blockCount;

  // Phase B: dissolution front sweeps left → right (blocks left of front fade out)
  float dissolveT = clamp((u_progress - ${DISSOLVE_START.toFixed(2)}) / ${(1 - DISSOLVE_START).toFixed(2)}, 0.0, 1.0);
  float front = dissolveT * 1.08;
  float stagger = sin(blockId.y * 0.75 + blockId.x * 0.2) * 0.035;
  float x = blockCenter.x + stagger;

  // Full frame visible until dissolve starts (smoothstep(0,…) was fading the left edge too early)
  float vis = dissolveT < 0.001 ? 1.0 : smoothstep(front - 0.02, front + 0.1, x);

  if (vis < 0.01) {
    fragColor = vec4(bg, 1.0);
    return;
  }

  // Crisp mosaic: one texel per block (nearest)
  vec2 pix = floor(blockCenter * u_texSize);
  pix = clamp(pix, vec2(0.0), u_texSize - 1.0);
  vec4 c = texelFetch(u_tex, ivec2(pix), 0);

  fragColor = vec4(mix(bg, c.rgb, vis), 1.0);
}`;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown";
    gl.deleteShader(shader);
    throw new Error(`Shader compile: ${log}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown";
    gl.deleteProgram(program);
    throw new Error(`Program link: ${log}`);
  }
  return program;
}

const HERO_POSTER_SRC = "/assets/landing-footer.png";

function viewportDpr(): number {
  return Math.min(window.devicePixelRatio || 1, 1.5);
}

function createViewportCanvas(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
} | null {
  const dpr = viewportDpr();
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  return { canvas, ctx, w, h };
}

/** Matches .cx-hero { --cx-hero-video-scale } + object-fit: cover. */
function readHeroVideoScale(hero: Element | null): number {
  if (!hero) return 1.12;
  const raw = getComputedStyle(hero).getPropertyValue("--cx-hero-video-scale").trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.12;
}

function drawCoverMedia(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  w: number,
  h: number,
  mediaScale: number,
) {
  const cover = Math.max(w / srcW, h / srcH) * mediaScale;
  const dw = srcW * cover;
  const dh = srcH * cover;
  ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Same layered scrim as .cx-hero__scrim (approximate canvas composite). */
function drawHeroScrim(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const radial = ctx.createRadialGradient(w, h, 0, w, h, Math.max(w, h) * 0.95);
  radial.addColorStop(0, "rgba(6, 8, 12, 0.6)");
  radial.addColorStop(0.42, "rgba(6, 8, 12, 0)");
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, w, h);

  const diag = ctx.createLinearGradient(0, 0, w, h);
  diag.addColorStop(0, "rgba(6, 8, 12, 0.72)");
  diag.addColorStop(0.38, "rgba(6, 8, 12, 0.34)");
  diag.addColorStop(0.66, "rgba(6, 8, 12, 0)");
  ctx.fillStyle = diag;
  ctx.fillRect(0, 0, w, h);

  const bottom = ctx.createLinearGradient(0, h, 0, h * 0.7);
  bottom.addColorStop(0, "rgba(6, 8, 12, 0.66)");
  bottom.addColorStop(1, "rgba(6, 8, 12, 0)");
  ctx.fillStyle = bottom;
  ctx.fillRect(0, 0, w, h);
}

function paintHeroBackdrop(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  w: number,
  h: number,
  mediaScale: number,
) {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, w, h);
  drawCoverMedia(ctx, source, srcW, srcH, w, h, mediaScale);
  drawHeroScrim(ctx, w, h);
}

let posterImage: HTMLImageElement | null = null;

function loadHeroPoster(): Promise<HTMLImageElement> {
  if (posterImage?.complete && posterImage.naturalWidth > 0) {
    return Promise.resolve(posterImage);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      posterImage = img;
      resolve(img);
    };
    img.onerror = () => reject(new Error("hero poster load failed"));
    img.src = HERO_POSTER_SRC;
  });
}

/** Video frame with the same crop + scrim as the live hero. */
function captureHeroVideo(): HTMLCanvasElement | null {
  const video = document.querySelector<HTMLVideoElement>(".cx-hero__video");
  const hero = document.querySelector<HTMLElement>(".cx-hero");
  if (!video || video.readyState < 2 || video.videoWidth < 2) return null;

  const frame = createViewportCanvas();
  if (!frame) return null;
  const { canvas, ctx, w, h } = frame;
  const mediaScale = readHeroVideoScale(hero);
  paintHeroBackdrop(ctx, video, video.videoWidth, video.videoHeight, w, h, mediaScale);
  return canvas;
}

/** Static still (footer asset) — fallback when the loop frame is not ready. */
async function captureHeroPoster(): Promise<HTMLCanvasElement | null> {
  try {
    const img = await loadHeroPoster();
    const hero = document.querySelector<HTMLElement>(".cx-hero");
    const frame = createViewportCanvas();
    if (!frame) return null;
    const { canvas, ctx, w, h } = frame;
    const mediaScale = readHeroVideoScale(hero);
    paintHeroBackdrop(ctx, img, img.naturalWidth, img.naturalHeight, w, h, mediaScale);
    return canvas;
  } catch {
    return null;
  }
}

function letterboxToViewport(src: HTMLCanvasElement, mediaScale: number): HTMLCanvasElement {
  const frame = createViewportCanvas();
  if (!frame) return src;
  const { canvas, ctx, w, h } = frame;
  paintHeroBackdrop(ctx, src, src.width, src.height, w, h, mediaScale);
  return canvas;
}

async function createSyntheticSnapshot(): Promise<HTMLCanvasElement> {
  const poster = await captureHeroPoster();
  if (poster) return poster;

  const frame = createViewportCanvas();
  if (!frame) {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    return c;
  }
  const { canvas, ctx, w, h } = frame;
  const g = ctx.createLinearGradient(0, 0, w * 0.3, h);
  g.addColorStop(0, "#0a0a0a");
  g.addColorStop(0.5, "#3d2818");
  g.addColorStop(0.85, "#c4a88a");
  g.addColorStop(1, "#fcfcfc");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  drawHeroScrim(ctx, w, h);
  return canvas;
}

function isValidSnapshot(c: HTMLCanvasElement): boolean {
  return c.width > 0 && c.height > 0;
}

async function captureViewport(): Promise<HTMLCanvasElement> {
  const hero =
    document.querySelector<HTMLElement>(".cx-hero") ??
    document.querySelector<HTMLElement>(".cx");
  const mediaScale = readHeroVideoScale(hero);

  const videoShot = captureHeroVideo();
  if (videoShot && isValidSnapshot(videoShot)) return videoShot;

  const posterShot = await captureHeroPoster();
  if (posterShot && isValidSnapshot(posterShot)) return posterShot;

  if (hero) {
    try {
      const { domToCanvas } = await import("modern-screenshot");
      const dpr = viewportDpr();
      const shot = await domToCanvas(hero, {
        scale: dpr,
        backgroundColor: "#0a0a0a",
        filter: (node) => {
          if (!(node instanceof Element)) return true;
          if (node.classList.contains("cortex-pixel-wave")) return false;
          const tag = node.tagName.toLowerCase();
          return tag !== "w3m-modal" && !tag.startsWith("w3m-");
        },
      });
      if (isValidSnapshot(shot)) {
        const vw = Math.floor(window.innerWidth * dpr);
        const vh = Math.floor(window.innerHeight * dpr);
        if (Math.abs(shot.width - vw) <= 2 && Math.abs(shot.height - vh) <= 2) {
          return shot;
        }
        return letterboxToViewport(shot, mediaScale);
      }
    } catch (err) {
      console.debug("[cortex] modern-screenshot capture failed:", err);
    }
  }

  const posterFallback = await captureHeroPoster();
  if (posterFallback && isValidSnapshot(posterFallback)) return posterFallback;

  return createSyntheticSnapshot();
}

// Preload poster so the first click does not flash a mismatched crop.
if (typeof window !== "undefined") {
  void loadHeroPoster().catch(() => {});
}

function mountShell(): { shell: HTMLDivElement; canvas: HTMLCanvasElement } {
  const shell = document.createElement("div");
  shell.className = "cortex-pixel-wave cortex-pixel-wave--capturing";
  shell.setAttribute("aria-hidden", "true");

  const canvas = document.createElement("canvas");
  shell.appendChild(canvas);
  document.body.appendChild(shell);
  document.body.style.overflow = "hidden";

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = "100%";
  canvas.style.height = "100%";

  return { shell, canvas };
}

function dismountShell(shell: HTMLDivElement | null) {
  shell?.remove();
  document.body.style.overflow = "";
}

function waitFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function animateProgress(
  durationMs: number,
  onFrame: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / durationMs);
      onFrame(easeInOutCubic(raw));
      if (raw < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Dissolve progress 0–1 from global progress. */
function dissolveT(progress: number): number {
  if (progress <= DISSOLVE_START) return 0;
  return Math.min(1, (progress - DISSOLVE_START) / (1 - DISSOLVE_START));
}

/** Canvas2D per-block mosaic + left→right wave (matches shader timing). */
function drawCanvas2DFrame(
  ctx: CanvasRenderingContext2D,
  snap: HTMLCanvasElement,
  progress: number,
  outW: number,
  outH: number,
) {
  const pixelT = Math.min(1, progress / PIXEL_END);
  const block = Math.max(2, Math.floor(2 + pixelT * 50));
  const smallW = Math.max(1, Math.ceil(outW / block));
  const smallH = Math.max(1, Math.ceil(outH / block));
  const cellW = outW / smallW;
  const cellH = outH / smallH;

  const off = document.createElement("canvas");
  off.width = smallW;
  off.height = smallH;
  const offCtx = off.getContext("2d");
  if (!offCtx) return;
  offCtx.drawImage(snap, 0, 0, smallW, smallH);

  const d = dissolveT(progress);
  const edge = d * 1.08;
  const pixelOnly = d < 0.001;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = false;

  for (let by = 0; by < smallH; by++) {
    for (let bx = 0; bx < smallW; bx++) {
      const x = (bx + 0.5) / smallW + Math.sin(by * 0.75 + bx * 0.2) * 0.035;

      if (pixelOnly) {
        ctx.drawImage(off, bx, by, 1, 1, bx * cellW, by * cellH, cellW + 1, cellH + 1);
        continue;
      }

      // Same as shader: visible when x > edge (wave moves left → right)
      if (x < edge - 0.02) continue;

      let alpha = 1;
      if (x < edge + 0.1) alpha = (x - (edge - 0.02)) / 0.12;

      ctx.globalAlpha = alpha;
      ctx.drawImage(off, bx, by, 1, 1, bx * cellW, by * cellH, cellW + 1, cellH + 1);
    }
  }
  ctx.globalAlpha = 1;
}

type GlState = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  uProgress: WebGLUniformLocation;
  uTex: WebGLUniformLocation;
  uTexSize: WebGLUniformLocation;
  texture: WebGLTexture;
  texW: number;
  texH: number;
};

function initWebGL(canvas: HTMLCanvasElement, snap: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
  if (!gl) return null;

  const program = createProgram(gl);
  const uProgress = gl.getUniformLocation(program, "u_progress");
  const uTex = gl.getUniformLocation(program, "u_tex");
  const uTexSize = gl.getUniformLocation(program, "u_texSize");
  const aPos = gl.getAttribLocation(program, "a_pos");
  if (!uProgress || !uTex || !uTexSize || aPos < 0) return null;

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.useProgram(program);
  gl.uniform1i(uTex, 0);
  gl.uniform2f(uTexSize, snap.width, snap.height);

  return { gl, program, uProgress, uTex, uTexSize, texture, texW: snap.width, texH: snap.height };
}

function drawGlFrame(state: GlState, progress: number, w: number, h: number) {
  const { gl, program, uProgress, uTexSize, texW, texH } = state;
  gl.viewport(0, 0, w, h);
  gl.useProgram(program);
  gl.clearColor(0.04, 0.04, 0.05, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform1f(uProgress, progress);
  gl.uniform2f(uTexSize, texW, texH);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

export async function runPixelWaveTransition(navigate: () => void): Promise<void> {
  if (prefersReducedMotion()) {
    navigate();
    return;
  }

  let shell: HTMLDivElement | null = null;

  try {
    const mounted = mountShell();
    shell = mounted.shell;
    const { canvas } = mounted;
    const w = canvas.width;
    const h = canvas.height;

    await waitFrame();
    const captured = await captureViewport();
    const snap = isValidSnapshot(captured) ? captured : await createSyntheticSnapshot();
    shell.classList.remove("cortex-pixel-wave--capturing");

    let glState: GlState | null = null;
    let ctx2d: CanvasRenderingContext2D | null = null;
    try {
      glState = initWebGL(canvas, snap);
      ctx2d = glState ? null : canvas.getContext("2d");
    } catch (err) {
      console.debug("[cortex] WebGL init failed, using Canvas2D", err);
      ctx2d = canvas.getContext("2d");
    }

    if (!glState && !ctx2d) {
      navigate();
      return;
    }

    await animateProgress(DURATION_MS, (progress) => {
      if (glState) {
        drawGlFrame(glState, progress, w, h);
      } else {
        drawCanvas2DFrame(ctx2d!, snap, progress, w, h);
      }
    });

    navigate();
    await sleep(80);
    shell.style.transition = "opacity 0.35s ease";
    shell.style.opacity = "0";
    await sleep(380);
  } catch (err) {
    console.warn("[cortex] pixel-wave transition failed, navigating directly", err);
    navigate();
  } finally {
    dismountShell(shell);
  }
}
