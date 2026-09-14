import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AutomationApplicationService,
  ThreadApplicationService,
} from "@crewon/application";
import { ControlApiClient } from "@crewon/control-client";
import type { CreateAutomationRequest } from "@crewon/contracts";
import {
  createSkillVersion,
  renderSkillInvocationContext,
  type SkillInvocationSpec,
} from "@crewon/domain";
import { InMemoryRunStore } from "@crewon/store";

import { createWebBff } from "../../web-bff/src/web-bff.ts";
import { buildControlApi } from "./control-api.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

test("F04-R01/R03 ControlApiClient through real BFF and Control HTTP handlers preserves Skill capability and legacy defaults", async (context) => {
  const publicOrigin = "https://automation-bff.example.test";
  const sessionToken = "f04-bff-control-session-token-32-bytes-minimum";
  const controlCsrf = "f04-control-csrf-token-with-32-bytes-minimum";
  const cookie = "crewon_session=opaque-fixture-session";
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
  const store = new InMemoryRunStore();
  let nextId = 0;
  const digester = {
    sha256: (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
  const common = {
    store,
    digester,
    clock: { now: () => "2026-09-14T00:00:00Z" },
    ids: { nextId: (kind: string) => `${kind}-${++nextId}` },
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
  };
  const version = createSkillVersion(
    {
      skillId: "bff-skill",
      versionId: "version-1",
      createdAt: common.clock.now(),
      source: {
        recordingId: "bff-contract-fixture",
        revision: 1,
        contentDigest: digester.sha256("fixture"),
        provenance: "contract-fixture",
      },
      method: {
        name: "Report",
        purpose: "Report the current progress",
        steps: ["Read progress and summarize"],
        parameters: [],
        requiredToolRefs: [],
        completionCriteria: ["Progress is reported"],
        knownExceptions: ["Missing status is reported explicitly"],
        runtimeRequirements: [],
      },
    },
    digester,
  );
  const invocation: SkillInvocationSpec = {
    schemaVersion: "crewon.skill-invocation.v1",
    skill: version.ref,
    parameters: {},
    requiredToolRefs: [],
  };
  const threads = new ThreadApplicationService(common);
  const automations = new AutomationApplicationService({
    ...common,
    routeResolver: {
      resolveRoute: async () => ({
        authorityId: "authority-1",
        runtimeGeneration: "generation-1",
        agentVersionId: "agent-version-1",
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
      }),
    },
    // C02 admission is a contract fixture; BFF and Control handlers below are real.
    skills: {
      resolveVersion: async () => version,
      admitInvocation: async (_actor, spec) => ({
        version,
        invocation: spec,
        context: renderSkillInvocationContext(version, spec),
        agentVersionId: "agent-version-1",
      }),
    },
  });
  // This fixture exercises only Automation routes and their real dependencies.
  const app = buildControlApi({
    threads,
    automations,
    heartbeatIntervalMs: null,
    identity: new StandaloneIdentity({
      actor,
      sessionToken,
      csrfToken: controlCsrf,
      allowedOrigins: [publicOrigin],
    }),
  } as unknown as Parameters<typeof buildControlApi>[0]);
  context.after(async () => {
    await app.close();
    await store.close();
  });
  const forwarded: Array<{
    method: string;
    path: string;
    version: string | null;
  }> = [];
  const bff = createWebBff({
    publicOrigin,
    controlTarget: "http://127.0.0.1:3210",
    controlCsrfToken: controlCsrf,
    controlBffToken: "f04-control-bff-service-token-32-bytes-minimum",
    csrfSecret: "f04-browser-csrf-secret-32-bytes-minimum",
    identity: {
      resolve: async ({ cookie: received }) =>
        received === cookie
          ? {
              sessionId: "bff-session-1234567890-abcdef",
              expiresAt: "2099-01-01T00:00:00.000Z",
              controlAccessToken: sessionToken,
            }
          : null,
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const method = request.method;
      assert.ok(method === "GET" || method === "POST");
      forwarded.push({
        method,
        path: url.pathname,
        version: request.headers.get("x-crewon-automation-version"),
      });
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const response = await app.inject({
        method,
        url: `${url.pathname}${url.search}`,
        headers,
        ...(method === "POST"
          ? { payload: Buffer.from(await request.arrayBuffer()) }
          : {}),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const browserFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("cookie", cookie);
    return bff.handle(new Request(request, { headers }));
  };
  const bootstrap = await browserFetch(`${publicOrigin}/control-api/session`);
  assert.equal(bootstrap.status, 200);
  const { csrfToken } = (await bootstrap.json()) as { csrfToken: string };
  const client = new ControlApiClient({
    baseUrl: publicOrigin,
    origin: publicOrigin,
    csrfToken,
    fetch: browserFetch,
  });
  const thread = await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "bff-thread",
    title: "BFF schedules",
  });
  const body: CreateAutomationRequest = {
    threadId: thread.state.threadId,
    expectedThreadRevision: 1,
    title: "Skill report",
    prompt: "Use the fixed Skill",
    agentVersionId: null,
    schedule: {
      scheduleType: "once" as const,
      nextRunAt: "2099-09-15T00:00:00Z",
      intervalSeconds: 0,
      time: "00:00",
      weekday: 2,
      timezone: "UTC",
    },
    skillInvocation: {
      ...invocation,
      parameters: { ...invocation.parameters },
      requiredToolRefs: [...invocation.requiredToolRefs],
    },
    parameterBindings: {},
  };
  const created = await client.createAutomation(body, "skill-create");
  assert.equal(created.disposition, "committed");
  assert.deepEqual(created.automation.skillInvocation, invocation);
  assert.deepEqual(
    (await client.getAutomation(created.automation.automationId)).automation,
    { ...created.automation, skillReadiness: { state: "ready", code: null } },
  );

  const legacyMutation = (payload: unknown, key: string) =>
    browserFetch(`${publicOrigin}/api/v1/automations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": publicOrigin,
        "x-csrf-token": csrfToken,
        "idempotency-key": key,
      },
      body: JSON.stringify(payload),
    });
  const unsupported = await legacyMutation(body, "legacy-skill-attempt");
  assert.equal(unsupported.status, 409);
  assert.equal(
    ((await unsupported.json()) as { error: { code: string } }).error.code,
    "automation_client_upgrade_required",
  );
  const {
    skillInvocation: _skill,
    parameterBindings: _parameters,
    ...legacyBody
  } = body;
  const legacyCreated = await legacyMutation(legacyBody, "legacy-create");
  assert.equal(legacyCreated.status, 201);
  const legacyList = await browserFetch(
    `${publicOrigin}/api/v1/automations?limit=100`,
  );
  assert.equal(legacyList.status, 200);
  const legacyData = (await legacyList.json()) as { data: unknown[] };
  assert.equal(legacyData.data.length, 1);
  assert.equal(
    Object.hasOwn(legacyData.data[0] as object, "skillInvocation"),
    false,
  );
  const current = await client.listAutomations({ limit: 100 });
  assert.equal(current.data.length, 2);
  assert.equal(
    current.data.filter((item) => item.skillInvocation !== undefined).length,
    1,
  );
  assert.deepEqual(
    forwarded.map(({ version }) => version),
    ["1", "1", null, null, null, "1"],
  );
  assert.equal((await store.listPendingWorkItems(100)).length, 0);
});
