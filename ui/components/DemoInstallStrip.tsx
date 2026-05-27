/**
 * Cortex — one-line install strip for demo mode.
 *
 * Copy-paste commands for the live terminal narrative; not a full docs panel.
 */

import { useCallback, useState } from "react";

const INSTALL_CMD = `/plugin install cortex
cortex auth
bun run mcp`;

export function DemoInstallStrip() {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(INSTALL_CMD).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }, []);

  return (
    <div className="demo-install">
      <div className="demo-install-head">
        <span className="demo-install-title">Live install path</span>
        <button type="button" className="demo-install-copy" onClick={onCopy}>
          {copied ? "copied ✓" : "copy commands"}
        </button>
      </div>
      <pre className="demo-install-body mono">{INSTALL_CMD}</pre>
      <p className="demo-install-hint muted">
        Install the plugin, sign once with your wallet, then attach Cortex memory to
        Claude Code or Cursor via MCP.
      </p>
    </div>
  );
}
