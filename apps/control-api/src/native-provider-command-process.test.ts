import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

test(
  "native coordinator handles its real stdin command and exits without input EOF",
  { timeout: 5_000 },
  async (t) => {
    const f = await processFixture(t);
    f.child.stdin.write('{"phase":"inspect"}\n');
    const result = await f.finished;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      phase: "inspect",
      disposition: null,
      catalog: null,
      pending: null,
    });
    await access(f.database);
  },
);

test(
  "native coordinator rejects unterminated overflow before opening its database",
  { timeout: 5_000 },
  async (t) => {
    const f = await processFixture(t);
    f.child.stdin.write(Buffer.alloc(64 * 1024 + 1, 120));
    const result = await f.finished;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /provider_native_command_invalid/u);
    await assert.rejects(access(f.database), { code: "ENOENT" });
  },
);

test(
  "native coordinator process errors never echo malformed provider credentials",
  { timeout: 5_000 },
  async (t) => {
    const f = await processFixture(t);
    const secret = "provider-secret-must-not-be-logged";
    f.child.stdin.write(`{"credential":"${secret}" invalid}\n`);
    const result = await f.finished;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /provider_native_command_invalid/u);
    assert.equal((result.stdout + result.stderr).includes(secret), false);
    await assert.rejects(access(f.database), { code: "ENOENT" });
  },
);

async function processFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-native87-"));
  const database = join(directory, "test.sqlite");
  const entry = new URL(
    "./provider-settings-native-coordinator.ts",
    import.meta.url,
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `process.argv[1] = 'provider-settings-coordinator.mjs'; await import(${JSON.stringify(entry)});`,
    ],
    {
      env: { ...process.env, CREWON_CONTROL_DB_PATH: database },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const finished = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => {
      stdout += value;
    });
    child.stderr.setEncoding("utf8").on("data", (value: string) => {
      stderr += value;
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await finished.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  return { child, finished, database };
}
