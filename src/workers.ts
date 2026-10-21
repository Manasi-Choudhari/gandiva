const ticks = new Map<string, { lastTick: string; ok: boolean }>();

/** A background worker calls this after each pass. A pass that failed still counts; `ok` says how it went, the log says why. */
export const workerTick = (name: string, ok = true) => void ticks.set(name, { lastTick: new Date().toISOString(), ok });

/** Last pass of each worker that has run. A stale lastTick means that worker has stalled. */
export const workerStatus = () => Object.fromEntries(ticks);
