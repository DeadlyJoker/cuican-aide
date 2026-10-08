import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSourceUploadPermission } from "@crewon/application";
import { ProductionProjectSourceUploadAuthorization } from "./production-project-source-upload-authorization.ts";

const actor = {
  tenantId: "policy-tenant",
  spaceId: "policy-space",
  principalId: "policy-owner",
  actorId: "policy-auditor",
};
function permission(
  action: ProjectSourceUploadPermission["action"] = "projectSourceUpload:adopt",
): ProjectSourceUploadPermission {
  return {
    actor,
    action,
    resource: {
      kind: "projectSourceUpload",
      owner: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        principalId: actor.principalId,
      },
      uploadId:
        action === "projectSourceUpload:begin" ? null : "original-upload",
      projectId:
        action === "projectSourceUpload:adopt" ? "original-project" : null,
    },
  };
}
const config = {
  url: "https://policy.example.test/decide",
  serviceToken: "s".repeat(32),
  timeoutMs: 1000,
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("dedicated upload PDP sends the exact original owner/action DTO over the existing configured authority endpoint", async () => {
  const seen: unknown[] = [];
  const policy = new ProductionProjectSourceUploadAuthorization({
    ...config,
    async fetch(url, init) {
      assert.equal(url, config.url);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.deepEqual(init.headers, {
        "accept": "application/json",
        "authorization": `Bearer ${config.serviceToken}`,
        "content-type": "application/json",
      });
      assert.ok(init.signal instanceof AbortSignal);
      seen.push(JSON.parse(String(init.body)));
      return json({ outcome: "allow" });
    },
  });
  for (const action of [
    "projectSourceUpload:begin",
    "projectSourceUpload:write",
    "projectSourceUpload:status",
    "projectSourceUpload:prepare",
    "projectSourceUpload:cancel",
    "projectSourceUpload:adopt",
  ] as const) {
    const original = permission(action);
    assert.deepEqual(await policy.authorize(original), { outcome: "allow" });
    assert.deepEqual(seen.at(-1), original);
    assert.equal((seen.at(-1) as ProjectSourceUploadPermission).action, action);
  }
  assert.equal(seen.length, 6);
  policy.close();
});

test("permission ownership and upload/project action ranges are checked before any policy IO", async () => {
  let calls = 0;
  const policy = new ProductionProjectSourceUploadAuthorization({
    ...config,
    async fetch() {
      calls++;
      return json({ outcome: "allow" });
    },
  });
  const input = permission();
  for (const malformed of [
    { ...input, actor: { ...actor, principalId: "foreign" } },
    {
      ...input,
      resource: {
        ...input.resource,
        owner: { ...input.resource.owner, tenantId: "foreign" },
      },
    },
    { ...input, action: "creativeProject:write" },
    {
      ...permission("projectSourceUpload:begin"),
      resource: { ...input.resource, projectId: null },
    },
    { ...permission("projectSourceUpload:write"), resource: input.resource },
    { ...input, authority: "forged" },
  ])
    await assert.rejects(
      policy.authorize(malformed as ProjectSourceUploadPermission),
    );
  assert.equal(calls, 0);
  policy.close();
});

test("independent PDP refusals stay refusals and every request rechecks policy without a cached project grant", async () => {
  let calls = 0;
  const policy = new ProductionProjectSourceUploadAuthorization({
    ...config,
    async fetch() {
      return json(
        ++calls === 1
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "upload_adoption_revoked" },
      );
    },
  });
  assert.deepEqual(await policy.authorize(permission()), { outcome: "allow" });
  assert.deepEqual(await policy.authorize(permission()), {
    outcome: "deny",
    reasonCode: "upload_adoption_revoked",
  });
  assert.equal(calls, 2);
  policy.close();
});

test("configured endpoint, secret and timeout bounds fail before opening a policy client", () => {
  for (const changed of [
    { url: "http://policy.example.test/decide" },
    { url: "https://user:pass@policy.example.test/decide" },
    { url: "https://policy.example.test/decide?grant=1" },
    { url: "https://policy.example.test/decide#grant" },
    { url: "invalid" },
    { serviceToken: "short" },
    { serviceToken: "s".repeat(8193) },
    { timeoutMs: 0 },
    { timeoutMs: 30_001 },
    { timeoutMs: Number.NaN },
  ])
    assert.throws(
      () =>
        new ProductionProjectSourceUploadAuthorization({
          ...config,
          ...changed,
        }),
      /production_project_source_upload_policy_configuration_invalid/u,
    );
});

test("unknown or widened decisions, malformed JSON and inaccessible policy responses fail closed", async () => {
  for (const response of [
    json({ outcome: "unknown" }),
    json({ outcome: "allow", reasonCode: "injected" }),
    json({ outcome: "allow", authority: true }),
    json({ outcome: "deny" }),
    json({ outcome: "deny", reasonCode: "Invalid reason" }),
    json({ outcome: "deny", reasonCode: "a".repeat(129) }),
    new Response("{broken", {
      headers: { "content-type": "application/json" },
    }),
    new Response(new Uint8Array([255]), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{}", {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
    new Response("{}", { headers: { "content-type": "text/plain" } }),
  ]) {
    const policy = new ProductionProjectSourceUploadAuthorization({
      ...config,
      async fetch() {
        return response;
      },
    });
    await assert.rejects(policy.authorize(permission()));
    policy.close();
  }
});

test("declared and streamed policy body limits cancel the original response and never interpret partial allow", async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `{"outcome":"allow","padding":"${"x".repeat(16 * 1024)}"}`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = {
      "content-type": "application/json",
      ...(declared ? { "content-length": String(16 * 1024 + 1) } : {}),
    };
    const policy = new ProductionProjectSourceUploadAuthorization({
      ...config,
      async fetch() {
        return new Response(stream, { headers });
      },
    });
    await assert.rejects(policy.authorize(permission()));
    assert.equal(cancelled, true);
    policy.close();
  }
});

test("host lifetime withdrawal is checked synchronously, aborts pending authority IO, and cannot return a late allow", async () => {
  const physical = deferred<Response>();
  let signal: AbortSignal | undefined;
  const policy = new ProductionProjectSourceUploadAuthorization({
    ...config,
    fetch(_url, init) {
      signal = init.signal as AbortSignal;
      return physical.promise;
    },
  });
  const pending = policy.authorize(permission());
  await turn();
  assert.equal(signal!.aborted, false);
  policy.close();
  assert.equal(signal!.aborted, true);
  await assert.rejects(
    pending,
    /production_project_source_upload_policy_unavailable/u,
  );
  assert.throws(
    () => policy.assertActive(permission()),
    /production_project_source_upload_policy_unavailable/u,
  );
  await assert.rejects(
    policy.authorize(permission()),
    /production_project_source_upload_policy_unavailable/u,
  );
  physical.resolve(json({ outcome: "allow" }));
  await turn();
});

test("bounded cancellation observes late physical rejection without retrying or yielding an allow", async () => {
  const physical = deferred<Response>();
  let calls = 0;
  const policy = new ProductionProjectSourceUploadAuthorization({
    ...config,
    timeoutMs: 10,
    fetch() {
      calls++;
      return physical.promise;
    },
  });
  await assert.rejects(
    policy.authorize(permission()),
    /production_project_source_upload_policy_unavailable/u,
  );
  physical.reject(new Error("late_policy_network_failure"));
  await turn();
  assert.equal(calls, 1);
  policy.close();
});
