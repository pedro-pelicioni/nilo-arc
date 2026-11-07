/** The bit of an HTTP server shutdown needs. http and http2 both have it. */
export interface Closable {
  close(callback?: () => void): void;
}

/**
 * Render sends SIGTERM and then SIGKILL if the process is still up when the
 * shutdown delay ends (exit 137). Node only runs this handler when the event
 * loop is free, so it does not cover a stuck loop; it does cover a process
 * kept open by a socket. The timer exits even if a request never finishes.
 */
export function shutdownServer(server: Closable, exit: (code: number) => void, signal = "SIGTERM") {
  let closing = false;
  const run = () => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: stopping listener`);
    const timer = setTimeout(() => exit(0), 5_000);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      exit(0);
    });
  };
  return run;
}

export function installShutdown(server: Closable) {
  const run = (signal: string) => shutdownServer(server, (code) => process.exit(code), signal)();
  process.once("SIGTERM", () => run("SIGTERM"));
  process.once("SIGINT", () => run("SIGINT"));
}
