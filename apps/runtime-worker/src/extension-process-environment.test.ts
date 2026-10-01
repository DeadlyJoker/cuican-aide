import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { resolveRuntimeExtensionEnvironment } from "./extensions/extension-process-environment.ts";

const token = "extension-process-token-at-least-32-bytes";
const environment = {
  CREWON_EXTENSIONS_ENABLED: "1",
  CREWON_EXTENSION_HOST_PORT: "0",
  CREWON_EXTENSION_HOST_TOKEN: token,
  CREWON_PRINCIPAL_ID: "principal-1",
  CREWON_ACTOR_ID: "actor-1",
  CREWON_TENANT_ID: "tenant-1",
  CREWON_SPACE_ID: "space-1",
};

test("extension opt-in preserves the disabled default and validates declared configuration", () => {
  for (const mode of ["standalone", "production"] as const) {
    assert.equal(resolveRuntimeExtensionEnvironment({}, mode), undefined);
    assert.equal(
      resolveRuntimeExtensionEnvironment(
        { CREWON_EXTENSIONS_ENABLED: "0" },
        mode,
      ),
      undefined,
    );
  }
  assert.equal(
    resolveRuntimeExtensionEnvironment(
      { ...environment, CREWON_EXTENSIONS_ENABLED: "0" },
      "standalone",
    ),
    undefined,
  );
  assert.equal(
    resolveRuntimeExtensionEnvironment(
      {
        CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: "/bindings",
        CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: "/assets",
      },
      "standalone",
    ),
    undefined,
  );
  for (const value of ["", "true", " 1", "1 "]) {
    assert.throws(() =>
      resolveRuntimeExtensionEnvironment(
        { CREWON_EXTENSIONS_ENABLED: value },
        "standalone",
      ),
    );
  }
  for (const input of [
    { CREWON_EXTENSION_HOST_TOKEN: token },
    { CREWON_EXTENSION_HOST_PORT: "0" },
    { CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: "/bindings" },
    {
      ...environment,
      CREWON_EXTENSIONS_ENABLED: "0",
      CREWON_EXTENSION_HOST_DEADLINE_MS: "999",
    },
    {
      ...environment,
      CREWON_EXTENSIONS_ENABLED: "0",
      CREWON_EXTENSION_HOST_TOKEN: "short",
    },
  ])
    assert.throws(() =>
      resolveRuntimeExtensionEnvironment(input, "standalone"),
    );
});

test("production rejects every ambient extension authority before allocating resources", () => {
  for (const input of [
    { CREWON_EXTENSIONS_ENABLED: "1" },
    { CREWON_EXTENSION_HOST_PORT: "0" },
    { CREWON_EXTENSION_HOST_TOKEN: token },
    { CREWON_EXTENSION_HOST_DEADLINE_MS: "1000" },
    { CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: "/bindings" },
    { CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: "/assets" },
    { CREWON_EXTENSION_EXECUTION_MODE: "current" },
  ])
    assert.throws(
      () => resolveRuntimeExtensionEnvironment(input, "production"),
      /CREWON_EXTENSION_CONFIGURATION_forbidden/u,
    );
});

test("enabled host requires four explicit owner fields and strict private peer values", () => {
  for (const key of [
    "CREWON_PRINCIPAL_ID",
    "CREWON_ACTOR_ID",
    "CREWON_TENANT_ID",
    "CREWON_SPACE_ID",
    "CREWON_EXTENSION_HOST_PORT",
    "CREWON_EXTENSION_HOST_TOKEN",
  ] as const) {
    assert.throws(() =>
      resolveRuntimeExtensionEnvironment(
        { ...environment, [key]: undefined },
        "standalone",
      ),
    );
  }
  for (const port of ["-1", "65536", "01", "1.5", " 1"]) {
    assert.throws(() =>
      resolveRuntimeExtensionEnvironment(
        { ...environment, CREWON_EXTENSION_HOST_PORT: port },
        "standalone",
      ),
    );
  }
  for (const deadline of ["0", "999", "30001", "1e3"]) {
    assert.throws(() =>
      resolveRuntimeExtensionEnvironment(
        { ...environment, CREWON_EXTENSION_HOST_DEADLINE_MS: deadline },
        "standalone",
      ),
    );
  }
  for (const secret of ["short", `${token} `, `${token}\n`, "x".repeat(8193)]) {
    assert.throws(() =>
      resolveRuntimeExtensionEnvironment(
        { ...environment, CREWON_EXTENSION_HOST_TOKEN: secret },
        "standalone",
      ),
    );
  }
  const parsed = resolveRuntimeExtensionEnvironment(
    {
      ...environment,
      CREWON_EXTENSION_HOST_DEADLINE_MS: "30000",
      CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: "/bindings",
      CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: "/assets",
    },
    "standalone",
  );
  assert.ok(parsed);
  assert.equal(parsed.host.port, 0);
  assert.equal(parsed.host.deadlineMs, 30000);
  assert.equal(parsed.runtimeBindingsPath, "/bindings");
  assert.equal(parsed.agentVersionAssetsPath, "/assets");
  assert.equal(parsed.executionMode, "current");
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.host), true);
  assert.equal(inspect(parsed).includes(token), false);
  assert.equal(inspect(parsed.host).includes(token), false);
});

test("historical Worker mode requires opt-in and a complete published runtime", () => {
  const published = {
    ...environment,
    CREWON_EXTENSION_EXECUTION_MODE: "historical",
    CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: "/bindings",
    CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: "/assets",
  };
  assert.equal(
    resolveRuntimeExtensionEnvironment(published, "standalone")?.executionMode,
    "historical",
  );
  for (const input of [
    { CREWON_EXTENSION_EXECUTION_MODE: "current" },
    { ...published, CREWON_EXTENSIONS_ENABLED: "0" },
    { ...environment, CREWON_EXTENSION_EXECUTION_MODE: "historical" },
    { ...published, CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: undefined },
    { ...published, CREWON_EXTENSION_EXECUTION_MODE: " historical" },
    { ...published, CREWON_EXTENSION_EXECUTION_MODE: "other" },
  ])
    assert.throws(() =>
      resolveRuntimeExtensionEnvironment(input, "standalone"),
    );
});

test("standalone authority verifies current full identity and resource scope on every action", async () => {
  const parsed = resolveRuntimeExtensionEnvironment(environment, "standalone");
  assert.ok(parsed);
  const signal = new AbortController().signal;
  const owner = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    actorId: "actor-1",
  };
  assert.deepEqual(await parsed.host.resolveActor(owner, signal), parsed.actor);
  assert.equal(
    await parsed.host.resolveActor({ ...owner, actorId: "other" }, signal),
    null,
  );
  const request = {
    actor: parsed.actor,
    action: "extension:run" as const,
    resource: {
      kind: "extension" as const,
      tenantId: owner.tenantId,
      spaceId: owner.spaceId,
      pluginId: "crewon.comfyui-krea2",
    },
  };
  assert.deepEqual(await parsed.host.authorization.authorize(request), {
    outcome: "allow",
  });
  for (const altered of [
    { ...request, actor: { ...parsed.actor, principalId: "forged" } },
    { ...request, resource: { ...request.resource, spaceId: "foreign" } },
    { ...request, action: "agentVersion:publish" as const },
    {
      ...request,
      resource: {
        kind: "run" as const,
        tenantId: owner.tenantId,
        spaceId: owner.spaceId,
        threadId: "thread-1",
        runId: null,
      },
    },
  ])
    assert.equal(
      (await parsed.host.authorization.authorize(altered)).outcome,
      "deny",
    );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(parsed.host.resolveActor(owner, aborted.signal));
});
