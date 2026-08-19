import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createBoundedServerShutdown } from "./bounded-server-shutdown.ts";

test("allows an active short request to drain before shutdown", async () => {
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  let shutdown: ReturnType<typeof createBoundedServerShutdown>;
  const server = createServer(async (_request, response) => {
    const controller = new AbortController();
    const unregister = shutdown.register(controller);
    requestStarted();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(controller.signal.aborted, false);
    response.end("drained");
    unregister();
  });
  shutdown = createBoundedServerShutdown(server, 500);
  const port = await listen(server);

  const responsePromise = fetch(`http://127.0.0.1:${port}/short`);
  await started;
  const shutdownPromise = shutdown.shutdown();

  assert.equal(await (await responsePromise).text(), "drained");
  assert.equal(await shutdownPromise, "drained");
});

test("aborts an active SSE request and closes connections at the deadline", async () => {
  let upstreamAborted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    upstreamAborted = resolve;
  });
  let shutdown: ReturnType<typeof createBoundedServerShutdown>;
  const server = createServer((_request, response) => {
    const controller = new AbortController();
    shutdown.register(controller);
    controller.signal.addEventListener("abort", upstreamAborted, {
      once: true,
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: ready\ndata: {}\n\n");
  });
  shutdown = createBoundedServerShutdown(server, 50);
  const port = await listen(server);
  const response = await fetch(`http://127.0.0.1:${port}/events`);
  const reader = response.body?.getReader();
  assert.ok(reader);
  assert.equal((await reader.read()).done, false);

  const firstShutdown = shutdown.shutdown();
  const secondShutdown = shutdown.shutdown();
  assert.equal(firstShutdown, secondShutdown);
  assert.equal(await firstShutdown, "forced");
  await aborted;
  await assert.rejects(reader.read());
});

test("rejects an invalid shutdown grace period", () => {
  const server = createServer();
  assert.throws(
    () => createBoundedServerShutdown(server, 0),
    /web_bff_shutdown_grace_invalid/u,
  );
});

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test_server_address_invalid");
  }
  return address.port;
}
