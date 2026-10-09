import assert from "node:assert/strict";
import test from "node:test";
import {
  createExtensionConfiguration,
  createExtensionRunBinding,
} from "@crewon/domain";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { receipt } from "../../../packages/store/src/extension-store.test-support.ts";
import { BoundComfyToolRuntime } from "./extensions/comfyui-bound-runtime.ts";
import { COMFY_OBSERVE_TOOL } from "./extensions/comfyui-tool-catalog.ts";
import { comfyOperationId } from "./extensions/comfyui-tool-runtime.ts";
import { comfyCommand } from "./comfyui-tool-runtime.test-support.ts";
import {
  boundComfyFixture,
  output,
  publicDns,
  signal,
} from "./comfyui-bound-runtime.test-support.ts";

test("one bound runtime isolates concurrent Runs, reopens bindings and observes without resubmitting", async (t) => {
  const f = await boundComfyFixture(t);
  const bindings = [await f.addRun(), await f.addRun("run-2")];
  const runtime = f.runtime();
  const commands = bindings.map((binding) =>
    comfyCommand(runtime, { runId: binding.runId }),
  );
  const results = await Promise.all(
    commands.map((command) => runtime.execute(command, signal())),
  );
  const ids = results.map((value) => output(value).operationId as string);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(
    f.requests.filter((request) => request.method === "POST").length,
    2,
  );
  const wrong = await runtime.execute(
    comfyCommand(runtime, {
      name: COMFY_OBSERVE_TOOL,
      args: { operationId: ids[1] },
    }),
    signal(),
  );
  assert.deepEqual(output(wrong), { error: "operation_not_found" });
  assert.equal(f.requests.length, 2);
  await runtime.close();
  const opened = await f.open();
  const restored = f.runtime({ extensions: opened.store, runs: opened.parent });
  assert.deepEqual(
    await restored.reconcile(commands[0]!, signal()),
    results[0],
  );
  const observed = output(
    await restored.execute(
      comfyCommand(restored, {
        name: COMFY_OBSERVE_TOOL,
        args: { operationId: ids[0] },
      }),
      signal(),
    ),
  );
  assert.equal(observed.status, "succeeded");
  assert.equal(f.requests.length, 3);
  for (let i = 0; i < bindings.length; i++) {
    const saved = await f.operations.loadExternalOperation({
      ...bindings[i]!,
      operationId: ids[i]!,
    });
    assert.equal(saved?.status, i === 0 ? "succeeded" : "submitted");
  }
});

test("configuration updates never retarget an admitted Run or permit a new runtime to claim it", async (t) => {
  const f = await boundComfyFixture(t);
  await f.addRun();
  const runtime = f.runtime();
  const { contentDigest: _digest, ...fields } = f.config;
  const config2 = createExtensionConfiguration(
    {
      ...fields,
      revision: 2,
      parameters: { baseUrl: "https://next.example/" },
    },
    extensionStoreDigester,
  );
  await f.first.store.saveExtensionConfiguration({
    configuration: config2,
    expectedRevision: 1,
    receipt: receipt("config-2"),
  });
  await f.state("enabled", config2);
  await f.addRun("run-2", null, config2);
  const next = f.runtime({ configuration: config2 });
  await assert.rejects(
    next.execute(comfyCommand(next), signal()),
    /extension_run_binding_mismatch/,
  );
  await assert.rejects(
    runtime.execute(comfyCommand(runtime, { runId: "run-2" }), signal()),
    /extension_run_binding_mismatch/,
  );
  await runtime.execute(comfyCommand(runtime), signal());
  await next.execute(comfyCommand(next, { runId: "run-2" }), signal());
  assert.deepEqual(
    f.requests.map((request) => request.target.endpoint.origin),
    ["https://comfy.example", "https://next.example"],
  );
});

test("unbound Runs and implementation or authority drift fail before reservation or HTTP", async (t) => {
  const f = await boundComfyFixture(t);
  await f.addRun();
  const runtime = f.runtime();
  await assert.rejects(
    runtime.execute(comfyCommand(runtime, { runId: "ordinary-run" }), signal()),
    /extension_run_binding_not_found/,
  );
  const drift = f.runtime({
    runs: {
      loadRun: async (locator) => ({
        ...(await f.first.parent.loadRun(locator))!,
        authorityId: "other-authority",
      }),
    },
  });
  await assert.rejects(
    drift.execute(comfyCommand(drift), signal()),
    /extension_run_authority_mismatch/,
  );
  assert.throws(
    () =>
      new BoundComfyToolRuntime({
        ...f.options,
        registration: {
          ...f.registration,
          implementationDigest: `sha256:${"b".repeat(64)}`,
        },
      }),
    /extension_implementation_mismatch/,
  );
  assert.throws(
    () =>
      new BoundComfyToolRuntime({
        ...f.options,
        registration: {
          ...f.registration,
          manifest: { ...f.registration.manifest, version: "9.0.0" },
        },
      }),
    /extension_implementation_mismatch/,
  );
  assert.equal(await f.count("extension_external_operations"), 0);
  assert.equal(f.requests.length, 0);
});

test("disable blocks fresh submission, permits accepted recovery; revoke denies cached results too", async (t) => {
  const f = await boundComfyFixture(t);
  await f.addRun();
  const runtime = f.runtime();
  const command = comfyCommand(runtime);
  const submitted = await runtime.execute(command, signal());
  const observe = comfyCommand(runtime, {
    name: COMFY_OBSERVE_TOOL,
    args: { operationId: output(submitted).operationId },
    callId: "observe",
  });
  await f.state("disabled");
  await assert.rejects(
    runtime.execute(comfyCommand(runtime, { callId: "fresh" }), signal()),
    /extension_generation_disabled/,
  );
  assert.deepEqual(await runtime.reconcile(command, signal()), submitted);
  assert.equal(
    output(await runtime.execute(observe, signal())).status,
    "succeeded",
  );
  assert.equal(f.requests.length, 2);
  await f.state("revoked");
  for (const candidate of [command, observe]) {
    await assert.rejects(
      runtime.execute(candidate, signal()),
      /extension_access_revoked/,
    );
    await assert.rejects(
      runtime.reconcile(candidate, signal()),
      /extension_access_revoked/,
    );
  }
  assert.equal(f.requests.length, 2);
  assert.equal(await f.count("extension_external_operations"), 1);
});

for (const change of ["disabled", "revoked", "permission"] as const) {
  test(`fresh ${change} during DNS prevents POST and preserves the no-resubmit fence`, async (t) => {
    const f = await boundComfyFixture(t);
    const binding = await f.addRun();
    let changed = false;
    const runtime = f.runtime({
      dns: {
        resolveAll: async () => {
          if (!changed) {
            changed = true;
            if (change === "permission") f.controls.allowed = false;
            else await f.state(change);
          }
          return publicDns.resolveAll();
        },
      },
    });
    const command = comfyCommand(runtime);
    assert.equal(
      (await runtime.execute(command, signal())).status,
      "unknownOutcome",
    );
    assert.equal(f.requests.length, 0);
    const operationId = comfyOperationId(binding, command.idempotencyKey);
    assert.equal(
      (await f.operations.loadExternalOperation({ ...binding, operationId }))
        ?.status,
      "submitting",
    );
    f.controls.allowed = true;
    await f.state("enabled");
    f.controls.respond = async (request) =>
      request.target.endpoint.pathname === "/queue"
        ? { queue_running: [], queue_pending: [] }
        : {};
    assert.equal(
      (await runtime.execute(command, signal())).status,
      "unknownOutcome",
    );
    assert.deepEqual(
      f.requests.map((request) => request.method),
      ["GET", "GET"],
    );
  });
}

test("permission is checked between history and queue requests without corrupting saved state", async (t) => {
  const f = await boundComfyFixture(t);
  const binding = await f.addRun();
  const runtime = f.runtime();
  const operationId = output(
    await runtime.execute(comfyCommand(runtime), signal()),
  ).operationId as string;
  f.controls.respond = async () => {
    f.controls.allowed = false;
    return {};
  };
  await assert.rejects(
    runtime.execute(
      comfyCommand(runtime, {
        name: COMFY_OBSERVE_TOOL,
        args: { operationId },
      }),
      signal(),
    ),
    /extension_execution_access_denied/,
  );
  assert.equal(
    f.requests.length,
    2,
    "POST then history only; queue must not dispatch",
  );
  assert.equal(
    (await f.operations.loadExternalOperation({ ...binding, operationId }))
      ?.status,
    "submitted",
  );
});

test("separate query Run accesses only its pinned source, requires source permission and cannot submit", async (t) => {
  const f = await boundComfyFixture(t);
  const source = await f.addRun();
  const runtime = f.runtime();
  const operationId = output(
    await runtime.execute(comfyCommand(runtime), signal()),
  ).operationId as string;
  await f.state("disabled");
  await f.addRun("query-run", {
    runId: source.runId,
    bindingDigest: source.bindingDigest,
    operationId,
  });
  const observe = comfyCommand(runtime, {
    runId: "query-run",
    name: COMFY_OBSERVE_TOOL,
    args: { operationId },
    callId: "query",
  });
  f.controls.authorize = async (request) =>
    request.action === "run:read"
      ? { outcome: "deny", reasonCode: "source_revoked" }
      : { outcome: "allow" };
  await assert.rejects(
    runtime.execute(observe, signal()),
    /extension_execution_access_denied/,
  );
  assert.equal(f.requests.length, 1);
  f.controls.authorize = undefined;
  const wrong = comfyCommand(runtime, {
    runId: "query-run",
    name: COMFY_OBSERVE_TOOL,
    args: { operationId: "00000000-0000-0000-0000-000000000000" },
  });
  assert.deepEqual(output(await runtime.execute(wrong, signal())), {
    error: "operation_not_found",
  });
  await assert.rejects(
    runtime.execute(comfyCommand(runtime, { runId: "query-run" }), signal()),
    /comfy_query_submission_forbidden/,
  );
  assert.equal(f.requests.length, 1);
  assert.equal(
    output(await runtime.execute(observe, signal())).status,
    "succeeded",
  );
  assert.equal(
    (await f.operations.loadExternalOperation({ ...source, operationId }))
      ?.status,
    "succeeded",
  );
  assert.equal(f.requests.length, 2);
  assert.equal(await f.count("extension_external_operations"), 1);
  const sourceAccess = f.permissions.filter(
    (request) => request.action === "run:read",
  );
  assert.ok(sourceAccess.length >= 2);
  assert.ok(
    sourceAccess.every(
      (request) =>
        request.resource.kind === "run" &&
        request.resource.runId === source.runId,
    ),
  );
});

test("closing a shared runtime aborts DNS and prevents any subsequent work", async (t) => {
  const f = await boundComfyFixture(t);
  await f.addRun();
  const started = deferred<void>();
  const lateDns = deferred<Awaited<ReturnType<typeof publicDns.resolveAll>>>();
  const runtime = f.runtime({
    dns: {
      resolveAll: async () => {
        started.resolve();
        return lateDns.promise;
      },
    },
  });
  assert.equal(runtime.canRetire(), true);
  const command = comfyCommand(runtime);
  const pending = runtime.execute(command, signal());
  await started.promise;
  assert.equal(runtime.canRetire(), false);
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  await closing;
  assert.equal((await pending).status, "unknownOutcome");
  lateDns.resolve(await publicDns.resolveAll());
  await assert.rejects(
    runtime.execute(command, signal()),
    /extension_runtime_closed/,
  );
  assert.equal(f.requests.length, 0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("legacy bound Comfy runtime rejects a composition binding before any external dispatch", async (t) => {
  const f = await boundComfyFixture(t);
  const original = await f.addRun();
  const binding = createExtensionRunBinding(
    {
      ...original,
      schemaVersion: "crewon.extension-run-binding.v1",
      composition: {
        profileId: "profile-1",
        authorityEpoch: "epoch-1",
        revision: 1,
        lockDigest: `sha256:${"a".repeat(64)}`,
      },
    },
    extensionStoreDigester,
  );
  const extensions = new Proxy(f.first.store, {
    get(target, property) {
      if (property === "loadExtensionRunBinding") return async () => binding;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = f.runtime({ extensions });
  await assert.rejects(
    runtime.execute(comfyCommand(runtime), signal()),
    /extension_composition_execution_unavailable/,
  );
  assert.equal(f.requests.length, 0);
  assert.equal(await f.count("extension_external_operations"), 0);
  await runtime.close();
});
