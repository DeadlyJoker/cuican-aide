import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test, { type TestContext } from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import { context as toolContext } from "./plugin-tool-runtime-adapter.test-support.ts";
import {
  loadInstalledPluginWorkerConfig,
  parseInstalledPluginWorkerConfig,
  type InstalledPluginWorkerConfig,
} from "./plugins/installed-plugin-worker-config.ts";
import { createInstalledPluginWorkerAuthority } from "./plugins/installed-plugin-worker-authority.ts";

const token = "fixture-service-token-" + "x".repeat(32);
const scope = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  profileId: "profile-1",
};
const actor = {
  principalId: "principal-current",
  actorId: "actor-1",
  tenantId: scope.tenantId,
  spaceId: scope.spaceId,
};
const identity = {
  pluginId: "fixture.report",
  publisherId: "fixture-publisher",
  version: "1.0.0",
  packageDigest: "sha256:" + "a".repeat(64),
};
const environment = { FIXTURE_AUTHORITY_TOKEN: token };

function document() {
  const endpoint = (path: string) => ({
    url: `https://authority.example/${path}`,
    serviceTokenEnvironmentVariable: "FIXTURE_AUTHORITY_TOKEN",
  });
  return {
    schemaVersion: "crewon.installed-plugin-worker.v1",
    installRoot: "/private/installed",
    releaseDocumentPath: "/private/release.json",
    actorAuthority: endpoint("actor"),
    policyAuthority: endpoint("policy"),
    profileAuthority: endpoint("profile"),
    packageAuthority: endpoint("package"),
    networkAuthority: null,
    historicalScope: scope,
    timeoutMs: 1000,
  };
}
function config(timeoutMs = 1000): InstalledPluginWorkerConfig {
  return parseInstalledPluginWorkerConfig(
    { ...document(), timeoutMs },
    environment,
  );
}
function response(input: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(input), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}
function root(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-worker-authority-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("explicit configuration captures service credentials and redacts serialization and inspection", () => {
  const env = { ...environment },
    input = document();
  const captured = parseInstalledPluginWorkerConfig(input, env);
  env.FIXTURE_AUTHORITY_TOKEN = "changed";
  input.actorAuthority.url = "https://changed.example/";
  assert.equal(captured.actorAuthority.serviceToken, token);
  assert.equal(captured.actorAuthority.url, "https://authority.example/actor");
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.actorAuthority), true);
  assert.equal(JSON.stringify(captured).includes(token), false);
  assert.equal(inspect(captured).includes(token), false);
  assert.equal(JSON.stringify(captured).includes("[REDACTED]"), true);
  assert.throws(
    () => createInstalledPluginWorkerAuthority({ ...captured }),
    /configuration_invalid/u,
  );
});

for (const [name, change] of [
  [
    "unknown field",
    (value: Record<string, unknown>) => {
      value.defaultBalance = 100;
    },
  ],
  [
    "unknown schema",
    (value: Record<string, unknown>) => {
      value.schemaVersion = "future";
    },
  ],
  [
    "relative install root",
    (value: Record<string, unknown>) => {
      value.installRoot = "./plugins";
    },
  ],
  [
    "uncanonical path",
    (value: Record<string, unknown>) => {
      value.releaseDocumentPath = "/private/../release.json";
    },
  ],
  [
    "zero timeout",
    (value: Record<string, unknown>) => {
      value.timeoutMs = 0;
    },
  ],
  [
    "unbounded timeout",
    (value: Record<string, unknown>) => {
      value.timeoutMs = 30001;
    },
  ],
  [
    "HTTP authority",
    (value: Record<string, unknown>) => {
      value.actorAuthority = {
        ...document().actorAuthority,
        url: "http://authority.example/",
      };
    },
  ],
  [
    "URL credentials",
    (value: Record<string, unknown>) => {
      value.actorAuthority = {
        ...document().actorAuthority,
        url: "https://user:secret@authority.example/",
      };
    },
  ],
  [
    "URL query",
    (value: Record<string, unknown>) => {
      value.actorAuthority = {
        ...document().actorAuthority,
        url: "https://authority.example/?token=secret",
      };
    },
  ],
  [
    "inline token",
    (value: Record<string, unknown>) => {
      value.actorAuthority = {
        ...document().actorAuthority,
        serviceToken: token,
      };
    },
  ],
] as const) {
  test(`configuration rejects ${name}`, () => {
    const value: Record<string, unknown> = document();
    change(value);
    assert.throws(
      () => parseInstalledPluginWorkerConfig(value, environment),
      /configuration_invalid/u,
    );
  });
}

test("configuration never executes caller or environment getters", () => {
  let reads = 0;
  const input = document();
  Object.defineProperty(input, "actorAuthority", {
    enumerable: true,
    get: () => {
      reads++;
      return document().actorAuthority;
    },
  });
  assert.throws(
    () => parseInstalledPluginWorkerConfig(input, environment),
    /configuration_invalid/u,
  );
  const env = Object.defineProperty({}, "FIXTURE_AUTHORITY_TOKEN", {
    enumerable: true,
    get: () => {
      reads++;
      return token;
    },
  });
  assert.throws(
    () => parseInstalledPluginWorkerConfig(document(), env),
    /configuration_invalid/u,
  );
  assert.equal(reads, 0);
  for (const env of [
    {},
    { FIXTURE_AUTHORITY_TOKEN: "short" },
    { FIXTURE_AUTHORITY_TOKEN: token + "\n" },
  ])
    assert.throws(
      () => parseInstalledPluginWorkerConfig(document(), env),
      /configuration_invalid/u,
    );
});

test("operator file must be bounded private bytes, not a symlink, hardlink or malformed UTF-8", (t) => {
  const directory = root(t),
    path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(document()), { mode: 0o600 });
  assert.equal(
    loadInstalledPluginWorkerConfig(path, environment).installRoot,
    "/private/installed",
  );
  chmodSync(path, 0o644);
  assert.throws(
    () => loadInstalledPluginWorkerConfig(path, environment),
    /configuration_invalid/u,
  );
  chmodSync(path, 0o600);
  const symbolic = join(directory, "symlink.json");
  symlinkSync(path, symbolic);
  assert.throws(
    () => loadInstalledPluginWorkerConfig(symbolic, environment),
    /configuration_invalid/u,
  );
  const hard = join(directory, "hard.json");
  linkSync(path, hard);
  assert.throws(
    () => loadInstalledPluginWorkerConfig(path, environment),
    /configuration_invalid/u,
  );
  rmSync(hard);
  writeFileSync(path, Buffer.from([0xff, 0xfe]));
  assert.throws(
    () => loadInstalledPluginWorkerConfig(path, environment),
    /configuration_invalid/u,
  );
  writeFileSync(path, "x".repeat(128 * 1024 + 1));
  assert.throws(
    () => loadInstalledPluginWorkerConfig(path, environment),
    /configuration_invalid/u,
  );
});

test("current actor lookup uses the saved owner and rejects foreign or extra identity fields", async () => {
  const requests: unknown[] = [];
  let answer: unknown = actor;
  const owner = createInstalledPluginWorkerAuthority(
    config(),
    async (url, init) => {
      assert.equal(url, "https://authority.example/actor");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${token}`,
      );
      assert.equal(init?.redirect, "error");
      requests.push(JSON.parse(String(init?.body)));
      return response(answer);
    },
  );
  const lookup = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    actorId: actor.actorId,
  };
  try {
    assert.deepEqual(
      await owner.installedPluginExecution.resolveActor(
        lookup,
        new AbortController().signal,
      ),
      actor,
    );
    assert.deepEqual(requests[0], {
      schemaVersion: "crewon.plugin-execution-actor.v1",
      owner: lookup,
    });
    answer = { ...actor, actorId: "foreign" };
    await assert.rejects(
      owner.installedPluginExecution.resolveActor(
        lookup,
        new AbortController().signal,
      ),
      /identity_mismatch/u,
    );
    answer = { ...actor, defaultPermission: "allow" };
    await assert.rejects(
      owner.installedPluginExecution.resolveActor(
        lookup,
        new AbortController().signal,
      ),
    );
    answer = null;
    assert.equal(
      await owner.installedPluginExecution.resolveActor(
        lookup,
        new AbortController().signal,
      ),
      null,
    );
  } finally {
    await owner.close();
  }
});

test("package approval is fresh, exact publisher/version/digest/profile data without fabricated actor", async () => {
  const requests: unknown[] = [];
  let allowed = true;
  const owner = createInstalledPluginWorkerAuthority(
    config(),
    async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return response({ outcome: allowed ? "allow" : "deny" });
    },
  );
  try {
    const input = { identity, scope, purpose: "read" as const };
    assert.equal(
      await owner.authorizeRead(input, new AbortController().signal),
      "allow",
    );
    allowed = false;
    assert.equal(
      await owner.authorizeRead(input, new AbortController().signal),
      "deny",
    );
    assert.deepEqual(
      requests,
      [0, 1].map(() => ({
        schemaVersion: "crewon.plugin-execution-package.v1",
        ...input,
      })),
    );
    let reads = 0;
    const getter = Object.defineProperty(
      { scope, purpose: "read" },
      "identity",
      {
        enumerable: true,
        get: () => {
          reads++;
          return identity;
        },
      },
    );
    await assert.rejects(
      owner.authorizeRead(getter as typeof input, new AbortController().signal),
    );
    assert.equal(reads, 0);
    assert.equal(requests.length, 2);
  } finally {
    await owner.close();
  }
});

test("legacy policy wire preserves current actor and scope while a deny is fail closed", async () => {
  let payload: unknown,
    allowed = true;
  const owner = createInstalledPluginWorkerAuthority(
    config(),
    async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return response({ outcome: allowed ? "allow" : "deny" });
    },
  );
  const input = {
    actor,
    action: "run:execute" as const,
    resource: {
      kind: "run" as const,
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      threadId: "thread-1",
      runId: "run-1",
    },
  };
  try {
    assert.deepEqual(
      await owner.installedPluginExecution.authorization.authorize(input),
      { outcome: "allow" },
    );
    assert.deepEqual(payload, input);
    allowed = false;
    assert.deepEqual(
      await owner.installedPluginExecution.authorization.authorize(input),
      { outcome: "deny", reasonCode: "installed_plugin_execution_denied" },
    );
    await assert.rejects(
      owner.installedPluginExecution.authorization.authorize({
        ...input,
        resource: { ...input.resource, tenantId: "foreign" },
      }),
      /scope_mismatch/u,
    );
  } finally {
    await owner.close();
  }
});

test("historical profile is supplied by current authority and checked against current actor", async () => {
  let foreign = false;
  const owner = createInstalledPluginWorkerAuthority(
    config(),
    async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { actor });
      return response({ ...scope, ...(foreign ? { spaceId: "foreign" } : {}) });
    },
  );
  try {
    const query = owner.installedPluginExecution.historicalQuery;
    assert.ok(query);
    assert.deepEqual(
      await query.resolveProfile(actor, new AbortController().signal),
      scope,
    );
    foreign = true;
    await assert.rejects(
      query.resolveProfile(actor, new AbortController().signal),
      /scope_mismatch/u,
    );
  } finally {
    await owner.close();
  }
});

for (const [name, makeResponse] of [
  ["HTTP error", () => response({ outcome: "allow" }, { status: 503 })],
  [
    "wrong media",
    () =>
      response(
        { outcome: "allow" },
        { headers: { "content-type": "text/plain" } },
      ),
  ],
  [
    "declared oversized response",
    () =>
      response(
        { outcome: "allow" },
        {
          headers: {
            "content-type": "application/json",
            "content-length": "20000",
          },
        },
      ),
  ],
  [
    "streamed oversized response",
    () => response({ outcome: "allow", extra: "x".repeat(20000) }),
  ],
  [
    "extra approval field",
    () => response({ outcome: "allow", principalId: "invented" }),
  ],
  [
    "malformed JSON",
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
  ],
  [
    "invalid UTF-8",
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
  ],
] as const) {
  test(`authority rejects ${name}`, async () => {
    const owner = createInstalledPluginWorkerAuthority(config(), async () =>
      makeResponse(),
    );
    try {
      await assert.rejects(
        owner.authorizeRead(
          { identity, scope, purpose: "read" },
          new AbortController().signal,
        ),
      );
    } finally {
      await owner.close();
    }
  });
}

test("timeout does not free physical capacity; close withdraws synchronously and joins late operations", async () => {
  const completions: ((response: Response) => void)[] = [];
  const owner = createInstalledPluginWorkerAuthority(
    config(5),
    async () =>
      new Promise<Response>((resolve) => {
        completions.push(resolve);
      }),
  );
  const input = { identity, scope, purpose: "read" as const };
  const pending = Array.from({ length: 128 }, () =>
    owner.authorizeRead(input, new AbortController().signal),
  );
  const observed = Promise.allSettled(pending);
  const results = await observed;
  assert.equal(
    results.every((result) => result.status === "rejected"),
    true,
  );
  assert.equal(completions.length, 128);
  await assert.rejects(
    owner.authorizeRead(input, new AbortController().signal),
    /authority_busy/u,
  );
  let drained = false;
  const close = owner.close().then(() => {
    drained = true;
  });
  await assert.rejects(
    owner.authorizeRead(input, new AbortController().signal),
    /authority_closed/u,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  for (const complete of completions) complete(response({ outcome: "allow" }));
  await close;
  assert.equal(drained, true);
});

test("caller abort denies immediately and owner still joins an ignoring transport", async () => {
  let complete!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const owner = createInstalledPluginWorkerAuthority(config(), async () => {
    entered();
    return new Promise<Response>((resolve) => {
      complete = resolve;
    });
  });
  const controller = new AbortController();
  const pending = owner.authorizeRead(
    { identity, scope, purpose: "read" },
    controller.signal,
  );
  await started;
  controller.abort();
  await assert.rejects(pending, /authority_unavailable/u);
  let drained = false;
  const close = owner.close().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  complete(response({ outcome: "allow" }));
  await close;
  await assert.rejects(
    owner.authorizeRead(
      { identity, scope, purpose: "read" },
      controller.signal,
    ),
    /authority_closed/u,
  );
});

test("reentrant transport withdrawal still joins its actual in-flight operation", async () => {
  let complete!: (response: Response) => void;
  let closing!: Promise<void>;
  let drained = false;
  const owner = createInstalledPluginWorkerAuthority(config(), async () => {
    closing = owner.close().then(() => {
      drained = true;
    });
    return new Promise<Response>((resolve) => {
      complete = resolve;
    });
  });
  const pending = owner.authorizeRead(
    { identity, scope, purpose: "read" },
    new AbortController().signal,
  );
  await assert.rejects(pending, /authority_unavailable/u);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  complete(response({ outcome: "allow" }));
  await closing;
  assert.equal(drained, true);
});

test("network authority keeps metadata preflight separate from Run context and never caches an approval", async () => {
  const input = document();
  const requests: unknown[] = [];
  const networkAuthority = {
    ...input.actorAuthority,
    url: "https://authority.example/network",
  };
  const configured = parseInstalledPluginWorkerConfig(
    { ...input, networkAuthority },
    environment,
  );
  const context = toolContext();
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: context.scope.tenantId,
      spaceId: context.scope.spaceId,
      pluginId: context.identity.pluginId,
      revision: 1,
      pluginVersion: context.identity.version,
      manifestDigest: identity.packageDigest,
      implementationDigest: identity.packageDigest,
      parameters: { baseUrl: "https://supplier.example/" },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: "2026-10-03T09:00:00.000Z",
    },
    {
      sha256: (text) =>
        "sha256:" + createHash("sha256").update(text).digest("hex"),
    },
  );
  const metadata = {
    identity: { ...context.identity, publisherId: identity.publisherId },
    scope: context.scope,
    configuration,
    target: context.target,
    purpose: "submit" as const,
  };
  let answer: unknown = {
    baseUrlParameter: "baseUrl",
    paths: [
      { method: "POST", path: "/prompt" },
      { method: "GET", operationPathPrefix: "/history/" },
    ],
  };
  const owner = createInstalledPluginWorkerAuthority(
    configured,
    async (url, init) => {
      assert.equal(url, "https://authority.example/network");
      requests.push(JSON.parse(String(init?.body)));
      return response(answer);
    },
  );
  try {
    const io = owner.installedPluginExecution.executionIo;
    assert.ok(io?.resolveReadinessNetwork);
    assert.deepEqual(
      await io.resolveReadinessNetwork(metadata, new AbortController().signal),
      answer,
    );
    assert.deepEqual(requests[0], {
      schemaVersion: "crewon.plugin-execution-network.v1",
      kind: "readiness",
      metadata,
    });
    assert.equal(
      Object.hasOwn((requests[0] as { metadata: object }).metadata, "run"),
      false,
    );
    assert.deepEqual(
      await io.resolveNetwork(context, new AbortController().signal),
      answer,
    );
    assert.deepEqual(requests[1], {
      schemaVersion: "crewon.plugin-execution-network.v1",
      kind: "run",
      context,
    });
    answer = null;
    assert.equal(
      await io.resolveNetwork(context, new AbortController().signal),
      null,
    );
    answer = {
      baseUrlParameter: "baseUrl",
      paths: [{ method: "DELETE", path: "/prompt" }],
    };
    await assert.rejects(
      io.resolveNetwork(context, new AbortController().signal),
    );
    const beforeInvalid = requests.length;
    await assert.rejects(
      io.resolveReadinessNetwork(
        { ...metadata, scope: { ...scope, tenantId: "foreign" } },
        new AbortController().signal,
      ),
      /scope_mismatch/u,
    );
    assert.equal(requests.length, beforeInvalid);
    const withoutNetwork = createInstalledPluginWorkerAuthority(config());
    assert.equal(
      withoutNetwork.installedPluginExecution.executionIo,
      undefined,
    );
    await withoutNetwork.close();
  } finally {
    await owner.close();
  }
});

test("legacy policy deny reason remains compatible without accepting installation epoch grants", async () => {
  let answer: unknown = {
    outcome: "deny",
    reasonCode: "current_policy_revoked",
  };
  const owner = createInstalledPluginWorkerAuthority(config(), async () =>
    response(answer),
  );
  const input = {
    actor,
    action: "extension:read" as const,
    resource: {
      kind: "extension" as const,
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId: identity.pluginId,
    },
  };
  try {
    assert.deepEqual(
      await owner.installedPluginExecution.authorization.authorize(input),
      answer,
    );
    answer = { outcome: "allow", authorityEpoch: "not-execution-permission" };
    await assert.rejects(
      owner.installedPluginExecution.authorization.authorize(input),
    );
  } finally {
    await owner.close();
  }
});

test("remote business services require an explicit captured endpoint and live exact service admission; no implicit grant or alternate store", async () => {
  const absent = createInstalledPluginWorkerAuthority(config(), async () => {
    throw new Error("unexpected");
  });
  assert.equal(
    absent.installedPluginExecution.projectFoundationTools,
    undefined,
  );
  await absent.close();
  const raw = {
    ...document(),
    projectServiceAuthority: {
      url: "https://authority.example/projects",
      serviceTokenEnvironmentVariable: "FIXTURE_AUTHORITY_TOKEN",
    },
  };
  const captured = parseInstalledPluginWorkerConfig(raw, environment);
  assert.ok(!JSON.stringify(captured).includes(token));
  assert.ok(!inspect(captured).includes(token));
  for (const endpoint of [
    null,
    {
      ...raw.projectServiceAuthority,
      url: "http://authority.example/projects",
    },
    { ...raw.projectServiceAuthority, allowAll: true },
  ])
    assert.throws(() =>
      parseInstalledPluginWorkerConfig(
        { ...raw, projectServiceAuthority: endpoint },
        environment,
      ),
    );
  let allow = true;
  const calls: unknown[] = [];
  const authority = createInstalledPluginWorkerAuthority(
    captured,
    async (_url, options) => {
      calls.push(JSON.parse(options!.body as string));
      return response({ outcome: allow ? "allow" : "deny" });
    },
  );
  const project = authority.installedPluginExecution.projectTools!;
  const permission = {
    actor,
    action: "creativeProject:write" as const,
    resource: {
      kind: "creativeProject" as const,
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      projectId: "project",
    },
  };
  assert.equal(
    (await project.authorization.authorize(permission)).outcome,
    "allow",
  );
  assert.deepEqual(calls[0], {
    schemaVersion: "crewon.plugin-project-service-policy.v1",
    kind: "permission",
    permission,
  });
  allow = false;
  assert.equal(
    (await project.authorization.authorize(permission)).outcome,
    "deny",
  );
  const before = calls.length;
  await assert.rejects(
    project.authorization.authorize({
      ...permission,
      resource: { ...permission.resource, spaceId: "foreign" },
    }),
  );
  assert.equal(calls.length, before);
  await assert.rejects(
    authority.installedPluginExecution.projectFoundationTools!.authorizeService(
      {} as never,
      new AbortController().signal,
    ),
  );
  assert.equal(calls.length, before);
  assert.throws(
    () =>
      authority.installedPluginExecution.projectFoundationTools!.createFoundations(
        { store: {} } as never,
      ),
    /remote_project_service_denied/,
  );
  await authority.close();
});
