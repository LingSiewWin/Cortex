// Regenerates on-theme placeholder SVGs for jack-portfolio.html.
// Run:  bun assets/_make-placeholders.mjs   (or: node assets/_make-placeholders.mjs)
// Replace any generated file with your own art using the SAME filename — no code changes needed.
import { writeFileSync } from "node:fs";

const dir = new URL("./", import.meta.url).pathname;

// dark, on-theme gradient pairs
const palettes = [
  ["#1b1030", "#3a1c5e"], ["#0e1a2b", "#1c3a5e"], ["#2b0e1f", "#5e1c3a"],
  ["#0e2b22", "#1c5e44"], ["#2b220e", "#5e4a1c"], ["#1a0e2b", "#3a1c5e"],
  ["#0e2b2b", "#1c5e5e"], ["#2b0e0e", "#5e1c1c"], ["#161616", "#333333"],
];

function tile({ w, h, label, sub = "", pi = 0, accent = "#BBCCD7" }) {
  const [c1, c2] = palettes[pi % palettes.length];
  const fs = Math.round(Math.min(w, h) * 0.09);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="3" y="3" width="${w - 6}" height="${h - 6}" fill="none" stroke="${accent}" stroke-opacity="0.18" stroke-width="2" rx="14"/>
  <text x="50%" y="${sub ? "46%" : "50%"}" fill="${accent}" fill-opacity="0.85" font-family="monospace" font-size="${fs}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${label}</text>
  ${sub ? `<text x="50%" y="58%" fill="${accent}" fill-opacity="0.4" font-family="monospace" font-size="${Math.round(fs * 0.6)}" text-anchor="middle" dominant-baseline="middle">${sub}</text>` : ""}
</svg>`;
}

const write = (name, svg) => { writeFileSync(dir + name, svg); console.log("  " + name); };

// Portrait (transparent-ish head silhouette on dark)
write("portrait.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="650" viewBox="0 0 520 650">
  <defs><radialGradient id="p" cx="50%" cy="38%" r="60%"><stop offset="0" stop-color="#3a2a5e"/><stop offset="1" stop-color="#0C0C0C"/></radialGradient></defs>
  <rect width="100%" height="100%" fill="none"/>
  <g fill="#BBCCD7" fill-opacity="0.85">
    <circle cx="260" cy="250" r="150"/>
    <path d="M120 650 q140 -210 280 0 Z"/>
  </g>
  <circle cx="260" cy="250" r="150" fill="url(#p)" opacity="0.35"/>
  <text x="50%" y="92%" fill="#BBCCD7" fill-opacity="0.5" font-family="monospace" font-size="22" text-anchor="middle">portrait.svg</text>
</svg>`);

// About corner objects
write("corner-moon.svg",  tile({ w: 210, h: 210, label: "moon", pi: 1 }));
write("corner-lego.svg",  tile({ w: 210, h: 210, label: "lego", pi: 5 }));
write("corner-obj.svg",   tile({ w: 180, h: 180, label: "obj",  pi: 3 }));
write("corner-group.svg", tile({ w: 220, h: 220, label: "group", pi: 2 }));

// Marquee tiles (labels echo the original template vibes so you know each slot)
const marquee = [
  "space voyage","codenest","vex ventures","stellar ai v2","asme","transform data",
  "vitara","terra","skyelite","aethera","designpro","stellar ai","xportfolio",
  "orbit web3","nexora","evr ventures","planet orbit","new era","wealth","luminex","celestia"
];
marquee.forEach((name, i) => {
  const n = String(i + 1).padStart(2, "0");
  write(`marquee-${n}.svg`, tile({ w: 420, h: 270, label: name, sub: `tile ${n}`, pi: i }));
});

// Project images: col1 top (landscape), col1 bottom (portraitish), col2 (tall)
const projects = [
  { n: "01", name: "nextlevel studio" },
  { n: "02", name: "aura brand identity" },
  { n: "03", name: "solaris digital" },
];
projects.forEach((p, i) => {
  write(`project-${p.n}-a.svg`,    tile({ w: 900, h: 560, label: p.name, sub: "col1 / top",  pi: i * 3 }));
  write(`project-${p.n}-b.svg`,    tile({ w: 800, h: 1000, label: p.name, sub: "col1 / bottom", pi: i * 3 + 1 }));
  write(`project-${p.n}-main.svg`, tile({ w: 900, h: 1100, label: p.name, sub: "col2 / main", pi: i * 3 + 2 }));
});

console.log("done.");
