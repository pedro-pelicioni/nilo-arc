import { serve } from "@hono/node-server";
import { startSchedule } from "./agent/run";
import { createApp } from "./app";
import { network } from "./chain";
import { logError } from "./errors";
import { preferIpv4 } from "./ipv4";
import { watchEventLoop } from "./loop";
import { installShutdown } from "./shutdown";

// Before any outbound dial. Imports above construct clients; they do not connect.
preferIpv4();

if (!process.env.OPENAI_API_KEY) {
  console.warn("No OPENAI_API_KEY set (see .env.example): /api/extract will fail until it is.");
}

// A rejected promise with no handler used to end the process. A failed view call
// must not. The line is one short summary, not the viem error object.
process.on("unhandledRejection", (e) => logError("unhandled rejection", e));

const app = createApp();
const port = Number(process.env.PORT ?? 8787);

// Listen first. Chain history starts only after the port is open, so a probe
// during wake is not waiting on eth_getLogs.
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Nilo server on http://${info.address}:${info.port} (${network.name})`);
  startSchedule();
});
installShutdown(server);
watchEventLoop();
