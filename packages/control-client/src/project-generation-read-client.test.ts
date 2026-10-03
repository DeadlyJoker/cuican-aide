import assert from "node:assert/strict";
import test from "node:test";
import type { ConceptGenerationLocator } from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import { CreativeProjectControlClient } from "./creative-project-control-client.ts";

const locator = {
  projectId: "项目 /%2F",
  assetId: "概念\\ %",
  assetRevision: 2,
};
function response() {
  return {
    generation: {
      ...locator,
      briefRevision: 1,
      createdAt: "2026-10-03T00:00:00.000Z",
      task: {
        runId: "original-run",
        threadId: "original-thread",
        pluginId: "crewon.comfyui-krea2",
        pluginVersion: "1.0.0",
        configurationRevision: 1,
        runStatus: "running",
        sourceRunId: null,
        operations: [],
        truncated: false,
      },
    },
  };
}
function client(fetch: typeof globalThis.fetch) {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "fixture-session",
    csrfToken: null,
    origin: "https://ui.test",
    fetch,
  });
}

test("lookup uses the original authenticated finite GET and exact encoded source, without a supplied target", async () => {
  let requests = 0;
  const api = client(async (input, init) => {
    requests++;
    assert.equal(
      String(input),
      `https://control.test/api/v1/creative-projects/${encodeURIComponent(locator.projectId)}/concepts/${encodeURIComponent(locator.assetId)}/revisions/2/generation`,
    );
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer fixture-session",
    );
    assert.equal(new Headers(init?.headers).get("idempotency-key"), null);
    assert.equal(init?.redirect, "manual");
    return Response.json(response());
  });
  assert.deepEqual(
    await api.creativeProjects.getConceptGeneration(locator),
    response(),
  );
  assert.equal(requests, 1);
});

test("lookup captures its source before waiting and accepts an authorized empty slot", async () => {
  const mutable = structuredClone(locator);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = client(async (input) => {
    assert.ok(String(input).includes("/revisions/2/generation"));
    await held;
    return Response.json(response());
  });
  const work = api.creativeProjects.getConceptGeneration(mutable);
  mutable.assetRevision = 3;
  mutable.assetId = "other";
  release();
  assert.equal((await work).generation!.assetRevision, 2);
  assert.deepEqual(
    await client(async () =>
      Response.json({ generation: null }),
    ).creativeProjects.getConceptGeneration(locator),
    { generation: null },
  );
});

test("forged account, execution and Run selectors never reach the transport", async () => {
  let requests = 0;
  const api = client(async () => {
    requests++;
    return Response.json(response());
  });
  for (const field of ["actor", "pluginId", "runId", "target", "url"])
    await assert.rejects(
      api.creativeProjects.getConceptGeneration({
        ...locator,
        [field]: "injected",
      } as ConceptGenerationLocator),
      (error) =>
        error instanceof ControlApiProtocolError &&
        error.code === "control_client_creative_project_request_invalid",
    );
  await assert.rejects(
    api.creativeProjects.getConceptGeneration({ ...locator, assetRevision: 0 }),
  );
  assert.equal(requests, 0);
});

test("cross-project, cross-input and private responses fail strict publication", async () => {
  for (const field of ["projectId", "assetId", "assetRevision"] as const) {
    const raw = response();
    Object.assign(raw.generation, {
      [field]: field === "assetRevision" ? 1 : "other",
    });
    await assert.rejects(
      client(async () =>
        Response.json(raw),
      ).creativeProjects.getConceptGeneration(locator),
      (error) =>
        error instanceof ControlApiProtocolError &&
        error.code === "control_client_creative_project_response_invalid",
    );
  }
  const raw = response();
  Object.assign(raw.generation.task, { binding: {} });
  await assert.rejects(
    client(async () =>
      Response.json(raw),
    ).creativeProjects.getConceptGeneration(locator),
  );
});

test("not found and forbidden responses retain original authenticated HTTP semantics", async () => {
  for (const status of [403, 404]) {
    await assert.rejects(
      client(async () =>
        Response.json(
          {
            error: {
                  category: status === 403 ? "authorization" : "notFound",
                  code: "fixture_lookup_rejected",
                  requestId: "fixture-request",
            },
          },
          { status },
        ),
      ).creativeProjects.getConceptGeneration(locator),
      (error) =>
        error instanceof ControlApiClientError && error.status === status,
    );
  }
});

test("caller cancellation ends only its wait and does not publish a late task", async () => {
  let resolve!: (value: unknown) => void;
  const late = new Promise<unknown>((done) => {
    resolve = done;
  });
  let transportSignal: AbortSignal | undefined;
  const api = new CreativeProjectControlClient({
    json: async (_method, _path, _body, options) => {
      transportSignal = options.signal;
      return late;
    },
    protocolError: (code) => new ControlApiProtocolError(code),
  });
  const caller = new AbortController();
  const reason = new Error("lookup caller ended");
  const work = api.getConceptGeneration(locator, { signal: caller.signal });
  caller.abort(reason);
  await assert.rejects(work, (error) => error === reason);
  assert.equal(transportSignal!.aborted, true);
  resolve(response());
  await Promise.resolve();
  let called = false;
  const ended = client(async () => {
    called = true;
    return Response.json(response());
  });
  await assert.rejects(
    ended.creativeProjects.getConceptGeneration(locator, {
      signal: caller.signal,
    }),
    (error) => error === reason,
  );
  assert.equal(called, false);
});

test("lookup remains finite when the transport ignores its deadline", async () => {
  let resolve!: (value: unknown) => void;
  const late = new Promise<unknown>((done) => {
    resolve = done;
  });
  const api = new CreativeProjectControlClient(
    {
      json: async () => late,
      protocolError: (code) => new ControlApiProtocolError(code),
    },
    { deadlineMs: 10 },
  );
  await assert.rejects(
    api.getConceptGeneration(locator),
    (error) => error instanceof DOMException && error.name === "TimeoutError",
  );
  resolve(response());
  await Promise.resolve();
});
