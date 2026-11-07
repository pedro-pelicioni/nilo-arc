// Offline. No private keys, no RPC, no transactions.
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { pbkdf2 } from "node:crypto";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "nilo-arc-"));
delete process.env.NILO_OPERATOR_KEY;
delete process.env.ARC_RPC_URL;

const { createApp } = await import("../src/app.ts");
const { network, setRpcForTests } = await import("../src/chain.ts");
const { syncFromChain, resetSyncForTests } = await import("../src/agent/chainlog.ts");
const { resetStoreForTests, syncedBlock } = await import("../src/agent/store.ts");
const { investFailure } = await import("../src/agent/run.ts");
const { resetRouteLimitsForTests } = await import("../src/agent/routes.ts");
const { limits, resetLimits } = await import("../src/limits.ts");
const { errorSummary, resetLogsForTests } = await import("../src/errors.ts");
const { createGatedFetch } = await import("../src/gate.ts");
const { shutdownServer } = await import("../src/shutdown.ts");
const { market, resetMarketForTests } = await import("../src/market.ts");

const ADDR = "0x0000000000000000000000000000000000000001";
const STATUS = `/api/agent/status/${ADDR}`;

function zeroMandate() {
  return { limit: 0n, period: 0n, expiresAt: 0n, reserve: 0n, profile: 0, vaults: [] as readonly `0x${string}`[] };
}

function rpc(partial: Record<string, unknown>) {
  return partial as never;
}

const logs: string[] = [];
const originalError = console.error;
const originalLog = console.log;

before(() => {
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.log = () => undefined;
});

after(() => {
  console.error = originalError;
  console.log = originalLog;
});

beforeEach(() => {
  logs.length = 0;
  resetLimits();
  resetLogsForTests();
  resetStoreForTests();
  resetSyncForTests();
  resetRouteLimitsForTests();
  resetMarketForTests();
  setRpcForTests(
    rpc({
      async readContract() {
        throw new Error("rpc not stubbed");
      },
      async getBlockNumber() {
        return network.agentFromBlock;
      },
      async getBlock() {
        return { timestamp: 0n };
      },
      async getContractEvents() {
        return [];
      },
    }),
  );
});

afterEach(() => {
  resetSyncForTests();
  setRpcForTests(null);
});

describe("stability", { concurrency: false }, () => {
  it("answers /health and / from memory without reading the chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nilo-static-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Nilo</title>");
    let reads = 0;
    setRpcForTests(
      rpc({
        async readContract() {
          reads++;
          throw new Error("health must not read");
        },
        async getBlockNumber() {
          reads++;
          throw new Error("health must not sync");
        },
        async getContractEvents() {
          reads++;
          return [];
        },
        async getBlock() {
          reads++;
          return { timestamp: 0n };
        },
      }),
    );
    const app = createApp({ staticDir: dir });
    const health = await app.request("/health");
    const head = await app.request("/health", { method: "HEAD" });
    const root = await app.request("/");
    const spa = await app.request("/agent");
    assert.equal(health.status, 200);
    assert.equal(head.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.match(await root.text(), /Nilo/);
    assert.match(await spa.text(), /Nilo/);
    assert.equal(reads, 0);
  });

  it("keeps /health fast while a status read is hung", async () => {
    limits.routeBudgetMs = 400;
    setRpcForTests(
      rpc({
        async readContract() {
          return new Promise(() => undefined);
        },
        async getBlockNumber() {
          return new Promise(() => undefined);
        },
        async getContractEvents() {
          return [];
        },
        async getBlock() {
          return { timestamp: 0n };
        },
      }),
    );
    const app = createApp();
    const started = performance.now();
    const status = app.request(STATUS);
    const health = await app.request("/health");
    const healthMs = performance.now() - started;
    assert.equal(health.status, 200);
    assert.ok(healthMs < 200, `health took ${healthMs}ms while a status read was hung`);
    const statusRes = await status;
    assert.equal(statusRes.status, 503);
    assert.match(await statusRes.json().then((b: { message: string }) => b.message), /did not answer in time/);
  });

  it("sheds status work past the in-flight cap", async () => {
    assert.equal(limits.maxStatusInflight, 4);
    limits.maxStatusInflight = 1;
    limits.routeBudgetMs = 300;
    let reads = 0;
    setRpcForTests(
      rpc({
        async readContract() {
          reads++;
          return new Promise(() => undefined);
        },
        async getBlockNumber() {
          return network.agentFromBlock;
        },
        async getContractEvents() {
          return [];
        },
        async getBlock() {
          return { timestamp: 0n };
        },
      }),
    );
    const app = createApp();
    const first = app.request(STATUS);
    await new Promise((r) => setTimeout(r, 30));
    const t = performance.now();
    const second = await app.request(STATUS);
    assert.equal(second.status, 503);
    assert.match((await second.json()).message, /busy/);
    assert.ok(performance.now() - t < 100);
    assert.equal(reads, 7);
    const firstRes = await first;
    assert.equal(firstRes.status, 503);
    assert.equal(reads, 7);
  });

  it("returns an empty mandate without logging the viem call", async () => {
    setRpcForTests(
      rpc({
        async readContract(args: { functionName: string }) {
          if (args.functionName === "mandateOf") return zeroMandate();
          if (args.functionName === "usageOf") return [0n, 0n];
          return 0n;
        },
        async getBlockNumber() {
          return network.agentFromBlock;
        },
        async getContractEvents() {
          return [];
        },
        async getBlock() {
          return { timestamp: 0n };
        },
      }),
    );
    const app = createApp();
    const res = await app.request(STATUS);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mandate, null);
    assert.equal(logs.length, 0);
  });

  it("contains a mandateOf failure instead of dumping the call", async () => {
    const dump = "x".repeat(20_000);
    const failure = Object.assign(new Error(dump), {
      shortMessage: "HTTP request failed.",
      functionName: "mandateOf",
      contractAddress: "0x6debfa160cc1fd5ef06251690375d3887137e66c",
      args: [ADDR],
      sender: undefined,
      formattedArgs: undefined,
    });
    setRpcForTests(
      rpc({
        async readContract(args: { functionName: string }) {
          if (args.functionName === "mandateOf") throw failure;
          if (args.functionName === "usageOf") return [0n, 0n];
          return 0n;
        },
        async getBlockNumber() {
          return network.agentFromBlock;
        },
        async getContractEvents() {
          return [];
        },
        async getBlock() {
          return { timestamp: 0n };
        },
      }),
    );
    const app = createApp();
    const res = await app.request(STATUS);
    assert.equal(res.status, 502);
    const body = await res.text();
    assert.ok(!body.includes(dump.slice(0, 100)));
    assert.ok(!body.includes("formattedArgs"));
    assert.equal(logs.length, 1);
    assert.equal(logs[0], "agent route failed: HTTP request failed.");
    assert.equal(errorSummary(failure), "HTTP request failed.");
    const again = await app.request(STATUS);
    assert.equal(again.status, 502);
    assert.equal(logs.length, 1);
  });

  it("maps an invest revert from the error name, not the raw dump", () => {
    const note = investFailure({
      message: "x".repeat(20_000),
      shortMessage: 'The contract function "invest" reverted.',
      metaMessages: ["Error: OverLimit()"],
      data: { errorName: "OverLimit" },
    });
    assert.match(note, /week's limit is already used/);
    assert.ok(!note.includes("xxxx"));
  });

  it("checkpoints a bounded history pass and resumes after it", async () => {
    const from = network.agentFromBlock;
    const head = from + 45_000n;
    const ranges: Array<[bigint, bigint]> = [];
    limits.syncContinueMs = 60_000;
    limits.syncRetryMs = 60_000;
    setRpcForTests(
      rpc({
        async getBlockNumber() {
          return head;
        },
        async getContractEvents(args: { fromBlock: bigint; toBlock: bigint }) {
          ranges.push([args.fromBlock, args.toBlock]);
          return [];
        },
        async getBlock() {
          return { timestamp: 0n };
        },
        async readContract() {
          return 0n;
        },
      }),
    );
    await syncFromChain(true);
    assert.ok(ranges.length > 0);
    assert.ok(ranges.length <= limits.syncMaxCalls);
    const covered = ranges[ranges.length - 1][1] - ranges[0][0] + 1n;
    assert.ok(covered <= limits.syncBlockBudget);
    assert.equal(syncedBlock(), ranges[ranges.length - 1][1]);
    assert.ok(syncedBlock()! < head);
    const file = JSON.parse(readFileSync(join(process.env.DATA_DIR!, "agent.json"), "utf8")) as { syncedBlock: string };
    assert.equal(file.syncedBlock, syncedBlock()!.toString());
    const firstEnd = syncedBlock()!;
    const mid = ranges.length;
    await syncFromChain(true);
    assert.equal(ranges[mid][0], firstEnd + 1n);
    assert.ok((syncedBlock() ?? 0n) > firstEnd);
  });

  it("does not retry a dead history RPC in a tight loop", async () => {
    let calls = 0;
    limits.syncRetryMs = 60_000;
    limits.syncContinueMs = 5;
    setRpcForTests(
      rpc({
        async getBlockNumber() {
          return network.agentFromBlock + 100_000n;
        },
        async getContractEvents() {
          calls++;
          throw new Error("rpc down");
        },
        async getBlock() {
          return { timestamp: 0n };
        },
        async readContract() {
          return 0n;
        },
      }),
    );
    await syncFromChain(true);
    const after = calls;
    assert.ok(after >= 1 && after <= limits.syncMaxCalls);
    assert.equal(syncedBlock(), null);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(calls, after);
    assert.ok(logs.every((line) => line.length < 400));
    assert.ok(logs.some((line) => line.startsWith("agent: could not read NiloAgent events:")));
  });

  it("keeps the blocks it already read when a later range fails", async () => {
    const from = network.agentFromBlock;
    let calls = 0;
    limits.syncRetryMs = 60_000;
    setRpcForTests(
      rpc({
        async getBlockNumber() {
          return from + 30_000n;
        },
        async getContractEvents() {
          calls++;
          if (calls > 1) throw new Error("range refused");
          return [];
        },
        async getBlock() {
          return { timestamp: 0n };
        },
        async readContract() {
          return 0n;
        },
      }),
    );
    await syncFromChain(true);
    assert.equal(syncedBlock(), from + 10_000n - 1n);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, limits.syncMaxCalls);
  });

  it("caps concurrent RPC fetches and drops an aborted waiter", async () => {
    let active = 0;
    let max = 0;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = createGatedFetch(2, async () => {
      active++;
      max = Math.max(max, active);
      try {
        await hold;
        return new Response("ok");
      } finally {
        active--;
      }
    });
    const a = gated("http://rpc.test/a");
    const b = gated("http://rpc.test/b");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(max, 2);
    const ac = new AbortController();
    const c = gated("http://rpc.test/c", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await assert.rejects(c);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    assert.equal(max, 2);
    const again = await gated("http://rpc.test/d");
    assert.equal(again.status, 200);
  });

  it("shares one market refresh across callers", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ open: "10", last: "11" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const [a, b] = await Promise.all([market(), market()]);
      assert.equal(calls, 2);
      assert.equal(a.assets.length, 2);
      assert.equal(b.assets[0].symbol, "BTC");
    } finally {
      globalThis.fetch = orig;
      resetMarketForTests();
    }
  });

  it("stops the listener on SIGTERM without waiting out a platform kill", () => {
    let closed = false;
    let code: number | null = null;
    const stop = shutdownServer(
      {
        close(cb?: () => void) {
          closed = true;
          cb?.();
        },
      },
      (c) => {
        code = c;
      },
      "SIGTERM",
    );
    stop();
    stop();
    assert.equal(closed, true);
    assert.equal(code, 0);
  });

  it("serves /health and / while the thread pool is saturated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nilo-http-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Nilo probe</title>");
    const app = createApp({ staticDir: dir });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await once(server as Server, "listening");
    const address = (server as Server).address();
    if (!address || typeof address === "string") throw new Error("no port");
    const pool = Number(process.env.UV_THREADPOOL_SIZE || 4);
    let finished = 0;
    const blockers = Array.from({ length: pool }, () => new Promise<void>((resolve) => {
      pbkdf2("password", "salt", 1_500_000, 32, "sha256", () => {
        finished++;
        resolve();
      });
    }));
    try {
      const health = await get(address.port, "/health");
      const root = await get(address.port, "/");
      assert.equal(health.status, 200);
      assert.equal(root.status, 200);
      assert.match(root.body, /Nilo probe/);
      assert.ok(health.ms < 500, `health took ${health.ms}ms under thread-pool load`);
      assert.ok(root.ms < 500, `/ took ${root.ms}ms under thread-pool load`);
      assert.equal(finished, 0);
    } finally {
      (server as Server).close();
      await Promise.all(blockers);
    }
  });
});

function get(port: number, path: string): Promise<{ status: number; body: string; ms: number }> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        lookup: (_hostname, _options, cb) => {
          cb(null, "127.0.0.1", 4);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), ms: performance.now() - start }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
