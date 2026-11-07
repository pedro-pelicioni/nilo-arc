/** One line when the process could not have answered a probe. Does not keep the process alive. */
export function watchEventLoop(thresholdMs = 2_000) {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - 1_000;
    last = now;
    if (lag >= thresholdMs) console.warn(`event loop lagged ${lag}ms`);
  }, 1_000);
  timer.unref?.();
  return timer;
}
