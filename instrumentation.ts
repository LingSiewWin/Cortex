export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { startCortexWorkers } = await import("./src/server/bootstrap");
    await startCortexWorkers();
  } catch (err) {
    console.error(
      "[cortex] instrumentation bootstrap failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
