import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { startFullAppProcess } from "./installed-plugin-full-app-process.test-support.ts";
import { PRODUCTION_DATABASE_MAX_POOL_SIZE_ENV } from "./production-database-environment.ts";
import {
  PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV,
  PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
} from "./production-project-environment.ts";

/** Run the original Main with only named fixture values, never the caller's credentials. */
async function rejectedStartup(
  environment: NodeJS.ProcessEnv,
  reason: string,
): Promise<void> {
  const child = startFullAppProcess("control", environment);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      child.completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("production_main_rejection_timeout")),
          15_000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(result.code, 1, child.stderr());
    assert.equal(result.signal, null, child.stderr());
    assert.equal(child.finished(), true);
    assert.ok(child.stderr().includes(`Error: ${reason}`), child.stderr());
    assert.doesNotMatch(child.stdout(), /Control API listening/u);
    assert.doesNotMatch(
      child.stderr(),
      /ECONNREFUSED|unexpected_database_open/u,
    );
  } finally {
    clearTimeout(timer);
    if (!child.finished()) child.child.kill("SIGKILL");
    await child.completion;
  }
}

async function privateRoot(t: TestContext): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-main-startup-rejection-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("actual Main without new opt-ins preserves its existing standalone and production prerequisite errors", async () => {
  await rejectedStartup({}, "CREWON_ARTIFACT_ENCRYPTION_KEY_ID_required");
  await rejectedStartup(
    { CREWON_CONTROL_SECURITY_MODE: "production" },
    "CREWON_CONTROL_DATABASE_URL_required",
  );
});

test("actual standalone Main rejects each new production-only opt-in before artifact startup", async () => {
  await rejectedStartup(
    { [PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV]: "/must-not-read.json" },
    "production_project_configuration_invalid",
  );
  await rejectedStartup(
    { [PRODUCTION_DATABASE_MAX_POOL_SIZE_ENV]: "1" },
    "production_database_max_pool_size_invalid",
  );
});

test("actual production Main rejects malformed private project data and pool sizes before artifact startup", async (t) => {
  const directory = await privateRoot(t);
  const path = join(directory, "project.json");
  const environment = {
    CREWON_CONTROL_SECURITY_MODE: "production",
    [PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV]: path,
    CREWON_ARTIFACT_DB_PATH: join(directory, "must-not-create.sqlite"),
  };
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
      authorization: "injected",
    }),
    { mode: 0o600 },
  );
  await rejectedStartup(
    environment,
    "production_project_configuration_invalid",
  );
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
    }),
  );
  await rejectedStartup(
    { ...environment, [PRODUCTION_DATABASE_MAX_POOL_SIZE_ENV]: "65" },
    "production_database_max_pool_size_invalid",
  );
  await assert.rejects(access(environment.CREWON_ARTIFACT_DB_PATH), {
    code: "ENOENT",
  });
});

test("actual production Main refuses a history opt-in without an original task reader before opening PostgreSQL", async (t) => {
  const directory = await privateRoot(t);
  const path = join(directory, "project.json");
  const keyPath = join(directory, "named-artifact-key");
  const artifactDatabase = join(directory, "artifact.sqlite");
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: PRODUCTION_PROJECT_COMPOSITION_CONFIG_SCHEMA,
      generationReads: { version: "crewon.project-generation-read.v1" },
    }),
    { mode: 0o600 },
  );
  await rejectedStartup(
    {
      CREWON_CONTROL_SECURITY_MODE: "production",
      CREWON_CONTROL_DATABASE_URL:
        "postgres://named_main_startup_fixture@127.0.0.1:1/postgres",
      [PRODUCTION_PROJECT_COMPOSITION_CONFIG_ENV]: path,
      [PRODUCTION_DATABASE_MAX_POOL_SIZE_ENV]: "1",
      CREWON_ARTIFACT_ROOT: join(directory, "artifacts"),
      CREWON_ARTIFACT_DB_PATH: artifactDatabase,
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: keyPath,
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "named-main-startup-key",
      CREWON_CONTROL_BFF_TOKEN: "named-bff-" + "b".repeat(32),
      CREWON_BFF_ALLOWED_ORIGINS: "http://127.0.0.1:1",
      CREWON_BFF_ALLOWED_REMOTE_ADDRESSES: "127.0.0.1",
      CREWON_IDENTITY_VERIFY_URL: "https://localhost:1/identity",
      CREWON_IDENTITY_SERVICE_TOKEN: "named-identity-" + "i".repeat(32),
      CREWON_IDENTITY_EXPECTED_ISSUER: "https://identity.fixture.test",
      CREWON_IDENTITY_EXPECTED_AUDIENCE: "crewon-control",
      CREWON_POLICY_DECISION_URL: "https://localhost:1/policy",
      CREWON_POLICY_SERVICE_TOKEN: "named-policy-" + "p".repeat(32),
    },
    "project_generation_read_composition_required",
  );
  // The process passed private configuration loading and original artifact construction.
  await access(artifactDatabase);
});
