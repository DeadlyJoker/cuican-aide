import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readOnlyPolicy } from "../../../packages/mcp-runtime/src/mcp-tool-runtime.test-support.ts";
import { manifestCreationFixture } from "./runtime-creation-manifest.test-support.ts";

test("repeated PIM configuration failures release admission, allowing corrected settings in the same process", async (t) => {
  const environment: Record<string, string | undefined> = {
    CREWON_PIM_SANDBOX_USERNAME: "test",
  };
  const f = await manifestCreationFixture(t, { environment });
  for (let n = 0; n < 140; n++) {
    await assert.rejects(
      f.acquire(),
      /CREWON_PIM_SANDBOX_configuration_incomplete/,
    );
    f.assertReleased();
  }
  delete environment.CREWON_PIM_SANDBOX_USERNAME;
  const lease = await f.acquire();
  lease.release();
  assert.equal(f.capacity.snapshot().owners, 1);
  await f.registry.close();
  f.assertReleased();
});

for (const kind of ["device", "stdio"] as const)
  test(`invalid ${kind} configuration does not consume owner capacity over repeated loads`, async (t) => {
    const f = await manifestCreationFixture(t, { files: { [kind]: {} } });
    for (let n = 0; n < 140; n++) {
      await assert.rejects(f.acquire(), {
        message:
          kind === "stdio"
            ? "mcp_config_fields_invalid"
            : "device_tool_runtime_config_invalid",
      });
      f.assertReleased();
    }
  });

test("materialization drift is allocation-free and restoring pinned content restores its original validation result", async (t) => {
  const f = await manifestCreationFixture(t, { files: { stdio: {} } });
  const path = join(f.root, "stdio.json");
  await writeFile(path, JSON.stringify({ drifted: true }));
  for (let n = 0; n < 140; n++) {
    await assert.rejects(
      f.acquire(),
      /agent_version_runtime_materialization_drift/,
    );
    f.assertReleased();
  }
  await writeFile(path, "{}");
  await assert.rejects(f.acquire(), { message: "mcp_config_fields_invalid" });
  f.assertReleased();
});

test("Cloud transport validation fails without retaining an uncertain allocation", async (t) => {
  const f = await manifestCreationFixture(t, {
    provider: {
      kind: "cloudAgent",
      invocationUrl: "not-a-url",
      modelId: "fixture-model",
      agentId: 1,
      apiKeyEnvironment: null,
      storeResponses: false,
      requestProfile: "standard",
      idleTimeoutMs: 1000,
      sequencePolicy: "required",
    },
  });
  for (let n = 0; n < 140; n++) {
    await assert.rejects(f.acquire(), /cloud_agent|Invalid URL/);
    f.assertReleased();
  }
});

for (const mode of ["catalogFailure", "initializeFailure"] as const)
  test(
    `real stdio ${mode} holds admission until child exit and returns it after every failed creation`,
    { timeout: 20000 },
    async (t) => {
      const f = await manifestCreationFixture(t, {
        makeFiles: (root) => ({
          stdio: {
            schemaVersion: "crewon.mcp-stdio-config.v0",
            servers: [
              {
                serverId: "fixture",
                command: process.execPath,
                args: [
                  fileURLToPath(
                    new URL(
                      "../../../packages/mcp-runtime/src/fixtures/creation-cleanup-server.mjs",
                      import.meta.url,
                    ),
                  ),
                  join(root, "pid"),
                  mode,
                ],
                cwd: null,
                env: {},
                tools: { echo: readOnlyPolicy() },
              },
            ],
          },
        }),
      });
      const pids = new Set<number>();
      t.after(() => {
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      });
      for (let n = 0; n < (mode === "catalogFailure" ? 4 : 2); n++) {
        await writeFile(join(f.root, "pid"), "");
        let settled = false;
        const result = assert
          .rejects(f.acquire(), /fixture_creation_failure/)
          .finally(() => {
            settled = true;
          });
        const until = Date.now() + 5000;
        let pid = 0;
        while (!pid) {
          pid = Number(await readFile(join(f.root, "pid"), "utf8"));
          if (Date.now() > until) assert.fail("MCP fixture did not start");
          if (!pid) await delay(5);
        }
        pids.add(pid);
        if (mode === "initializeFailure") {
          assert.equal(settled, false);
          assert.equal(f.capacity.snapshot().owners, 1);
          assert.equal(f.capacity.snapshot().creating, 1);
          assert.doesNotThrow(() => process.kill(pid, 0));
        }
        await result;
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        pids.delete(pid);
        f.assertReleased();
      }
    },
  );
