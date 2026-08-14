import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./release-main.ts", import.meta.url));

test("production release rejects SQLite without opening or writing it", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    env: {
      ...cleanEnvironment(),
      CREWON_CONTROL_SECURITY_MODE: "production",
      CREWON_CONTROL_DB_PATH: databasePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await collectExit(child);
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /CREWON_CONTROL_DB_PATH_forbidden/u);
  assert.equal(output.stdout, "");
  assert.equal(existsSync(databasePath), false);
});

test("production release requires an explicit PostgreSQL schema", async () => {
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    env: {
      ...cleanEnvironment(),
      CREWON_CONTROL_SECURITY_MODE: "production",
      CREWON_CONTROL_DATABASE_URL: "postgresql://127.0.0.1:1/unused",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await collectExit(child);
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /CREWON_CONTROL_DATABASE_SCHEMA_required/u);
  assert.equal(output.stdout, "");
});

test("production release rejects standalone route defaults before Store open", async () => {
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    env: {
      ...cleanEnvironment(),
      CREWON_CONTROL_SECURITY_MODE: "production",
      CREWON_CONTROL_DATABASE_URL: "postgresql://127.0.0.1:1/unused",
      CREWON_CONTROL_DATABASE_SCHEMA: "release_entry_test",
      CREWON_RELEASE_PRINCIPAL_ID: "release-principal-production",
      CREWON_RELEASE_ACTOR_ID: "release-actor-production",
      CREWON_TENANT_ID: "tenant-production",
      CREWON_SPACE_ID: "space-production",
      CREWON_AUTHORITY_ID: "standalone-authority",
      CREWON_RUNTIME_GENERATION: "runtime-production-v1",
      CREWON_AGENT_VERSION_ID: "agent-production-v1",
      CREWON_POLICY_SNAPSHOT_ID: "policy-production-v1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await collectExit(child);
  assert.notEqual(output.code, 0);
  assert.match(
    output.stderr,
    /CREWON_AUTHORITY_ID_standalone_default_forbidden/u,
  );
  assert.equal(output.stdout, "");
  assert.doesNotMatch(output.stderr, /ECONNREFUSED/u);
});

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "CREWON_CONTROL_DATABASE_URL",
    "CREWON_CONTROL_DATABASE_SCHEMA",
    "CREWON_CONTROL_DB_PATH",
    "CREWON_CONTROL_SECURITY_MODE",
  ]) {
    delete environment[name];
  }
  return environment;
}

function collectExit(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("exit", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

function temporaryDatabasePath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-release-db-authority-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "must-not-exist.sqlite");
}
