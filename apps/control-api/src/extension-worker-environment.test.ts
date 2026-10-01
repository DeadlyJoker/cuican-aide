import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import test from "node:test";
import { resolveControlExtensionWorkerEnvironment } from "./extension-worker-environment.ts";

const token = "extension-control-worker-token-with-32-bytes-minimum";
const peer = {
  CREWON_EXTENSION_HOST_ORIGIN: "http://127.0.0.1:43125",
  CREWON_EXTENSION_HOST_TOKEN: token,
};
const owner = {
  CREWON_PRINCIPAL_ID: "principal-1",
  CREWON_ACTOR_ID: "actor-1",
  CREWON_TENANT_ID: "tenant-1",
  CREWON_SPACE_ID: "space-1",
};
const configured = { CREWON_EXTENSIONS_ENABLED: "1", ...owner, ...peer };

test("Control requires explicit opt-in and returns an immutable distinct principal/actor owner", () => {
  assert.equal(
    resolveControlExtensionWorkerEnvironment({}, "standalone"),
    undefined,
  );
  assert.equal(
    resolveControlExtensionWorkerEnvironment(
      { CREWON_EXTENSIONS_ENABLED: "0" },
      "standalone",
    ),
    undefined,
  );
  const environment = {
    ...configured,
    CREWON_EXTENSION_HOST_DEADLINE_MS: "30000",
  };
  const parsed = resolveControlExtensionWorkerEnvironment(
    environment,
    "standalone",
  );
  assert.deepEqual(parsed, {
    actor: {
      principalId: owner.CREWON_PRINCIPAL_ID,
      actorId: owner.CREWON_ACTOR_ID,
      tenantId: owner.CREWON_TENANT_ID,
      spaceId: owner.CREWON_SPACE_ID,
    },
    extensionWorker: {
      origin: peer.CREWON_EXTENSION_HOST_ORIGIN,
      token,
      deadlineMs: 30000,
    },
  });
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed!.actor));
  assert.ok(Object.isFrozen(parsed!.extensionWorker));
  environment.CREWON_PRINCIPAL_ID = "changed-principal";
  environment.CREWON_TENANT_ID = "changed-tenant";
  assert.equal(parsed!.actor.principalId, "principal-1");
  assert.equal(parsed!.actor.tenantId, "tenant-1");
  assert.equal(inspect(parsed).includes(token), false);
  assert.equal(inspect(parsed!.extensionWorker).includes(token), false);
});

test("disabled complete peer configuration is strictly validated without constructing a client or dispatching", (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    throw new Error("unexpected network call");
  });
  for (const enabled of [undefined, "0"])
    assert.equal(
      resolveControlExtensionWorkerEnvironment(
        {
          ...peer,
          ...(enabled === undefined
            ? {}
            : { CREWON_EXTENSIONS_ENABLED: enabled }),
        },
        "standalone",
      ),
      undefined,
    );
  assert.ok(resolveControlExtensionWorkerEnvironment(configured, "standalone"));
  assert.equal(calls, 0);
  for (const patch of [
    { CREWON_EXTENSION_HOST_ORIGIN: "http://localhost:43125" },
    { CREWON_EXTENSION_HOST_TOKEN: "short" },
    { CREWON_EXTENSION_HOST_DEADLINE_MS: "30001" },
  ])
    assert.throws(() =>
      resolveControlExtensionWorkerEnvironment(
        { ...peer, ...patch },
        "standalone",
      ),
    );
});

test("rejects unknown switches and incomplete peer settings even while disabled", () => {
  for (const enabled of [
    "",
    "true",
    "false",
    "yes",
    "on",
    "2",
    "01",
    " 1",
    "1 ",
    "\n0",
  ])
    assert.throws(
      () =>
        resolveControlExtensionWorkerEnvironment(
          { ...configured, CREWON_EXTENSIONS_ENABLED: enabled },
          "standalone",
        ),
      /CREWON_EXTENSIONS_ENABLED_invalid/u,
    );
  for (const environment of [
    { CREWON_EXTENSIONS_ENABLED: "1", ...owner },
    { CREWON_EXTENSION_HOST_ORIGIN: peer.CREWON_EXTENSION_HOST_ORIGIN },
    { CREWON_EXTENSION_HOST_TOKEN: token },
    { CREWON_EXTENSION_HOST_DEADLINE_MS: "1000" },
    { ...configured, CREWON_EXTENSION_HOST_TOKEN: "" },
    { ...configured, CREWON_EXTENSION_HOST_ORIGIN: "" },
  ])
    assert.throws(
      () => resolveControlExtensionWorkerEnvironment(environment, "standalone"),
      /CREWON_EXTENSION_HOST_CONFIGURATION_incomplete/u,
    );
});

test("enabled plugin ownership never falls back to a default principal, actor, tenant or space", () => {
  for (const name of Object.keys(owner)) {
    for (const replacement of [
      undefined,
      "",
      " padded ",
      "bad\u202eidentity",
      "x".repeat(129),
    ]) {
      assert.throws(
        () =>
          resolveControlExtensionWorkerEnvironment(
            { ...configured, [name]: replacement },
            "standalone",
          ),
        /CREWON_EXTENSION_HOST_OWNER_invalid/u,
      );
    }
  }
  for (const patch of [
    { CREWON_PRINCIPAL_ID: "principal-2" },
    { CREWON_ACTOR_ID: "actor-2" },
    { CREWON_TENANT_ID: "tenant-2" },
    { CREWON_SPACE_ID: "space-2" },
  ]) {
    const parsed = resolveControlExtensionWorkerEnvironment(
      { ...configured, ...patch },
      "standalone",
    );
    assert.ok(parsed);
    for (const [environmentName, property] of [
      ["CREWON_PRINCIPAL_ID", "principalId"],
      ["CREWON_ACTOR_ID", "actorId"],
      ["CREWON_TENANT_ID", "tenantId"],
      ["CREWON_SPACE_ID", "spaceId"],
    ] as const)
      assert.equal(
        parsed.actor[property],
        { ...configured, ...patch }[environmentName],
      );
  }
});

test("production rejects ambient extension authority before any local peer is prepared", () => {
  assert.equal(
    resolveControlExtensionWorkerEnvironment({}, "production"),
    undefined,
  );
  assert.equal(
    resolveControlExtensionWorkerEnvironment(
      { CREWON_EXTENSIONS_ENABLED: "0", ...owner },
      "production",
    ),
    undefined,
  );
  for (const environment of [
    configured,
    { CREWON_EXTENSIONS_ENABLED: "1" },
    peer,
    { CREWON_EXTENSIONS_ENABLED: "0", ...peer },
    { CREWON_EXTENSION_HOST_TOKEN: "" },
    { CREWON_EXTENSION_HOST_DEADLINE_MS: "1000" },
  ])
    assert.throws(
      () => resolveControlExtensionWorkerEnvironment(environment, "production"),
      /CREWON_EXTENSION_HOST_CONFIGURATION_forbidden/u,
    );
});

test("peer origin, token and optional deadline obey the exact client boundary", () => {
  for (const origin of [
    "http://localhost:43125",
    "http://127.1:43125",
    "http://2130706433:43125",
    "http://[::1]:43125",
    "https://127.0.0.1:43125",
    "http://127.0.0.1:43125/",
    "http://127.0.0.1:43125/path",
    "http://user@127.0.0.1:43125",
    "http://127.0.0.1:43125?tenant=other",
    "http://127.0.0.1:0",
  ])
    assert.throws(() =>
      resolveControlExtensionWorkerEnvironment(
        { ...configured, CREWON_EXTENSION_HOST_ORIGIN: origin },
        "standalone",
      ),
    );
  for (const value of [
    "short",
    "x".repeat(8193),
    `${token}\n`,
    `${token} `,
    `${token}\u0000`,
    `${token} inner`,
  ])
    assert.throws(() =>
      resolveControlExtensionWorkerEnvironment(
        { ...configured, CREWON_EXTENSION_HOST_TOKEN: value },
        "standalone",
      ),
    );
  for (const deadline of [
    "999",
    "30001",
    "01000",
    " 1000",
    "1000 ",
    "1e3",
    "1000.0",
    "",
    "Infinity",
  ])
    assert.throws(() =>
      resolveControlExtensionWorkerEnvironment(
        { ...configured, CREWON_EXTENSION_HOST_DEADLINE_MS: deadline },
        "standalone",
      ),
    );
  for (const deadline of ["1000", "30000"])
    assert.equal(
      resolveControlExtensionWorkerEnvironment(
        { ...configured, CREWON_EXTENSION_HOST_DEADLINE_MS: deadline },
        "standalone",
      )!.extensionWorker.deadlineMs,
      Number(deadline),
    );
});

test("Control entrypoint validates extension authority before opening artifacts or its database", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "crewon-extension-control-early-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = fileURLToPath(new URL("./main.ts", import.meta.url));
  for (const environment of [
    {
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_EXTENSIONS_ENABLED: "true",
    },
    {
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_EXTENSIONS_ENABLED: "1",
      ...peer,
    },
    { CREWON_CONTROL_SECURITY_MODE: "production", ...configured },
  ]) {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", main],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          ...environment,
          CREWON_CONTROL_DB_PATH: join(root, "control.sqlite"),
          CREWON_ARTIFACT_ROOT: join(root, "artifacts"),
          CREWON_ARTIFACT_DB_PATH: join(root, "artifacts.sqlite"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(exitCode, 1);
    assert.match(
      stderr,
      /CREWON_(?:EXTENSIONS_ENABLED_invalid|EXTENSION_HOST_OWNER_invalid|EXTENSION_HOST_CONFIGURATION_forbidden)/u,
    );
    assert.equal(
      stderr.includes("CREWON_ARTIFACT_ENCRYPTION_KEY_ID_required"),
      false,
    );
    assert.equal(existsSync(join(root, "control.sqlite")), false);
    assert.equal(existsSync(join(root, "artifacts.sqlite")), false);
    assert.equal(existsSync(join(root, "artifacts")), false);
  }
});
