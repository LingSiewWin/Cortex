/**
 * HeroOverlay — HTML/CSS overlaid on the 3D canvas.
 *
 * The container is pointer-events:none so the cursor still reaches the R3F
 * scene (the cursor is one of the two energy sources). Only the CTA button
 * re-enables pointer-events so it stays clickable.
 */

import { useEffect } from "react";
import { PALETTE } from "./constants";

const FONT_LINK_ID = "cortex-hero-bricolage";

export function HeroOverlay() {
  useEffect(() => {
    if (document.getElementById(FONT_LINK_ID)) return;
    const pre1 = document.createElement("link");
    pre1.rel = "preconnect";
    pre1.href = "https://fonts.googleapis.com";
    const pre2 = document.createElement("link");
    pre2.rel = "preconnect";
    pre2.href = "https://fonts.gstatic.com";
    pre2.crossOrigin = "anonymous";
    const link = document.createElement("link");
    link.id = FONT_LINK_ID;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Inter:wght@400;500&display=swap";
    document.head.append(pre1, pre2, link);
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 2,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "clamp(20px, 4vw, 48px)",
        color: "#E7ECF2",
        fontFamily: "Inter, system-ui, -apple-system, sans-serif",
      }}
    >
      {/* top wordmark */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontFamily: "'Bricolage Grotesque', Inter, sans-serif",
          fontWeight: 800,
          letterSpacing: "0.18em",
          fontSize: 15,
          textTransform: "uppercase",
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: PALETTE.accent,
            boxShadow: `0 0 14px ${PALETTE.accent}`,
          }}
        />
        <span>Cortex</span>
      </div>

      {/* headline + CTA */}
      <div style={{ maxWidth: 720 }}>
        <h1
          style={{
            fontFamily: "'Bricolage Grotesque', Inter, sans-serif",
            fontWeight: 800,
            fontSize: "clamp(40px, 6.5vw, 88px)",
            lineHeight: 0.98,
            letterSpacing: "-0.02em",
            margin: 0,
            background: "linear-gradient(180deg, #FFFFFF 0%, #BFE9E2 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          the agent memory
          <br />
          that earns its rent
        </h1>
        <p
          style={{
            margin: "20px 0 0",
            maxWidth: 520,
            fontSize: "clamp(15px, 1.5vw, 18px)",
            lineHeight: 1.5,
            color: "#9AA6B2",
          }}
        >
          Memories that activate on access. Cited often, they grow and persist;
          ignored, they fade for free. Sovereign, decay-aware memory on Arkiv.
        </p>
        <a
          href="/console"
          style={{
            pointerEvents: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            marginTop: 28,
            padding: "13px 26px",
            borderRadius: 999,
            background: PALETTE.accent,
            color: "#04140F",
            fontWeight: 600,
            fontSize: 15,
            textDecoration: "none",
            boxShadow: `0 0 24px ${PALETTE.accent}55`,
            transition: "transform 0.15s ease, box-shadow 0.15s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "translateY(-1px)";
            e.currentTarget.style.boxShadow = `0 0 36px ${PALETTE.accent}88`;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow = `0 0 24px ${PALETTE.accent}55`;
          }}
        >
          Get started →
        </a>
      </div>
    </div>
  );
}
