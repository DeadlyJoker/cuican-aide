import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nativePreparationFixture } from "./installed-plugin-native-preparation.test-support.ts";

const releaseEntry = fileURLToPath(
  new URL("./release-main.ts", import.meta.url),
);
const repository = fileURLToPath(new URL("../../../", import.meta.url));

test(
  "actual preparation CLI rejects corrupt private inputs and legacy conflicts before starting the configured default MCP subprocess",
  { timeout: 60_000 },
  async (t) => {
    assert.match(process.version, /^v24\./u);
    const fixture = await nativePreparationFixture(t);
    const marker = join(fixture.dataDirectory, "default-mcp-started.json");
    const serverPath = join(fixture.dataDirectory, "default-mcp-marker.mjs");
    const configPath = join(fixture.dataDirectory, "default-mcp.json");
    await writeFile(
      serverPath,
      `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,kind:'actual-default-mcp-subprocess'}),{mode:0o600});
process.exit(29);
`,
      { mode: 0o600 },
    );
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "crewon.mcp-stdio-config.v0",
        servers: [
          {
            serverId: "actual-native-preflight-marker",
            command: process.execPath,
            args: [serverPath],
            cwd: fixture.dataDirectory,
            env: {},
            tools: {},
          },
        ],
      }),
      { mode: 0o600 },
    );
    const before = await fixture.recordCounts();
    for (const scenario of [
      "corrupt schema",
      "non-private file",
      "legacy conflict",
    ] as const) {
      const input = await fixture.input(
        scenario === "corrupt schema"
          ? {
              schemaVersion:
                "crewon.installed-plugin-native-preparation.corrupt",
            }
          : {},
      );
      if (scenario === "non-private file") await chmod(input.inputPath, 0o644);
      const result = await actualReleaseCli({
        ...input.environment,
        CREWON_MCP_STDIO_CONFIG_PATH: configPath,
        ...(scenario === "legacy conflict"
          ? { CREWON_EXTENSIONS_ENABLED: "1" }
          : {}),
      });
      assert.notEqual(result.code, 0, scenario);
      assert.equal(result.signal, null, scenario);
      const reason =
        scenario === "corrupt schema"
          ? /installed_plugin_native_preparation_configuration_invalid/u
          : scenario === "non-private file"
            ? /installed_plugin_native_preparation_file_invalid/u
            : /installed_plugin_native_preparation_legacy_runtime_conflict/u;
      assert.match(result.stderr, reason, scenario);
      await assert.rejects(lstat(marker), { code: "ENOENT" }, scenario);
      await assert.rejects(
        lstat(join(input.directory, "release.json")),
        { code: "ENOENT" },
        scenario,
      );
      await assert.rejects(lstat(fixture.marker), { code: "ENOENT" }, scenario);
      assert.deepEqual(await fixture.recordCounts(), before, scenario);
    }

    // Calibrate the same tool configuration with the real ordinary release CLI.
    // The server exits before initialize, so this path cannot publish a default.
    const control = await fixture.input();
    const environment: Record<string, string | undefined> = {
      ...control.environment,
      CREWON_MCP_STDIO_CONFIG_PATH: configPath,
    };
    delete environment.CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH;
    const started = await actualReleaseCli(environment);
    assert.notEqual(started.code, 0);
    assert.equal(started.signal, null);
    const proof = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(proof.kind, "actual-default-mcp-subprocess");
    assert.ok(Number.isSafeInteger(proof.pid) && proof.pid > 1);
    await assertChildGone(proof.pid);
    assert.deepEqual(await fixture.recordCounts(), before);
    assert.deepEqual(fixture.state.requests, []);
    await rm(marker);
  },
);

/** Joins the actual CLI's stdio close, including timeout cleanup; no loader or transport is mocked. */
async function actualReleaseCli(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("CREWON_") &&
        name !== "AICUICAN_API_KEY" &&
        name !== "NODE_OPTIONS",
    ),
  );
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", releaseEntry],
    {
      cwd: repository,
      env: { ...ambient, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.ok(child.stdout && child.stderr);
  let stderr = "";
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.resume();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 15_000);
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  assert.ifError(spawnError);
  assert.equal(
    timedOut,
    false,
    "actual preparation CLI must terminate without timing out",
  );
  assert.ok(child.pid);
  await assertChildGone(child.pid);
  return { ...result, stderr };
}

async function assertChildGone(pid: number) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return;
      throw error;
    }
    assert.ok(
      Date.now() < deadline,
      "actual CLI/MCP child must physically terminate before fixture cleanup",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
