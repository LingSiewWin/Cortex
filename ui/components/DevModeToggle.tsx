/**
 * Cortex — Dev Mode Toggle (Phase 15).
 *
 * iOS-style sliding pill. `ambient` = grey track (default). `dev` = blue
 * track (the cryptographic tier color — fitting, since dev mode surfaces
 * the cryptographic playgrounds).
 *
 * Persistence lives in the parent (console.tsx) via localStorage —
 * this component is purely controlled.
 */

interface Props {
  mode: "ambient" | "dev";
  onToggle: (next: "ambient" | "dev") => void;
}

export function DevModeToggle({ mode, onToggle }: Props) {
  const next = mode === "ambient" ? "dev" : "ambient";
  const isDev = mode === "dev";
  return (
    <div className="devmode-toggle">
      <button
        type="button"
        className={`devmode-toggle-track${isDev ? " on" : ""}`}
        aria-pressed={isDev}
        aria-label={`Switch to ${next} mode`}
        onClick={() => onToggle(next)}
      >
        <span className="devmode-toggle-knob" />
      </button>
      <span className="devmode-toggle-label mono">
        {isDev ? "DEV" : "AMBIENT"}
      </span>
    </div>
  );
}
