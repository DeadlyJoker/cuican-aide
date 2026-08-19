import type { FastifyInstance, FastifyRequest } from "fastify";

const DURATION_BUCKETS = [0.005, 0.025, 0.1, 0.5, 2, 10] as const;
const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

type HttpSeries = {
  count: number;
  sumSeconds: number;
  buckets: number[];
};

export class ControlOperationalMetrics {
  readonly #readiness: Readonly<{ checkReady(): Promise<void> }>;
  readonly #outboxFailure: () => string | null;
  readonly #automationFailure: () => string | null;
  readonly #now: () => number;
  readonly #startedAtMs: number;
  readonly #requests = new Map<string, HttpSeries>();
  readonly #requestStartedAt = new WeakMap<FastifyRequest, number>();

  constructor(config: {
    readiness: Readonly<{ checkReady(): Promise<void> }>;
    outboxFailure: () => string | null;
    automationFailure: () => string | null;
    now?: () => number;
  }) {
    this.#readiness = config.readiness;
    this.#outboxFailure = config.outboxFailure;
    this.#automationFailure = config.automationFailure;
    this.#now = config.now ?? performance.now.bind(performance);
    this.#startedAtMs = this.#now();
  }

  install(app: FastifyInstance): void {
    app.addHook("onRequest", async (request) => {
      this.#requestStartedAt.set(request, this.#now());
    });
    app.addHook("onResponse", async (request, reply) => {
      const startedAt = this.#requestStartedAt.get(request);
      if (startedAt === undefined) return;
      this.#recordHttp(
        request.method,
        request.routeOptions.url ?? "unmatched",
        reply.statusCode,
        Math.max(0, this.#now() - startedAt) / 1000,
      );
    });
    app.get("/internal/v1/metrics", async (_request, reply) => {
      reply
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .type(METRICS_CONTENT_TYPE);
      return this.#render();
    });
  }

  async #render(): Promise<string> {
    let ready = true;
    try {
      await this.#readiness.checkReady();
    } catch {
      ready = false;
    }
    const lines = [
      "# HELP crewon_control_ready Whether the canonical Store is ready.",
      "# TYPE crewon_control_ready gauge",
      `crewon_control_ready ${ready ? 1 : 0}`,
      "# HELP crewon_control_uptime_seconds Control process observation uptime.",
      "# TYPE crewon_control_uptime_seconds gauge",
      `crewon_control_uptime_seconds ${Math.max(0, this.#now() - this.#startedAtMs) / 1000}`,
      "# HELP crewon_control_background_failure Current background-loop failure by bounded component and code.",
      "# TYPE crewon_control_background_failure gauge",
      backgroundFailure("outbox", this.#outboxFailure()),
      backgroundFailure("automation_scheduler", this.#automationFailure()),
      "# HELP crewon_control_http_requests_total HTTP requests by bounded route template and status class.",
      "# TYPE crewon_control_http_requests_total counter",
      "# HELP crewon_control_http_request_duration_seconds HTTP request latency by bounded route template and status class.",
      "# TYPE crewon_control_http_request_duration_seconds histogram",
    ];
    for (const [key, series] of [...this.#requests].sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    )) {
      const [method, route, status] = key.split("\0");
      const labels = `method="${method}",route="${escapeLabel(route!)}",status="${status}"`;
      lines.push(
        `crewon_control_http_requests_total{${labels}} ${series.count}`,
      );
      for (let index = 0; index < DURATION_BUCKETS.length; index += 1) {
        lines.push(
          `crewon_control_http_request_duration_seconds_bucket{${labels},le="${DURATION_BUCKETS[index]}"} ${series.buckets[index]}`,
        );
      }
      lines.push(
        `crewon_control_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${series.count}`,
        `crewon_control_http_request_duration_seconds_sum{${labels}} ${series.sumSeconds}`,
        `crewon_control_http_request_duration_seconds_count{${labels}} ${series.count}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  #recordHttp(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    const boundedMethod = /^[A-Z]{3,10}$/u.test(method) ? method : "OTHER";
    const boundedRoute =
      route.length <= 256 && /^\/[A-Za-z0-9_/:.*-]+$/u.test(route)
        ? route
        : "unmatched";
    const status =
      Number.isSafeInteger(statusCode) && statusCode >= 100 && statusCode <= 599
        ? `${Math.floor(statusCode / 100)}xx`
        : "other";
    const key = `${boundedMethod}\0${boundedRoute}\0${status}`;
    const series = this.#requests.get(key) ?? {
      count: 0,
      sumSeconds: 0,
      buckets: DURATION_BUCKETS.map(() => 0),
    };
    series.count += 1;
    series.sumSeconds += durationSeconds;
    for (let index = 0; index < DURATION_BUCKETS.length; index += 1) {
      if (durationSeconds <= DURATION_BUCKETS[index]!)
        series.buckets[index]! += 1;
    }
    this.#requests.set(key, series);
  }
}

function backgroundFailure(component: string, value: string | null): string {
  const code =
    value === null
      ? ""
      : /^[a-z0-9_]{1,128}$/u.test(value)
        ? value
        : "invalid_failure_code";
  return `crewon_control_background_failure{component="${component}",code="${code}"} ${value === null ? 0 : 1}`;
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}
