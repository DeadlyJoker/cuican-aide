import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  formatCreativeProjectCursor,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";
import {
  CreativeProjectControlClient,
  type CreativeProjectControlTransport,
} from "./creative-project-control-client.ts";

const at = "2026-10-03T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const projectId = "project/中文 %2F",
  assetId = "asset\\中文%";
const project = {
  projectId,
  kind: "short-drama",
  title: "项目",
  revision: 2,
  state: "active",
  latestBriefRevision: 1,
  createdAt: at,
  updatedAt: at,
} as const;
const brief = {
  projectId,
  briefRevision: 1,
  text: " 原始需求\n保留空白 ",
  contentDigest: digest,
  createdAt: at,
};
const asset = {
  projectId,
  assetId,
  name: "概念图",
  revision: 1,
  latestAssetRevision: 1,
  createdAt: at,
  updatedAt: at,
};
const assetRevision = {
  projectId,
  assetId,
  assetRevision: 1,
  briefRevision: 1,
  briefContentDigest: digest,
  prompt: " 陶壶\n窗光 ",
  contentDigest: digest,
  createdAt: at,
};
const create = { title: project.title, briefText: brief.text };
const concept = {
  name: asset.name,
  prompt: assetRevision.prompt,
  briefRevision: 1,
  expectedProjectRevision: 2,
};
const conceptAppend = {
  prompt: assetRevision.prompt,
  briefRevision: 1,
  expectedProjectRevision: 3,
  expectedAssetMetadataRevision: 1,
};
function client(
  fetch: typeof globalThis.fetch,
  csrfToken: string | null = "csrf",
) {
  return new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "actual-token",
    csrfToken,
    origin: "https://ui.test",
    fetch,
  });
}
function requestInvalid(error: unknown) {
  return (
    error instanceof ControlApiProtocolError &&
    error.code === "control_client_creative_project_request_invalid"
  );
}
function responseInvalid(error: unknown) {
  return (
    error instanceof ControlApiProtocolError &&
    error.code === "control_client_creative_project_response_invalid"
  );
}
function writes(api: ControlApiClient) {
  return [
    () => api.creativeProjects.createProject(create, "create-key"),
    () =>
      api.creativeProjects.renameProject(
        projectId,
        { title: "名称", expectedProjectRevision: 2 },
        "rename-key",
      ),
    () =>
      api.creativeProjects.setProjectState(
        projectId,
        { state: "archived", expectedProjectRevision: 2 },
        "state-key",
      ),
    () =>
      api.creativeProjects.appendBrief(
        projectId,
        { text: brief.text, expectedProjectRevision: 2 },
        "brief-key",
      ),
    () => api.creativeProjects.createConcept(projectId, concept, "concept-key"),
    () =>
      api.creativeProjects.appendConceptRevision(
        projectId,
        assetId,
        conceptAppend,
        "revision-key",
      ),
  ];
}
test("all fourteen project methods use exact routes and the original authenticated transport", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const responses: unknown[] = [
    { projects: [project], nextCursor: null },
    { project },
    { disposition: "committed", project, brief },
    {
      disposition: "committed",
      project: { ...project, title: "新名称", revision: 3 },
    },
    {
      disposition: "committed",
      project: { ...project, state: "archived", revision: 3 },
    },
    { brief },
    { briefs: [brief], nextAfterBriefRevision: 1 },
    {
      disposition: "committed",
      project: { ...project, revision: 3, latestBriefRevision: 2 },
      brief: { ...brief, briefRevision: 2 },
    },
    { asset },
    { assets: [asset], nextAfterAssetId: assetId },
    {
      disposition: "committed",
      project: { ...project, revision: 3 },
      asset,
      assetRevision,
    },
    { assetRevision },
    { revisions: [assetRevision], nextAfterAssetRevision: 1 },
    {
      disposition: "replayed",
      project: { ...project, revision: 4 },
      asset: { ...asset, revision: 2, latestAssetRevision: 2 },
      assetRevision: { ...assetRevision, assetRevision: 2 },
    },
  ];
  const controller = new AbortController(),
    options = { signal: controller.signal };
  const api = client(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json(responses.shift());
  });
  assert.equal(api.creativeProjects, api.creativeProjects);
  assert.equal(
    (
      await api.creativeProjects.listProjects(
        { state: "active", limit: 2 },
        options,
      )
    ).projects[0]?.projectId,
    projectId,
  );
  await api.creativeProjects.getProject(projectId, options);
  await api.creativeProjects.createProject(create, "create-key", options);
  await api.creativeProjects.renameProject(
    projectId,
    { title: "新名称", expectedProjectRevision: 2 },
    "rename-key",
    options,
  );
  await api.creativeProjects.setProjectState(
    projectId,
    { state: "archived", expectedProjectRevision: 2 },
    "state-key",
    options,
  );
  await api.creativeProjects.getBrief(projectId, 1, options);
  await api.creativeProjects.listBriefs(
    projectId,
    { afterBriefRevision: 0, limit: 2 },
    options,
  );
  await api.creativeProjects.appendBrief(
    projectId,
    { text: brief.text, expectedProjectRevision: 2 },
    "brief-key",
    options,
  );
  await api.creativeProjects.getConceptAsset(projectId, assetId, options);
  await api.creativeProjects.listConceptAssets(
    projectId,
    { afterAssetId: null, limit: 2 },
    options,
  );
  await api.creativeProjects.createConcept(
    projectId,
    concept,
    "concept-key",
    options,
  );
  await api.creativeProjects.getConceptRevision(projectId, assetId, 1, options);
  await api.creativeProjects.listConceptRevisions(
    projectId,
    assetId,
    { afterAssetRevision: 0, limit: 2 },
    options,
  );
  await api.creativeProjects.appendConceptRevision(
    projectId,
    assetId,
    conceptAppend,
    "revision-key",
    options,
  );
  const prefix = "https://control.test/api/v1/creative-projects",
    path = `${prefix}/${encodeURIComponent(projectId)}`,
    assetPath = `${path}/concepts/${encodeURIComponent(assetId)}`;
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      `${prefix}?state=active&limit=2`,
      path,
      prefix,
      `${path}/title`,
      `${path}/state`,
      `${path}/briefs/1`,
      `${path}/briefs?afterBriefRevision=0&limit=2`,
      `${path}/briefs`,
      assetPath,
      `${path}/concepts?limit=2`,
      `${path}/concepts`,
      `${assetPath}/revisions/1`,
      `${assetPath}/revisions?afterAssetRevision=0&limit=2`,
      `${assetPath}/revisions`,
    ],
  );
  const mutationKeys = [
    null,
    null,
    "create-key",
    "rename-key",
    "state-key",
    null,
    null,
    "brief-key",
    null,
    null,
    "concept-key",
    null,
    null,
    "revision-key",
  ];
  calls.forEach(({ init }, index) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer actual-token");
    assert.equal(headers.get("origin"), "https://ui.test");
    assert.equal(headers.get("idempotency-key"), mutationKeys[index]);
    assert.equal(
      headers.get("x-csrf-token"),
      init.method === "GET" ? null : "csrf",
    );
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "include");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    if (init.method === "GET") assert.equal(init.body, undefined);
    else {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      for (const name of [
        "projectId",
        "assetId",
        "idempotencyKey",
        "ownerPrincipalId",
        "tenantId",
        "spaceId",
        "principalId",
        "actorId",
      ])
        assert.equal(Object.hasOwn(body, name), false);
    }
  });
});
test("defaults and nullable cursors produce bounded queries without leaking persistence ownership", async () => {
  const calls: string[] = [];
  const api = client(async (url) => {
    calls.push(String(url));
    return Response.json({ projects: [], nextCursor: null });
  }, null);
  await api.creativeProjects.listProjects();
  await api.creativeProjects.listProjects({ state: "all", cursor: null });
  const cursor = formatCreativeProjectCursor("archived", {
    updatedAt: at,
    projectId,
  });
  await api.creativeProjects.listProjects({
    state: "archived",
    cursor,
    limit: 50,
  });
  assert.deepEqual(calls, [
    "https://control.test/api/v1/creative-projects",
    "https://control.test/api/v1/creative-projects?state=all",
    `https://control.test/api/v1/creative-projects?state=archived&cursor=${cursor}&limit=50`,
  ]);
});
test("all writes require CSRF before any network dispatch", async () => {
  let fetches = 0;
  const api = client(async () => {
    fetches++;
    return Response.json({});
  }, null);
  for (const write of writes(api))
    await assert.rejects(write(), {
      code: "control_client_csrf_token_required",
    });
  assert.equal(fetches, 0);
});
test("invalid request shapes, scalar limits, revisions and path normalization never dispatch", async () => {
  let fetches = 0;
  const api = client(async () => {
    fetches++;
    return Response.json({});
  });
  const attempts = [
    () => api.creativeProjects.getProject("."),
    () => api.creativeProjects.getProject(".."),
    () => api.creativeProjects.getConceptAsset(projectId, ".."),
    () => api.creativeProjects.getBrief(projectId, "1" as never),
    () => api.creativeProjects.getConceptRevision(projectId, assetId, 0),
    () =>
      api.creativeProjects.createProject(
        { ...create, ownerPrincipalId: "injected" } as never,
        "key",
      ),
    () =>
      api.creativeProjects.createProject(
        { title: project.title, briefText: "汉".repeat(2731) },
        "key",
      ),
    () =>
      api.creativeProjects.renameProject(
        projectId,
        { title: project.title, expectedProjectRevision: 0 },
        "key",
      ),
    () =>
      api.creativeProjects.setProjectState(
        projectId,
        { state: "deleted", expectedProjectRevision: 2 } as never,
        "key",
      ),
    () =>
      api.creativeProjects.appendBrief(
        projectId,
        { text: brief.text, expectedProjectRevision: 2 },
        "",
      ),
    () => api.creativeProjects.createProject(create, "one,two"),
    () =>
      api.creativeProjects.createConcept(
        projectId,
        { ...concept, prompt: "a".repeat(2001) },
        "key",
      ),
    () =>
      api.creativeProjects.appendConceptRevision(
        projectId,
        assetId,
        { ...conceptAppend, expectedAssetMetadataRevision: 0 },
        "key",
      ),
    () => api.creativeProjects.listProjects({ limit: "2" } as never),
    () => api.creativeProjects.listProjects({ limit: 51 }),
    () =>
      api.creativeProjects.listProjects({
        state: "all",
        tenantId: "injected",
      } as never),
    () =>
      api.creativeProjects.listBriefs(projectId, { afterBriefRevision: -1 }),
    () =>
      api.creativeProjects.listConceptAssets(projectId, { afterAssetId: "" }),
    () =>
      api.creativeProjects.listConceptRevisions(projectId, assetId, {
        afterAssetRevision: 1.5,
      }),
  ];
  for (const attempt of attempts)
    await assert.rejects(attempt(), requestInvalid);
  assert.equal(fetches, 0);
});
test("queries and mutation body snapshots cannot drift while the transport is pending", async () => {
  let resolve!: (value: Response) => void;
  const api = client(
    async () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const query = { afterBriefRevision: 0, limit: 1 };
  const reading = api.creativeProjects.listBriefs(projectId, query);
  query.afterBriefRevision = 99;
  query.limit = 50;
  resolve(Response.json({ briefs: [brief], nextAfterBriefRevision: 1 }));
  assert.equal((await reading).briefs[0]?.briefRevision, 1);
  const body: { title: string; briefText: string } = {
    title: project.title,
    briefText: brief.text,
  };
  const creating = api.creativeProjects.createProject(body, "once");
  body.title = "changed after dispatch";
  body.briefText = "other";
  resolve(Response.json({ disposition: "committed", project, brief }));
  assert.equal((await creating).project.title, project.title);
});
test("caller getters, hidden fields and unsafe query hooks are rejected without evaluation", async () => {
  let calls = 0,
    fetches = 0;
  const api = client(async () => {
    fetches++;
    return Response.json({});
  });
  await assert.rejects(
    api.creativeProjects.listProjects({
      get limit() {
        calls++;
        return 1;
      },
    }),
    requestInvalid,
  );
  await assert.rejects(
    api.creativeProjects.createProject(
      {
        get title() {
          calls++;
          return "title";
        },
        briefText: "brief",
      },
      "key",
    ),
    requestInvalid,
  );
  const query = { limit: 1 };
  Object.defineProperty(query, "owner", { value: "hidden" });
  await assert.rejects(
    api.creativeProjects.listProjects(query),
    requestInvalid,
  );
  await assert.rejects(
    api.creativeProjects.listProjects({
      limit: 1,
      toJSON() {
        calls++;
        return {};
      },
    } as never),
    requestInvalid,
  );
  assert.equal(calls, 0);
  assert.equal(fetches, 0);
});
test("read replies reject mixed project/asset/revision identity and private fields", async () => {
  const cases = [
    {
      response: { project: { ...project, projectId: "other" } },
      run: (api: ControlApiClient) =>
        api.creativeProjects.getProject(projectId),
    },
    {
      response: { brief: { ...brief, briefRevision: 2 } },
      run: (api: ControlApiClient) =>
        api.creativeProjects.getBrief(projectId, 1),
    },
    {
      response: { asset: { ...asset, projectId: "other" } },
      run: (api: ControlApiClient) =>
        api.creativeProjects.getConceptAsset(projectId, assetId),
    },
    {
      response: { assetRevision: { ...assetRevision, assetId: "other" } },
      run: (api: ControlApiClient) =>
        api.creativeProjects.getConceptRevision(projectId, assetId, 1),
    },
    {
      response: { project: { ...project, ownerPrincipalId: "private" } },
      run: (api: ControlApiClient) =>
        api.creativeProjects.getProject(projectId),
    },
  ];
  for (const value of cases)
    await assert.rejects(
      value.run(client(async () => Response.json(value.response))),
      responseInvalid,
    );
});
test("page replies reject cursor substitutions and unordered or wrong-scope history", async () => {
  const wrongCursor = formatCreativeProjectCursor("active", {
    updatedAt: at,
    projectId: "other",
  });
  await assert.rejects(
    client(async () =>
      Response.json({ projects: [project], nextCursor: wrongCursor }),
    ).creativeProjects.listProjects(),
    responseInvalid,
  );
  await assert.rejects(
    client(async () =>
      Response.json({ briefs: [brief, brief], nextAfterBriefRevision: null }),
    ).creativeProjects.listBriefs(projectId),
    responseInvalid,
  );
  await assert.rejects(
    client(async () =>
      Response.json({
        assets: [{ ...asset, projectId: "other" }],
        nextAfterAssetId: null,
      }),
    ).creativeProjects.listConceptAssets(projectId),
    responseInvalid,
  );
  await assert.rejects(
    client(async () =>
      Response.json({ revisions: [assetRevision], nextAfterAssetRevision: 2 }),
    ).creativeProjects.listConceptRevisions(projectId, assetId),
    responseInvalid,
  );
});
test("committed and replayed mutation receipts must match the original confirmed inputs", async () => {
  for (const disposition of ["committed", "replayed"]) {
    assert.equal(
      (
        await client(async () =>
          Response.json({ disposition, project, brief }),
        ).creativeProjects.createProject(create, "once")
      ).disposition,
      disposition,
    );
    await assert.rejects(
      client(async () =>
        Response.json({
          disposition,
          project,
          brief: { ...brief, text: "other" },
        }),
      ).creativeProjects.createProject(create, "once"),
      responseInvalid,
    );
    await assert.rejects(
      client(async () =>
        Response.json({
          disposition,
          project: { ...project, revision: 3 },
          asset,
          assetRevision: { ...assetRevision, prompt: "other" },
        }),
      ).creativeProjects.createConcept(projectId, concept, "once"),
      responseInvalid,
    );
  }
});
test("sixty-KiB response budget rejects content-length and cancels oversized read streams", async () => {
  let cancelled = false;
  const streamed = client(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new Uint8Array(MAX_CREATIVE_PROJECT_RESPONSE_BYTES + 1),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(streamed.creativeProjects.getProject(projectId), {
    code: "control_client_workspace_response_too_large",
  });
  assert.equal(cancelled, true);
  await assert.rejects(
    client(async () =>
      Response.json(
        { project },
        {
          headers: {
            "content-length": String(MAX_CREATIVE_PROJECT_RESPONSE_BYTES + 1),
          },
        },
      ),
    ).creativeProjects.getProject(projectId),
    { code: "control_client_workspace_response_too_large" },
  );
});
test("abort before dispatch and after delayed transport cannot publish a stale receipt", async () => {
  let fetches = 0;
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    client(async () => {
      fetches++;
      return Response.json({ project });
    }).creativeProjects.getProject(projectId, { signal: aborted.signal }),
    { name: "AbortError" },
  );
  assert.equal(fetches, 0);
  const delayed = new AbortController();
  await assert.rejects(
    client(async (_url, init) => {
      delayed.abort();
      assert.equal(init?.signal?.aborted, true);
      return Response.json({ disposition: "committed", project, brief });
    }).creativeProjects.createProject(create, "once", {
      signal: delayed.signal,
    }),
    { name: "AbortError" },
  );
});
test("deadline aborts the actual transport scope and rejects even when transport ignores cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve!: (value: unknown) => void,
    actualSignal: AbortSignal | undefined,
    published = false;
  const transport: CreativeProjectControlTransport = {
    json(_method, _path, _body, options) {
      actualSignal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
    protocolError(code) {
      return new ControlApiProtocolError(code);
    },
  };
  const api = new CreativeProjectControlClient(transport, { deadlineMs: 15 });
  const pending = api.getProject(projectId);
  const observed = pending.then(
    () => {
      published = true;
    },
    () => undefined,
  );
  t.mock.timers.tick(15);
  await assert.rejects(pending, { name: "TimeoutError" });
  assert.equal(actualSignal?.aborted, true);
  assert.equal(actualSignal?.reason.name, "TimeoutError");
  resolve({ project });
  await observed;
  await Promise.resolve();
  assert.equal(published, false);
});
test("caller abort wins against an uncooperative transport and its late rejection stays observed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reject!: (error: unknown) => void, actualSignal: AbortSignal | undefined;
  const api = new CreativeProjectControlClient(
    {
      json(_method, _path, _body, options) {
        actualSignal = options.signal;
        return new Promise((_done, fail) => {
          reject = fail;
        });
      },
      protocolError(code) {
        return new ControlApiProtocolError(code);
      },
    },
    { deadlineMs: 20 },
  );
  const caller = new AbortController(),
    reason = new DOMException("account switched", "AbortError");
  const pending = api.getProject(projectId, { signal: caller.signal });
  caller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(actualSignal?.reason, reason);
  reject(new Error("late physical transport failure"));
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal(actualSignal?.reason, reason);
});
test("successful requests clear deadline timers and remove caller/scope abort listeners", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearing = t.mock.method(globalThis, "clearTimeout");
  const caller = new AbortController();
  const removeCaller = t.mock.method(caller.signal, "removeEventListener");
  let scope: AbortSignal | undefined;
  let removeScope: { mock: { callCount(): number } } | undefined;
  const api = new CreativeProjectControlClient(
    {
      async json(_method, _path, _body, options) {
        scope = options.signal!;
        removeScope = t.mock.method(scope, "removeEventListener");
        return { project };
      },
      protocolError(code) {
        return new ControlApiProtocolError(code);
      },
    },
    { deadlineMs: 20 },
  );
  assert.deepEqual(await api.getProject(projectId, { signal: caller.signal }), {
    project,
  });
  assert.equal(clearing.mock.callCount(), 1);
  assert.equal(removeCaller.mock.callCount(), 1);
  assert.equal(removeScope?.mock.callCount(), 1);
  caller.abort();
  t.mock.timers.tick(100);
  assert.equal(scope?.aborted, false);
});
test("the actual caller signal stays bound when request options change while pending", async (t) => {
  const caller = new AbortController();
  const replacement = new AbortController();
  const removed = t.mock.method(caller.signal, "removeEventListener");
  let transportSignal: AbortSignal | undefined;
  let resolve!: (value: unknown) => void;
  const api = new CreativeProjectControlClient({
    protocolError: (code) => new Error(code),
    json: async (_method, _path, _body, options) => {
      transportSignal = options.signal;
      return new Promise<unknown>((done) => {
        resolve = done;
      });
    },
  });
  const options = { signal: caller.signal };
  const reading = api.getProject(projectId, options);
  options.signal = replacement.signal;
  const reason = new DOMException("actual caller canceled", "AbortError");
  caller.abort(reason);
  await assert.rejects(reading, (error) => error === reason);
  assert.equal(transportSignal?.aborted, true);
  assert.equal(transportSignal?.reason, reason);
  assert.equal(replacement.signal.aborted, false);
  assert.equal(removed.mock.callCount(), 1);
  resolve({ project });
  await Promise.resolve();
});

test("deadline settings use a bounded default and reject invalid configuration", async (t) => {
  const transport: CreativeProjectControlTransport = {
    json() {
      return new Promise(() => undefined);
    },
    protocolError(code) {
      return new ControlApiProtocolError(code);
    },
  };
  for (const deadlineMs of [
    0,
    -1,
    1.5,
    60_001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null as never,
    "10" as never,
  ])
    assert.throws(
      () => new CreativeProjectControlClient(transport, { deadlineMs }),
      { code: "control_client_creative_project_deadline_invalid" },
    );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = new CreativeProjectControlClient(transport).getProject(
    projectId,
  );
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, { name: "TimeoutError" });
});
test("manual redirects, non-JSON and real Control errors are not transformed into successful project data", async () => {
  await assert.rejects(
    client(async (_url, init) => {
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://other.test/private" },
      });
    }).creativeProjects.getProject(projectId),
    { code: "control_api_error_envelope_invalid" },
  );
  await assert.rejects(
    client(
      async () =>
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        }),
    ).creativeProjects.listProjects(),
    { code: "control_api_content_type_invalid" },
  );
  await assert.rejects(
    client(async () =>
      Response.json(
        {
          error: {
            category: "authorization",
            code: "creative_project_denied",
            requestId: "request-1",
          },
        },
        { status: 403 },
      ),
    ).creativeProjects.getProject(projectId),
    (error) =>
      error instanceof ControlApiClientError &&
      error.status === 403 &&
      error.code === "creative_project_denied",
  );
});
