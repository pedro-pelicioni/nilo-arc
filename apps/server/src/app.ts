import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import OpenAI from "openai";
import { agent } from "./agent/routes";
import { logError } from "./errors";
import { ChatSchema, extractIntent } from "./extract";
import { market } from "./market";
import { SponsorError, SponsorRequest, sponsorClaim } from "./sponsor";
import { VoiceError, VoiceRequest, createVoiceSession } from "./voice";

function loadIndex(dir: string): string | null {
  try {
    return readFileSync(join(dir, "index.html"), "utf8");
  } catch {
    return null;
  }
}

/**
 * HTTP app. `/health` and `/` are answered from memory: they do not read the
 * chain and they do not stat the disk. Render's HTTP probe fails when the
 * process does not answer within 5 seconds, and `serveStatic` stats on the
 * request path.
 */
export function createApp(options?: { staticDir?: string }) {
  const app = new Hono();

  app.on(["GET", "HEAD"], ["/health", "/healthz"], (c) => {
    c.header("cache-control", "no-store");
    return c.json({ ok: true });
  });

  app.post("/api/extract", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ChatSchema.safeParse(body?.messages);
    if (!parsed.success) return c.json({ status: "error", message: "Invalid conversation." }, 400);
    try {
      return c.json(await extractIntent(parsed.data));
    } catch (e) {
      logError("extract failed", e);
      const message =
        !process.env.OPENAI_API_KEY || e instanceof OpenAI.AuthenticationError
          ? "The server has no valid OPENAI_API_KEY."
          : e instanceof OpenAI.RateLimitError
            ? "The assistant is rate limited. Try again in a moment."
            : "The assistant is unavailable right now.";
      return c.json({ status: "error", message }, 502);
    }
  });

  app.post("/api/sponsor-claim", async (c) => {
    const parsed = SponsorRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "Invalid payment, signature or address." }, 400);
    try {
      return c.json(await sponsorClaim(parsed.data));
    } catch (e) {
      if (e instanceof SponsorError) return c.json({ message: e.message }, e.status);
      logError("sponsor-claim failed", e);
      return c.json({ message: "Could not submit a sponsored claim right now." }, 502);
    }
  });

  app.post("/api/voice/session", async (c) => {
    const parsed = VoiceRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "Invalid voice mode request." }, 400);
    try {
      return c.json(await createVoiceSession(parsed.data));
    } catch (e) {
      if (e instanceof VoiceError) return c.json({ message: e.message }, e.status);
      logError("voice session failed", e);
      const message =
        e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError
          ? "The server's OpenAI key can't use voice mode."
          : e instanceof OpenAI.RateLimitError
            ? "Voice mode is rate limited. Try again in a moment."
            : "Voice mode is unavailable right now.";
      return c.json({ message }, 502);
    }
  });

  app.route("/api/agent", agent);

  app.get("/api/market", async (c) => {
    try {
      return c.json(await market());
    } catch (e) {
      logError("market failed", e);
      return c.json({ message: "Market prices are unavailable right now." }, 502);
    }
  });

  const staticDir = options?.staticDir ?? process.env.STATIC_DIR;
  if (staticDir) {
    const index = loadIndex(staticDir);
    if (index !== null) {
      const shell = (c: { req: { method: string }; header: (name: string, value: string) => void; body: (data: null, status?: number) => Response | Promise<Response>; html: (data: string) => Response | Promise<Response> }) => {
        c.header("content-type", "text/html; charset=utf-8");
        if (c.req.method === "HEAD") return c.body(null, 200);
        return c.html(index);
      };
      app.on(["GET", "HEAD"], "/", (c) => shell(c));
      // Files with an extension (the built JS and CSS) still come from disk.
      // Probes and app routes do not: a stat on the request path blocks every
      // other request on this process, including the health probe.
      app.use("/*", async (c, next) => {
        const path = c.req.path;
        if (path === "/" || path === "/health" || path === "/healthz" || path.startsWith("/api/")) return next();
        if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
        if (!/\.[a-zA-Z0-9]+$/.test(path)) return next();
        return serveStatic({ root: staticDir })(c, next);
      });
      app.on(["GET", "HEAD"], "*", (c) => shell(c));
    } else {
      app.use("/*", serveStatic({ root: staticDir }));
      app.get("*", (c, next) => (c.req.path.startsWith("/api/") ? next() : serveStatic({ path: `${staticDir}/index.html` })(c, next)));
    }
  }

  return app;
}
