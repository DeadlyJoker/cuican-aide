import { randomUUID } from "node:crypto";

const uiOrigin = new URL(
  process.env.CREWON_UI_ORIGIN ?? "http://127.0.0.1:5175",
);
const runTimeoutMs = Number.parseInt(
  process.env.CREWON_AGENT_SMOKE_TIMEOUT_MS ?? "180000",
  10,
);
const pollIntervalMs = 500;
const terminalStatuses = new Set(["completed", "failed", "canceled"]);

if (!Number.isSafeInteger(runTimeoutMs) || runTimeoutMs < 1_000) {
  throw new Error("CREWON_AGENT_SMOKE_TIMEOUT_MS must be an integer >= 1000");
}

async function main() {
  const session = await readSession();
  const api = new ControlApi(session.csrfToken);
  await requireReadyHarness(api);

  if (process.argv.includes("--preflight")) {
    console.log("CrewON Control agent harness preflight passed.");
    return;
  }

  const nonce = `crewon-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let thread = null;
  try {
    const created = await api.request("POST", "/api/v1/threads", {
      body: { title: `Local agent smoke ${nonce}` },
      idempotencyKey: `thread-${randomUUID()}`,
    });
    thread = created.thread;

    const first = await api.request(
      "POST",
      `/api/v1/threads/${encodeURIComponent(thread.threadId)}/turns`,
      {
        body: {
          expectedRevision: thread.revision,
          content: `Remember this nonce and reply with only it: ${nonce}`,
          agentVersionId: null,
          executionIntent: "none",
        },
        idempotencyKey: `turn-${randomUUID()}`,
      },
    );
    await waitForCompletedRun(api, first.run.runId);

    thread = (
      await api.request(
        "GET",
        `/api/v1/threads/${encodeURIComponent(thread.threadId)}`,
      )
    ).thread;
    const second = await api.request(
      "POST",
      `/api/v1/threads/${encodeURIComponent(thread.threadId)}/turns`,
      {
        body: {
          expectedRevision: thread.revision,
          content: "Reply with only the nonce from my previous message.",
          agentVersionId: null,
          executionIntent: "none",
        },
        idempotencyKey: `turn-${randomUUID()}`,
      },
    );
    await waitForCompletedRun(api, second.run.runId);

    const messages = await api.request(
      "GET",
      `/api/v1/threads/${encodeURIComponent(thread.threadId)}/messages?limit=100`,
    );
    const assistantMessages = messages.data.filter(
      (message) => message.role === "assistant",
    );
    if (assistantMessages.length < 2) {
      throw new Error(
        `expected two assistant messages, received ${assistantMessages.length}`,
      );
    }
    const answer = assistantMessages.at(-1)?.content.trim() ?? "";
    if (!answer.includes(nonce)) {
      throw new Error(
        `second turn did not retain the first-turn nonce (expected ${nonce})`,
      );
    }
    console.log(
      `CrewON Control multi-turn smoke passed: ${thread.threadId} (${nonce}).`,
    );
  } finally {
    if (thread) {
      await deleteSmokeThread(api, thread.threadId);
    }
  }
}

async function readSession() {
  const response = await fetch(new URL("/control-api/session", uiOrigin), {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Control session is unavailable through Vite (${response.status}); start the desktop harness instead of the legacy-only web dev server`,
    );
  }
  const value = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.csrfToken !== "string" ||
    value.csrfToken.length < 32
  ) {
    throw new Error("Control session response is invalid");
  }
  return value;
}

async function requireReadyHarness(api) {
  await api.request("GET", "/api/v1/health/ready");
  const [{ settings }, activeAgent] = await Promise.all([
    api.request("GET", "/api/v1/model-provider-settings"),
    api.request("GET", "/api/v1/agent-versions/active"),
  ]);
  if (
    settings.runtimeAvailability !== "available" ||
    !settings.activeProviderId ||
    !settings.providers.some(
      (provider) =>
        provider.providerId === settings.activeProviderId && provider.isActive,
    )
  ) {
    throw new Error("Control runtime has no active model Provider");
  }
  if (
    !activeAgent.defaultAgentVersionId ||
    !activeAgent.data.some(
      (agent) =>
        agent.agentVersionId === activeAgent.defaultAgentVersionId &&
        agent.model?.adapterName === "direct-responses",
    )
  ) {
    throw new Error("Control runtime has no active TypeScript AgentVersion");
  }
  const probe = await api.request(
    "POST",
    "/api/v1/model-provider-settings/probe",
    { body: {}, idempotencyKey: `probe-${randomUUID()}` },
  );
  if (probe.status === "unreachable") {
    console.warn(
      "Model Provider probe is unreachable; continuing because local DNS/TUN interception can reject the pinned probe while the real Responses transport remains available.",
    );
  } else if (probe.status !== "ok") {
    throw new Error(`model Provider probe failed: ${probe.status}`);
  }
}

async function waitForCompletedRun(api, runId) {
  const deadline = Date.now() + runTimeoutMs;
  while (Date.now() < deadline) {
    const { run } = await api.request(
      "GET",
      `/api/v1/runs/${encodeURIComponent(runId)}`,
    );
    if (run.status === "completed") {
      return run;
    }
    if (terminalStatuses.has(run.status)) {
      throw new Error(
        `agent run ${runId} ended as ${run.status}${run.failure ? ` (${run.failure.code})` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`agent run ${runId} did not complete within ${runTimeoutMs}ms`);
}

async function deleteSmokeThread(api, threadId) {
  try {
    const { thread: current } = await api.request(
      "GET",
      `/api/v1/threads/${encodeURIComponent(threadId)}`,
    );
    await api.request(
      "POST",
      `/api/v1/threads/${encodeURIComponent(threadId)}:delete`,
      {
        body: { expectedRevision: current.revision },
        idempotencyKey: `delete-${randomUUID()}`,
      },
    );
  } catch (error) {
    console.warn(
      `Could not delete smoke thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

class ControlApi {
  constructor(csrfToken) {
    this.csrfToken = csrfToken;
  }

  async request(method, resourcePath, options = {}) {
    const headers = new Headers({
      Accept: "application/json",
      Origin: uiOrigin.origin,
    });
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      headers.set("X-CSRF-Token", this.csrfToken);
    }
    if (options.idempotencyKey) {
      headers.set("Idempotency-Key", options.idempotencyKey);
    }
    const response = await fetch(new URL(resourcePath, uiOrigin), {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${method} ${resourcePath} returned non-JSON ${response.status}`);
    }
    if (!response.ok) {
      const code = value?.error?.code ?? value?.code ?? "unknown_error";
      throw new Error(
        `${method} ${resourcePath} failed with ${response.status} (${code})`,
      );
    }
    return value;
  }
}

await main();
