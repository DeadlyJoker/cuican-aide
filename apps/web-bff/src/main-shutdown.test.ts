import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

const TEST_TIMEOUT_MS = 5_000;

test("SIGTERM aborts an open upstream stream and exits within the configured grace", async (context) => {
  let markUpstreamClosed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    markUpstreamClosed = resolve;
  });
  const control = createServer((_request, response) => {
    response.once("close", markUpstreamClosed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: ready\ndata: {}\n\n");
  });
  const controlPort = await listen(control);
  const bffPort = await reservePort();
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL("main.ts", import.meta.url).pathname,
    ],
    {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        CREWON_CONTROL_BFF_TOKEN: "control-bff-service-token-32-bytes-minimum",
        CREWON_CONTROL_CSRF_TOKEN: "control-csrf-token-32-bytes-minimum",
        CREWON_CONTROL_TARGET: `http://127.0.0.1:${controlPort}`,
        CREWON_IDENTITY_SERVICE_TOKEN:
          "identity-service-token-at-least-32-bytes",
        CREWON_IDENTITY_SESSION_URL:
          "https://identity.example.test/internal/session",
        CREWON_WEB_BFF_PORT: String(bffPort),
        CREWON_WEB_BFF_SHUTDOWN_GRACE_MS: "50",
        CREWON_WEB_CSRF_SECRET: "web-csrf-secret-at-least-32-bytes",
        CREWON_WEB_PUBLIC_ORIGIN: "https://crewon.example.test:6175",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await close(control);
  });

  await waitForOutput(
    child,
    `CrewON Web BFF listening on 127.0.0.1:${bffPort}`,
  );
  const response = await fetch(
    `http://127.0.0.1:${bffPort}/control-api/health/ready`,
  );
  const reader = response.body?.getReader();
  assert.ok(reader);
  assert.equal((await reader.read()).done, false);

  child.kill("SIGTERM");
  const [exitCode, signal] = await withTimeout(
    once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>,
  );

  assert.deepEqual({ exitCode, signal }, { exitCode: 0, signal: null });
  await withTimeout(upstreamClosed);
  await assert.rejects(fetch(`http://127.0.0.1:${bffPort}/crewon-health`));
});

async function waitForOutput(child: ChildProcess, expected: string) {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    throw new Error("test_child_stdio_missing");
  }
  let output = "";
  let errorOutput = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (value: string) => {
    errorOutput += value;
  });
  stdout.setEncoding("utf8");
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      stdout.on("data", (value: string) => {
        output += value;
        if (output.includes(expected)) {
          resolve();
        }
      });
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `web_bff_exited_before_ready:${String(code)}:${String(signal)}:${errorOutput}`,
          ),
        );
      });
    }),
  );
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function listen(server: Server): Promise<number> {
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

async function close(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("test_timeout")),
        TEST_TIMEOUT_MS,
      ).unref();
    }),
  ]);
}
