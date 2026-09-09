/** Run at most one request at a time, only while this webview is visible. */
export function pollWhileVisible(refresh: () => Promise<void>, intervalMs: number): () => void {
  const doc = globalThis.document;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => !stopped && doc?.visibilityState !== "hidden";
  const schedule = () => {
    running = false;
    if (visible()) timer = setTimeout(run, intervalMs);
  };
  const run = () => {
    if (!visible() || running) return;
    running = true;
    // The caller presents failures. Either outcome may retry on the next tick.
    void Promise.resolve()
      .then(() => {
        if (visible()) return refresh();
      })
      .then(schedule, schedule);
  };
  const changed = () => {
    clearTimeout(timer);
    if (visible()) run();
  };
  doc?.addEventListener("visibilitychange", changed);
  run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    doc?.removeEventListener("visibilitychange", changed);
  };
}
