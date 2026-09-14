import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  ApplicationError,
  type DemonstratedSkillService,
  type SkillRecordingStore,
} from "@crewon/application";
import { SkillError } from "@crewon/domain";
import { ContractValidationError } from "@crewon/contracts";
import { registerDemonstratedSkillRoutes } from "./demonstrated-skill-routes.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const headers = {
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "http://localhost:3000",
  "x-csrf-token": "c".repeat(32),
};
const ref = {
  skillId: "skill-1",
  versionId: "v1",
  contentDigest: `sha256:${"a".repeat(64)}`,
};
const invocation = {
  schemaVersion: "crewon.skill-invocation.v1",
  skill: ref,
  parameters: { date: "2026-09-15" },
  requiredToolRefs: ["browser"],
};
const method = {
  name: "Report",
  purpose: "Make report",
  steps: ["Open report"],
  parameters: [],
  requiredToolRefs: [],
  completionCriteria: ["Report exists"],
  knownExceptions: ["Page unavailable"],
  runtimeRequirements: [],
};

function fixture(missing = false, recordings?: SkillRecordingStore) {
  const app = Fastify({ bodyLimit: 64 * 1024 });
  const calls: { name: string; args: unknown[] }[] = [];
  let wakeups = 0;
  let failure: Error | null = null;
  const results = new Map<string, unknown>();
  const methods = Object.fromEntries(
    [
      "importRecording",
      "list",
      "detail",
      "get",
      "edit",
      "seal",
      "startExecution",
      "reviewTrial",
      "activate",
      "setDisabled",
      "resolveVersion",
      "ensureRunSkillAllowed",
    ].map((name) => [
      name,
      async (...args: unknown[]) => {
        calls.push({ name, args });
        if (failure) throw failure;
        if (results.has(name)) return results.get(name);
        return name === "get"
          ? {
              tenantId: actor.tenantId,
              spaceId: actor.spaceId,
              ownerActorId: actor.actorId,
              skillId: ref.skillId,
              source: {
                recordingId: "recording-1",
                revision: 1,
                contentDigest: ref.contentDigest,
                provenance: "recording",
              },
            }
          : name === "resolveVersion"
            ? { ref, markdown: "# Report" }
            : name === "list"
              ? []
              : { ok: name };
      },
    ]),
  );
  registerDemonstratedSkillRoutes(app, {
    skills: missing ? null : (methods as unknown as DemonstratedSkillService),
    identity: new StandaloneIdentity({
      actor,
      sessionToken: "s".repeat(32),
      csrfToken: "c".repeat(32),
      allowedOrigins: [headers.origin],
    }),
    outboxWakeup: {
      async wake() {
        wakeups++;
        throw new Error("wake unavailable");
      },
    },
    recordings,
  });
  return {
    app,
    calls,
    wakeups: () => wakeups,
    fail(error: Error) {
      failure = error;
    },
    result(name: string, value: unknown) {
      results.set(name, value);
    },
  };
}

test("Skill HTTP routes delegate authenticated bounded inputs; only execution wakes the outbox", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const execution = {
    executionId: "execution-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    agentVersionId: null,
    purpose: "trial",
    invocation,
  };
  const review = {
    criteria: ["Report exists"],
    coverage: ["new-date"],
    resultNote: "Checked the report.",
  };
  const routes = [
    {
      method: "POST",
      url: "/api/v1/skills",
      payload: { recording: { contractFixture: true } },
      name: "importRecording",
      args: [
        actor,
        { contractFixture: true },
        [],
        { importId: undefined, provenance: undefined },
      ],
    },
    {
      method: "GET",
      url: "/api/v1/skills?after=skill-0&limit=12",
      name: "list",
      args: [actor, { after: "skill-0", limit: 12 }],
    },
    {
      method: "GET",
      url: "/api/v1/skills/skill-1",
      name: "detail",
      args: [actor, "skill-1"],
    },
    {
      method: "PATCH",
      url: "/api/v1/skills/skill-1",
      payload: { expectedRevision: 1, method },
      name: "edit",
      args: [actor, "skill-1", 1, method],
    },
    {
      method: "POST",
      url: "/api/v1/skills/skill-1/versions",
      payload: { expectedRevision: 1 },
      name: "seal",
      args: [actor, "skill-1", 1],
    },
    {
      method: "POST",
      url: "/api/v1/skills/skill-1/executions",
      payload: execution,
      name: "startExecution",
      args: [actor, "skill-1", execution],
    },
    {
      method: "POST",
      url: "/api/v1/skills/skill-1/executions/execution-1/review",
      payload: review,
      name: "reviewTrial",
      args: [actor, "skill-1", "execution-1", review],
    },
    {
      method: "POST",
      url: "/api/v1/skills/skill-1/activate",
      payload: { expectedRevision: 1, version: ref },
      name: "activate",
      args: [actor, "skill-1", 1, ref],
    },
    {
      method: "POST",
      url: "/api/v1/skills/skill-1/disable",
      payload: { expectedRevision: 2, disabled: true },
      name: "setDisabled",
      args: [actor, "skill-1", 2, true],
    },
    {
      method: "GET",
      url: `/api/v1/skills/skill-1/versions/v1?contentDigest=${encodeURIComponent(ref.contentDigest)}`,
      name: "resolveVersion",
      args: [actor, ref],
    },
  ] as const;
  for (const route of routes) {
    const result = await f.app.inject({
      method: route.method,
      url: route.url,
      headers,
      ...("payload" in route ? { payload: route.payload } : {}),
    });
    assert(result.statusCode >= 200 && result.statusCode < 300, result.body);
    assert.deepEqual(f.calls.at(-1), { name: route.name, args: route.args });
    if (route.name === "resolveVersion")
      assert.equal(result.json().markdown, "# Report");
    if (route.name === "list") assert.deepEqual(result.json(), { skills: [] });
  }
  assert.equal(f.wakeups(), 1);
});

test("Run Skill binding lookup returns only the admitted pinned identity and concrete parameters", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const url = "/api/v1/runs/run-1/skill-invocation";
  f.result("ensureRunSkillAllowed", {
    threadId: "thread-1",
    invocation,
    agentVersionId: "agent-1",
    context: "private rendered method",
    version: { markdown: "private version" },
  });
  const response = await f.app.inject({ method: "GET", url, headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    threadId: "thread-1",
    skillVersionRef: ref,
    parameters: { date: "2026-09-15" },
  });
  assert.deepEqual(f.calls.at(-1), {
    name: "ensureRunSkillAllowed",
    args: [actor, "run-1"],
  });
  assert(!response.body.includes("private"));
  f.result("ensureRunSkillAllowed", null);
  const unbound = await f.app.inject({ method: "GET", url, headers });
  assert.equal(unbound.statusCode, 200);
  assert.equal(unbound.json(), null);
  assert.equal(f.wakeups(), 0);
});

test("Run Skill binding lookup rechecks disabled/unknown runs and rejects caller-selected binding or scope", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const url = "/api/v1/runs/run-1/skill-invocation";
  f.result("ensureRunSkillAllowed", { threadId: "thread-1", invocation });
  assert.equal((await f.app.inject({ method: "GET", url })).statusCode, 401);
  for (const suffix of [
    "?skillId=other",
    "?versionId=latest",
    "?tenantId=other",
  ]) {
    assert.equal(
      (await f.app.inject({ method: "GET", url: `${url}${suffix}`, headers }))
        .statusCode,
      400,
    );
  }
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: "/api/v1/runs/%00/skill-invocation",
        headers,
      })
    ).statusCode,
    400,
  );
  assert.equal(f.calls.length, 0);
  for (const [category, code, expected] of [
    ["authorization", "skill_disabled", 403],
    ["notFound", "run_not_found", 404],
    ["authorization", "skill_run_binding_mismatch", 403],
  ] as const) {
    f.fail(new ApplicationError(category, code));
    const denied = await f.app.inject({ method: "GET", url, headers });
    assert.equal(denied.statusCode, expected);
    assert.equal(denied.json().error.code, code);
    assert.equal(f.calls.at(-1)?.name, "ensureRunSkillAllowed");
  }
  const absent = fixture(true);
  t.after(() => absent.app.close());
  assert.equal(
    (await absent.app.inject({ method: "GET", url, headers })).statusCode,
    503,
  );
});

test("Recording contract rejection keeps the existing validation error envelope", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  f.fail(new ContractValidationError("recording_digest_mismatch"));
  const response = await f.app.inject({
    method: "POST",
    url: "/api/v1/skills",
    headers,
    payload: { recording: {} },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.category, "validation");
  assert.equal(response.json().error.code, "recording_digest_mismatch");
});

test("Skill HTTP mutations enforce existing session/CSRF before service calls", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/skills",
        payload: { recording: {} },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/v1/skills",
        headers: { ...headers, "x-csrf-token": "wrong" },
        payload: { recording: {} },
      })
    ).statusCode,
    403,
  );
  assert.equal(f.calls.length, 0);
});

test("Skill HTTP rejects client verification, nested parameters, bad revisions and unknown fields", async (t) => {
  const f = fixture();
  t.after(() => f.app.close());
  const invalid = [
    { method: "GET", url: "/api/v1/skills?limit=0" },
    { method: "GET", url: "/api/v1/skills?limit=1.5" },
    { method: "GET", url: "/api/v1/skills?unknown=1" },
    {
      method: "GET",
      url: "/api/v1/skills/skill-1/versions/latest?contentDigest=x",
    },
    {
      method: "POST",
      url: "/api/v1/skills",
      payload: { recording: {}, tenantId: "other" },
    },
    {
      method: "PATCH",
      url: "/api/v1/skills/skill-1",
      payload: { expectedRevision: 1.5, method },
    },
    {
      method: "POST",
      url: "/api/v1/skills/skill-1/disable",
      payload: { expectedRevision: 1, disabled: "true" },
    },
    {
      method: "POST",
      url: "/api/v1/skills/skill-1/executions",
      payload: {
        executionId: "e",
        threadId: "t",
        expectedThreadRevision: 1,
        agentVersionId: null,
        purpose: "trial",
        invocation,
        verification: "real",
      },
    },
    {
      method: "POST",
      url: "/api/v1/skills/skill-1/executions",
      payload: {
        executionId: "e",
        threadId: "t",
        expectedThreadRevision: 1,
        agentVersionId: null,
        purpose: "trial",
        invocation: { ...invocation, parameters: { nested: {} } },
      },
    },
    {
      method: "POST",
      url: "/api/v1/skills/skill-1/executions/e/review",
      payload: {
        criteria: ["x"],
        coverage: ["new-date"],
        resultNote: "x",
        verification: "real",
      },
    },
    {
      method: "POST",
      url: "/api/v1/skills/skill-1/executions/e/review",
      payload: {
        criteria: ["x"],
        coverage: ["new-date"],
        resultNote: "x".repeat(2049),
      },
    },
  ] as const;
  for (const route of invalid) {
    const result = await f.app.inject({
      method: route.method,
      url: route.url,
      headers,
      ...("payload" in route ? { payload: route.payload } : {}),
    });
    assert.equal(result.statusCode, 400, `${route.url}: ${result.body}`);
    assert.equal(result.json().error.category, "validation");
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.wakeups(), 0);
});

test("Skill host absence is authenticated 503; typed errors keep safe envelopes", async (t) => {
  const absent = fixture(true);
  t.after(() => absent.app.close());
  assert.equal(
    (await absent.app.inject({ method: "GET", url: "/api/v1/skills" }))
      .statusCode,
    401,
  );
  const unavailable = await absent.app.inject({
    method: "GET",
    url: "/api/v1/skills",
    headers,
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().error.code, "skill_host_unavailable");
  const f = fixture();
  t.after(() => f.app.close());
  for (const [error, status] of [
    [new ApplicationError("conflict", "skill_revision_conflict"), 409],
    [new SkillError("skill_digest_mismatch"), 400],
    [new Error("secret"), 500],
  ] as const) {
    f.fail(error);
    const response = await f.app.inject({
      method: "GET",
      url: "/api/v1/skills",
      headers,
    });
    assert.equal(response.statusCode, status);
    assert(!response.body.includes("secret"));
  }
});

test("Skill evidence imports are bounded and read as scoped JSON only after Skill authorization", async (t) => {
  const evidence = {
    evidenceId: "evidence-1",
    mediaType: "image/svg+xml" as const,
    dataBase64: Buffer.from("<svg>contract fixture</svg>").toString("base64"),
  };
  const reads: {
    kind: string;
    scope: unknown;
    source: unknown;
    evidenceId?: string;
  }[] = [];
  const f = fixture(false, {
    async saveImportedRecording() {
      throw new Error("unexpected write");
    },
    async readImportedRecording(scope, source) {
      reads.push({ kind: "recording", scope, source });
      return null;
    },
    async readRecordingEvidence(scope, source, evidenceId) {
      reads.push({ kind: "evidence", scope, source, evidenceId });
      return evidence;
    },
  });
  t.after(() => f.app.close());
  const imported = await f.app.inject({
    method: "POST",
    url: "/api/v1/skills",
    headers,
    payload: { recording: { contractFixture: true }, evidence: [evidence] },
  });
  assert.equal(imported.statusCode, 200);
  assert.deepEqual(f.calls.at(-1)?.args, [
    actor,
    { contractFixture: true },
    [evidence],
    { importId: undefined, provenance: undefined },
  ]);
  const response = await f.app.inject({
    method: "GET",
    url: "/api/v1/skills/skill-1/evidence/evidence-1",
    headers,
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"]!, /^application\/json/u);
  assert.deepEqual(response.json(), { evidence });
  assert.deepEqual(reads[0], {
    kind: "evidence",
    scope: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      ownerActorId: actor.actorId,
    },
    source: {
      recordingId: "recording-1",
      revision: 1,
      contentDigest: ref.contentDigest,
      provenance: "recording",
    },
    evidenceId: "evidence-1",
  });
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: "/api/v1/skills/skill-1/recording",
        headers,
      })
    ).statusCode,
    404,
  );
  for (const uploaded of [
    [
      {
        ...evidence,
        dataBase64: Buffer.alloc(16 * 1024 + 1).toString("base64"),
      },
    ],
    [{ ...evidence, mediaType: "text/html" }],
    [{ ...evidence, dataBase64: "not base64!" }],
    [evidence, evidence],
  ]) {
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/v1/skills",
          headers,
          payload: { recording: {}, evidence: uploaded },
        })
      ).statusCode,
      400,
    );
  }
  f.fail(new ApplicationError("authorization", "skill_denied"));
  const count = reads.length;
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: "/api/v1/skills/skill-1/evidence/evidence-1",
        headers,
      })
    ).statusCode,
    403,
  );
  assert.equal(reads.length, count);
});
