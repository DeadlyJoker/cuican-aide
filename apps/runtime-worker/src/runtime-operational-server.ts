import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { RuntimeWorkerOutcome } from "./runtime-worker.ts";

const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export class RuntimeOperationalMetrics {
  readonly #startedAtMs: number;
  readonly #now: () => number;
  readonly #outcomes = new Map<string, number>();
  #ready = false;
  #lastOutcome: Readonly<{ kind: string; code: string }> | null = null;

  constructor(config: { now?: () => number } = {}) {
    this.#now = config.now ?? Date.now;
    this.#startedAtMs = this.#now();
  }

  setReady(ready: boolean): void {
    this.#ready = ready;
  }

  ready(): boolean {
    return this.#ready;
  }

  recordOutcome(outcome: RuntimeWorkerOutcome): void {
    const value = outcomeLabel(outcome);
    const key = `${value.kind}\0${value.code}`;
    this.#outcomes.set(key, (this.#outcomes.get(key) ?? 0) + 1);
    this.#lastOutcome = value;
  }

  render(): string {
    const lines = [
      "# HELP crewon_runtime_worker_ready Whether the worker completed production startup.",
      "# TYPE crewon_runtime_worker_ready gauge",
      `crewon_runtime_worker_ready ${this.#ready ? 1 : 0}`,
      "# HELP crewon_runtime_worker_uptime_seconds Worker process observation uptime.",
      "# TYPE crewon_runtime_worker_uptime_seconds gauge",
      `crewon_runtime_worker_uptime_seconds ${Math.max(0, this.#now() - this.#startedAtMs) / 1000}`,
      "# HELP crewon_runtime_worker_outcomes_total Durable worker outcomes by bounded kind and code.",
      "# TYPE crewon_runtime_worker_outcomes_total counter",
    ];
    for (const [key, count] of [...this.#outcomes].sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    )) {
      const [kind, code] = key.split("\0");
      lines.push(
        `crewon_runtime_worker_outcomes_total{kind="${escapeLabel(kind!)}",code="${escapeLabel(code!)}"} ${count}`,
      );
    }
    lines.push(
      "# HELP crewon_runtime_worker_last_outcome The last observed durable worker outcome.",
      "# TYPE crewon_runtime_worker_last_outcome gauge",
    );
    if (this.#lastOutcome !== null) {
      lines.push(
        `crewon_runtime_worker_last_outcome{kind="${escapeLabel(this.#lastOutcome.kind)}",code="${escapeLabel(this.#lastOutcome.code)}"} 1`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}

export type RuntimeOperationalServer = Readonly<{
  origin: string;
  close(): Promise<void>;
}>;

export async function startRuntimeOperationalServer(config: {
  port: number;
  metrics: RuntimeOperationalMetrics;
}): Promise<RuntimeOperationalServer> {
  const port = requirePort(config.port);
  const server = createServer(
    {
      headersTimeout: 5_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 8 * 1024,
      requestTimeout: 5_000,
    },
    (request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      if (request.method !== "GET") {
        sendJson(response, 405, { code: "method_not_allowed" });
        return;
      }
      if (request.url === "/health/live") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.url === "/health/ready") {
        sendJson(
          response,
          config.metrics.ready() ? 200 : 503,
          config.metrics.ready()
            ? { status: "ok" }
            : { code: "runtime_not_ready" },
        );
        return;
      }
      if (request.url === "/metrics") {
        response.statusCode = 200;
        response.setHeader("content-type", METRICS_CONTENT_TYPE);
        response.end(config.metrics.render());
        return;
      }
      sendJson(response, 404, { code: "not_found" });
    },
  );
  server.on("clientError", (_error, socket) => socket.destroy());
  await listen(server, port);
  const address = server.address() as AddressInfo;
  let closed = false;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await close(server);
    },
  };
}

export function resolveRuntimeOperationalPort(
  environment: NodeJS.ProcessEnv,
  required: boolean,
): number | null {
  const value = environment.CREWON_RUNTIME_OPERATIONAL_PORT?.trim();
  if (value === undefined || value.length === 0) {
    if (required) throw new Error("CREWON_RUNTIME_OPERATIONAL_PORT_required");
    return null;
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("CREWON_RUNTIME_OPERATIONAL_PORT_invalid");
  return port;
}

function outcomeLabel(outcome: RuntimeWorkerOutcome) {
  const code = "code" in outcome ? outcome.code : "";
  if (!/^[a-zA-Z0-9_.:-]{0,128}$/u.test(code))
    return { kind: outcome.kind, code: "invalid_failure_code" };
  return { kind: outcome.kind, code };
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function requirePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535)
    throw new Error("runtime_operational_port_invalid");
  return value;
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: Readonly<Record<string, string>>,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
