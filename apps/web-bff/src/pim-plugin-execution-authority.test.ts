import assert from "node:assert/strict";
import test from "node:test";
import {
  createPimPluginExecutionAuthority,
  readPimPluginExecutionGrants,
} from "./pim-plugin-execution-authority.ts";
import { createPimAuthorityHttp } from "./pim-authority-http.ts";
import type { PimControlSessions } from "./pim-control-sessions.ts";
const actor = {
    tenantId: "tenant",
    spaceId: "space",
    principalId: "person",
    actorId: "actor",
  },
  scope = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "profile",
  };
const identity = {
  pluginId: "crewon.short-drama",
  publisherId: "crewon",
  version: "50.2.0",
  packageDigest: `sha256:${"a".repeat(64)}`,
};
const grant = {
  scope,
  identity,
  services: [
    "project-tools",
    "foundation-tools",
    "outline-tools",
    "asset-tools",
  ],
  unmetered: { authorityId: "explicit-acceptance-policy", policyRevision: 1 },
};
const pin = {
  ...actor,
  ...scope,
  ...identity,
  selectionRevision: 1,
  contributionId: "workbench",
  action: "project.execute",
  authorityEpoch: "current_epoch",
};
const admission = {
  schemaVersion: "crewon.plugin-task-admission.v1",
  ...pin,
  runId: "run",
  threadId: "thread",
  extensionBindingDigest: identity.packageDigest,
  requestDigest: identity.packageDigest,
  idempotencyKey: "original-command",
};
function fixture() {
  let allowed = true,
    epoch = pin.authorityEpoch,
    checks = 0;
  const sessions = {
    executionActor: async () => actor,
    executionProfile: async () => ({ actor }),
    pluginPolicy: async () => {
      checks++;
      return { outcome: allowed ? "allow" : "deny", authorityEpoch: epoch };
    },
    controlPolicy: async () => ({ outcome: allowed ? "allow" : "deny" }),
  } as unknown as PimControlSessions;
  const execution = createPimPluginExecutionAuthority(
    sessions,
    readPimPluginExecutionGrants(JSON.stringify([grant])),
  );
  return {
    sessions,
    execution,
    get checks() {
      return checks;
    },
    deny() {
      allowed = false;
    },
    changeEpoch() {
      epoch = "changed_epoch";
    },
  };
}
const signal = () => new AbortController().signal;
test("explicit execution grant checks immutable package, live profile/role and exact policy epoch for every service and free-task approval", async () => {
  const f = fixture();
  const request = {
    schemaVersion: "crewon.plugin-execution-package.v1",
    identity,
    scope,
    purpose: "submit",
  };
  assert.deepEqual(
    await f.execution.handle("execution-package", request, signal()),
    { outcome: "allow" },
  );
  for (const service of grant.services)
    assert.deepEqual(
      await f.execution.handle(
        "project-service-policy",
        {
          schemaVersion: "crewon.plugin-project-service-policy.v1",
          kind: "service",
          service,
          admission,
        },
        signal(),
      ),
      { outcome: "allow" },
    );
  assert.deepEqual(
    await f.execution.handle(
      "task-unmetered-policy",
      { schemaVersion: "crewon.plugin-task-unmetered-policy.v1", actor, pin },
      signal(),
    ),
    { outcome: "allow", authorization: grant.unmetered },
  );
  const before = f.checks;
  assert.deepEqual(
    await f.execution.handle(
      "execution-package",
      { ...request, identity: { ...identity, version: "other" } },
      signal(),
    ),
    { outcome: "deny" },
  );
  assert.equal(f.checks, before);
  assert.deepEqual(
    await f.execution.handle(
      "task-unmetered-policy",
      {
        schemaVersion: "crewon.plugin-task-unmetered-policy.v1",
        actor: { ...actor, principalId: "foreign" },
        pin,
      },
      signal(),
    ),
    { outcome: "deny", authorization: null },
  );
  f.changeEpoch();
  assert.deepEqual(
    await f.execution.handle(
      "project-service-policy",
      {
        schemaVersion: "crewon.plugin-project-service-policy.v1",
        kind: "service",
        service: "foundation-tools",
        admission,
      },
      signal(),
    ),
    { outcome: "deny" },
  );
  f.deny();
  assert.deepEqual(
    await f.execution.handle("execution-package", request, signal()),
    { outcome: "deny" },
  );
});
test("private HTTP authenticates before execution and old deployments expose no execution authority", async () => {
  const f = fixture();
  const http = (enabled: boolean) =>
    createPimAuthorityHttp({
      sessions: f.sessions,
      identityServiceToken: "i".repeat(32),
      policyServiceToken: "p".repeat(32),
      ...(enabled ? { execution: f.execution } : {}),
    });
  const req = (token: string, body: unknown) =>
    new Request("https://authority.test/internal/crewon/pim/execution-actor", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const body = {
    schemaVersion: "crewon.plugin-execution-actor.v1",
    owner: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      actorId: actor.actorId,
    },
  };
  assert.equal(
    (await http(true).handle(req("i".repeat(32), body)))!.status,
    401,
  );
  assert.equal(
    (await http(false).handle(req("p".repeat(32), body)))!.status,
    403,
  );
  const result = (await http(true).handle(req("p".repeat(32), body)))!;
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), actor);
  assert.equal(
    (await http(true).handle(
      req("p".repeat(32), { ...body, principalId: "forged" }),
    ))!.status,
    400,
  );
});
test("missing, duplicate or malformed approvals cannot silently enable additional services or unmetered usage", async () => {
  for (const value of [
    [grant, grant],
    [{ ...grant, services: ["all"] }],
    [{ ...grant, unmetered: { ...grant.unmetered, quotedCredits: "0" } }],
    [{ ...grant, identity: { ...identity, allowAnyVersion: true } }],
  ])
    assert.throws(
      () => readPimPluginExecutionGrants(JSON.stringify(value)),
      /grants_invalid/,
    );
  const f = fixture(),
    closed = createPimPluginExecutionAuthority(
      f.sessions,
      readPimPluginExecutionGrants("[]"),
    );
  assert.deepEqual(
    await closed.handle(
      "task-unmetered-policy",
      { schemaVersion: "crewon.plugin-task-unmetered-policy.v1", actor, pin },
      signal(),
    ),
    { outcome: "deny", authorization: null },
  );
  await assert.rejects(
    f.execution.handle(
      "project-service-policy",
      {
        schemaVersion: "crewon.plugin-project-service-policy.v1",
        kind: "service",
        service: "foundation-tools",
        admission: { ...admission, actorId: "injected", extra: true },
      },
      signal(),
    ),
  );
});
