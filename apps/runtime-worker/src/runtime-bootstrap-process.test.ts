import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { createConfiguredToolRuntime } from "./runtime-process-environment.ts";
import {
  bootstrapProcessFixture,
  waitFor,
} from "./runtime-bootstrap-process.test-support.ts";

test(
  "Worker CLI reports failed shutdown as exit 1 after still closing its MCP child",
  { timeout: 10000 },
  async (t) => {
    const f = bootstrapProcessFixture(t, { closeDelayMs: 100 });
    await f.activate();
    const worker = f.start(
      { CREWON_WORKER_ONCE: "0" },
      { modelCloseFailure: true },
    );
    await waitFor(() =>
      worker.stdout().includes("CrewON Runtime Worker started"),
    );
    worker.child.kill("SIGTERM");
    const result = await worker.completion;
    assert.equal(result.code, 1, worker.stderr());
    assert.equal(result.signal, null);
    assert.equal(result.mcpGoneAtWorkerExit, true);
    assert.match(worker.stderr(), /CrewON Runtime Worker shutdown failed/);
    assert.doesNotMatch(worker.stderr(), /fixture_model_close_failed/);
  },
);

test(
  "ambient bootstrap closes the real MCP child even when an earlier tool closer throws synchronously",
  { timeout: 10000 },
  async (t) => {
    const f = bootstrapProcessFixture(t);
    const device = join(f.root, "invalid-device.json");
    writeFileSync(device, "{}");
    let closes = 0;
    const prototype = InMemoryToolBroker.prototype;
    assert.equal(Object.hasOwn(prototype, "close"), false);
    Object.defineProperty(prototype, "close", {
      configurable: true,
      value() {
        closes++;
        throw new Error("fixture_close_failed");
      },
    });
    try {
      await assert.rejects(
        createConfiguredToolRuntime({
          ...f.environment,
          CREWON_PIM_SANDBOX_BASE_URL: "http://127.0.0.1:9",
          CREWON_PIM_SANDBOX_USERNAME: "fixture",
          CREWON_PIM_SANDBOX_PASSWORD: "fixture",
          CREWON_PIM_SANDBOX_AGENT_ID: "1",
          CREWON_DEVICE_TOOL_CONFIG_PATH: device,
        }),
        /device_tool_runtime_config_invalid/,
      );
      assert.equal(closes, 1);
      assert.equal(f.gone(), true);
    } finally {
      Reflect.deleteProperty(prototype, "close");
    }
  },
);

for (const scenario of [
  "beforeInputsTransferred",
  "insideComposition",
  "artifactConfiguration",
] as const)
  test(
    `Worker CLI ${scenario} failure leaves no MCP child and reports the original startup error`,
    { timeout: 10000 },
    async (t) => {
      const f = bootstrapProcessFixture(t);
      const changes =
        scenario === "beforeInputsTransferred"
          ? { CREWON_CONTROL_DB_PATH: "" }
          : scenario === "artifactConfiguration"
            ? { CREWON_ARTIFACT_ROOT: f.root }
            : {};
      const expected =
        scenario === "beforeInputsTransferred"
          ? /CREWON_CONTROL_DB_PATH_required/
          : scenario === "artifactConfiguration"
            ? /CREWON_ARTIFACT_CONFIGURATION_incomplete/
            : /runtime_release_bundle_missing/;
      const worker = f.start(changes);
      const result = await worker.completion;
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.match(worker.stderr(), expected);
      assert.equal(result.mcpGoneAtWorkerExit, true);
    },
  );

test(
  "Worker CLI once mode closes its real MCP process after a successful wake",
  { timeout: 10000 },
  async (t) => {
    const f = bootstrapProcessFixture(t);
    await f.activate();
    const worker = f.start(),
      result = await worker.completion;
    assert.equal(result.code, 0, worker.stderr());
    assert.equal(result.signal, null);
    assert.match(worker.stdout(), /"kind":"idle"/);
    assert.equal(result.mcpGoneAtWorkerExit, true);
  },
);

for (const signals of [
  ["SIGINT", "SIGTERM"],
  ["SIGINT", "SIGINT", "SIGINT"],
  ["SIGTERM", "SIGTERM", "SIGTERM"],
  ["SIGINT", "SIGTERM", "SIGINT", "SIGTERM"],
] as const)
  test(
    `${signals.join("/")} joins the same physical MCP cleanup before Worker exit`,
    { timeout: 10000 },
    async (t) => {
      const f = bootstrapProcessFixture(t, { holdCloseUntilReleased: true });
      await f.activate();
      const worker = f.start({ CREWON_WORKER_ONCE: "0" });
      await waitFor(() =>
        worker.stdout().includes("CrewON Runtime Worker started"),
      );
      worker.child.kill(signals[0]);
      await waitFor(() => existsSync(f.closingFile));
      const closingAt = Number(readFileSync(f.closingFile, "utf8"));
      for (const signal of signals.slice(1)) {
        worker.child.kill(signal);
        await delay(20);
      }
      await delay(300);
      assert.equal(worker.child.exitCode, null, worker.stderr());
      assert.equal(worker.child.signalCode, null, worker.stderr());
      assert.equal(
        f.gone(),
        false,
        "MCP cleanup must still be physically pending",
      );
      f.releaseClose();
      const result = await worker.completion;
      assert.equal(
        result.code,
        0,
        JSON.stringify({ ...result, stderr: worker.stderr() }),
      );
      assert.equal(result.signal, null);
      assert.equal(result.mcpGoneAtWorkerExit, true);
      assert.ok(
        result.exitedAt - closingAt >= 250,
        "second signal exited before the held child shutdown completed",
      );
    },
  );
