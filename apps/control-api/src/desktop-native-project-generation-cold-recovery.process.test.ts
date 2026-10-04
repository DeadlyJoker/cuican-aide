import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ControlApiClient } from "../../../packages/control-client/src/index.ts";
import { setDesktopPluginSelectionWithNativeBusinessActivation } from "../../crewon-ui/electron/desktopNativePluginBusinessActivation.ts";
import { startDesktopInstalledPluginRuntimeChildren } from "../../crewon-ui/electron/desktopInstalledPluginRuntimeChildren.ts";
import { terminateRuntimeChild } from "../../crewon-ui/electron/runtimeSupervisor.ts";
import { nativeLocalProcessFixture } from "../../runtime-worker/src/installed-plugin-native-process.integration.test-support.ts";

test(
  "genuine Native Main preparation and cold Control process restore a dispatched generation with its original committed unmetered receipt and same key",
  {
    timeout: 120_000,
    skip:
      process.env.CREWON_TEST_KREA_PLUGIN_DIR === undefined ||
      process.env.CREWON_TEST_SHORT_DRAMA_PLUGIN_DIR === undefined,
  },
  async (t) => {
    const measure = async <T>(phase: string, work: () => Promise<T>) => {
      const startedAt = performance.now();
      try {
        return await work();
      } finally {
        t.diagnostic(
          JSON.stringify({
            phase,
            elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
          }),
        );
      }
    };
    const directory = await mkdtemp(
      join(await realpath(tmpdir()), "crewon-native-generation-cold-ack-"),
    );
    const faultMarker = join(directory, "original-ack-lost.json");
    const networkMarker = join(directory, "external-network-attempt.json");
    const checkpoint = join(directory, "checkpoint.mjs");
    const application = pathToFileURL(
      fileURLToPath(
        new URL("../../../packages/application/src/index.ts", import.meta.url),
      ),
    ).href;
    const store = pathToFileURL(
      fileURLToPath(
        new URL("../../../packages/store/src/index.ts", import.meta.url),
      ),
    ).href;
    await writeFile(
      checkpoint,
      `import {existsSync,writeFileSync} from 'node:fs';
import {PluginUiApplicationService,PluginUiCommittedTaskAuthority} from ${JSON.stringify(application)};
import {SqliteRunStore} from ${JSON.stringify(store)};
const originalFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.hostname==='127.0.0.1')return originalFetch(input,init);writeFileSync(${JSON.stringify(networkMarker)},JSON.stringify({externalAttempt:true}),{mode:0o600});throw new Error('owned_native_cold_recovery_external_network_blocked');};
const report=(operation,error)=>{const causes=[];for(let e=error;e&&causes.length<6;e=e.cause)causes.push({name:e.name,code:/^[a-z][a-z0-9_]+$/.test(e.message)?e.message:null,frames:e.stack?.split('\\n').slice(1,5)});process.stderr.write('OWNED_NATIVE_COLD_RECOVERY '+JSON.stringify({operation,causes})+'\\n');};
const originalIssue=PluginUiCommittedTaskAuthority.prototype.issueProjectGeneration;PluginUiCommittedTaskAuthority.prototype.issueProjectGeneration=async function(...args){const outcome=await Reflect.apply(originalIssue,this,args);if(!existsSync(${JSON.stringify(faultMarker)})){writeFileSync(${JSON.stringify(faultMarker)},JSON.stringify({originalCommitVerified:true}),{mode:0o600});throw new Error('owned_native_original_generation_ack_lost');}return outcome;};
const originalInvoke=PluginUiApplicationService.prototype.invoke;PluginUiApplicationService.prototype.invoke=function(...args){const result=Reflect.apply(originalInvoke,this,args);void result.catch(error=>report('invoke',error));return result;};
const originalBegin=SqliteRunStore.prototype.beginRunAttempt;SqliteRunStore.prototype.beginRunAttempt=async function(...args){await Reflect.apply(originalBegin,this,args);throw new Error('owned_native_cold_recovery_attempt_checkpoint');};`,
      { mode: 0o600 },
    );
    const sourceDirectory = process.env.CREWON_TEST_SHORT_DRAMA_PLUGIN_DIR;
    assert.ok(sourceDirectory, "independent UI-only Short Drama is required");
    const f = await measure("fixture.prepare", () =>
      nativeLocalProcessFixture(t, {
        projectSourceDirectory: sourceDirectory,
        diagnosticImport: checkpoint,
      }),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    await measure("warm.preparation.release", () =>
      f.runRelease(f.owner.preparationEnvironment),
    );
    const first = f.owner.complete();
    assert.equal(first.kind, "installed");
    if (first.kind !== "installed") return;
    await measure("warm.first.release", () =>
      f.runRelease(first.runtime.release),
    );
    const bridge = await measure("warm.main.prepareProjectBridge", () =>
      f.prepareProjectBridge(first.runtime.expectedCatalogEntries[0]!),
    );
    await measure("warm.bridge.preparation.release", () =>
      f.runRelease(bridge.preparationEnvironment),
    );
    const prepared = bridge.complete();
    assert.equal(prepared.kind, "installed");
    if (prepared.kind !== "installed") return;
    await measure("warm.prepared.release", () =>
      f.runRelease(prepared.runtime.release),
    );
    const start = async (runtime: typeof prepared.runtime) => {
      const current = await startDesktopInstalledPluginRuntimeChildren({
        runtime,
        signal: new AbortController().signal,
        spawnWorker: (environment) => f.start("worker", environment),
        spawnControl: (environment) => f.start("control", environment),
        trackChild: () => {},
        deadlineMs: 20_000,
      });
      await f.waitForControl(current.control);
      return current;
    };
    const current = await measure("warm.runtime.start", () =>
      start(prepared.runtime),
    );
    const client = new ControlApiClient({
      baseUrl: `http://127.0.0.1:${f.port}/`,
      accessToken: f.sessionToken,
      csrfToken: f.environment.CREWON_CONTROL_CSRF_TOKEN!,
      origin: f.environment.CREWON_CONTROL_ORIGIN!,
    });
    for (const plugin of [f.identity, f.projectSource!.identity]) {
      try {
        await measure(
          plugin === f.identity ? "warm.enable.target" : "warm.enable.source",
          () =>
            setDesktopPluginSelectionWithNativeBusinessActivation({
              runtime: prepared.runtime,
              client,
              command: {
                pluginId: plugin.pluginId,
                request: {
                  expectedSelectionRevision: 1,
                  state: "enabled",
                  selectedPackageDigest: plugin.packageDigest,
                },
                idempotencyKey: `native-cold-enable-${plugin.pluginId}`,
              },
              signal: new AbortController().signal,
            }),
        );
      } catch (error) {
        throw new Error(
          `Native enable failed: ${error instanceof Error ? error.message : "unknown"}; external attempt=${await readFile(networkMarker, "utf8").catch(() => "none")}; Worker diagnostics=${f.logs(current.worker).stderr}`,
          { cause: error },
        );
      }
    }
    const post = async (path: string, input: object, key?: string) => {
      const response = await fetch(`http://127.0.0.1:${f.port}${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "authorization": `Bearer ${f.sessionToken}`,
          "origin": f.environment.CREWON_CONTROL_ORIGIN!,
          "x-csrf-token": f.environment.CREWON_CONTROL_CSRF_TOKEN!,
          "content-type": "application/json",
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        body: JSON.stringify(input),
      });
      return { status: response.status, body: await response.text() };
    };
    const success = async (path: string, input: object, key?: string) => {
      const response = await post(path, input, key);
      assert.equal(response.status, 200, response.body);
      return JSON.parse(response.body);
    };
    const thread = (
      await measure("warm.http.thread.create", () =>
        client.createThread(
          { title: "Original Native cold acknowledgement", workspaceId: null },
          "native-cold-thread",
        ),
      )
    ).thread;
    const mount = () =>
      success("/api/v1/plugins/ui/mounts", {
        pluginId: f.projectSource!.identity.pluginId,
        contributionId: "workbench",
        expectedSelectionRevision: 2,
        expectedPackageDigest: f.projectSource!.identity.packageDigest,
      });
    const lease = await measure("warm.http.mount", mount);
    const action = (mountRef: string, action: string, input: object) =>
      success(`/api/v1/plugins/ui/mounts/${mountRef}/actions`, {
        action,
        input,
      });
    const project = (
      await measure("warm.http.project.create", () =>
        action(lease.mountRef, "crewon.creative-projects.v1.createProject", {
          request: {
            title: "Original cold receipt",
            briefText: "No inference",
          },
          idempotencyKey: "native-cold-project",
        }),
      )
    ).output;
    const concept = (
      await measure("warm.http.concept.create", () =>
        action(lease.mountRef, "crewon.creative-projects.v1.createConcept", {
          projectId: project.project.projectId,
          request: {
            briefRevision: project.brief.briefRevision,
            name: "Confirmed input",
            prompt: "A quiet garden in morning light",
            expectedProjectRevision: project.project.revision,
          },
          idempotencyKey: "native-cold-concept",
        }),
      )
    ).output;
    const request = {
      action: "crewon.project-generations.v1.generateConcept" as const,
      input: {
        reference: {
          projectId: project.project.projectId,
          assetId: concept.asset.assetId,
          assetRevision: concept.assetRevision.assetRevision,
          expectedProjectRevision: concept.project.revision,
          expectedAssetMetadataRevision: concept.asset.revision,
        },
        threadId: thread.threadId,
        expectedThreadRevision: thread.revision,
        idempotencyKey: "native-cold-original-generation",
      },
    };
    assert.equal(
      (
        await measure("warm.http.recovery.stage", () =>
          client.plugins.stageRecovery(lease.mountRef, request),
        )
      ).intent.phase,
      "prepared",
    );
    const lost = await measure("warm.http.generation.actions", () =>
      post(`/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`, request),
    );
    assert.equal(lost.status, 500, lost.body);
    assert.equal(JSON.parse(lost.body).error.code, "plugin_ui_unavailable");
    assert.deepEqual(JSON.parse(await readFile(faultMarker, "utf8")), {
      originalCommitVerified: true,
    });
    const readState = () => {
      const db = new DatabaseSync(f.databasePath, { readOnly: true });
      try {
        const intent = JSON.parse(
          db.prepare("SELECT record_json FROM plugin_ui_intents").get()!
            .record_json as string,
        );
        const receiptRow = db
          .prepare(
            "SELECT result_json FROM extension_mutation_receipts WHERE kind='task'",
          )
          .get()!;
        const receipt = JSON.parse(receiptRow.result_json as string);
        return {
          intent,
          receipt,
          counts: Object.fromEntries(
            [
              "run_snapshots",
              "plugin_task_admissions",
              "plugin_task_unmetered_admissions",
              "creative_project_generation_links",
              "extension_external_operations",
            ].map((table) => [
              table,
              db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
            ]),
          ),
        };
      } finally {
        db.close();
      }
    };
    const before = readState();
    assert.equal(before.intent.phase, "dispatched");
    assert.equal(before.intent.dispatchAttemptCount, 1);
    assert.equal(before.intent.receiptJson, null);
    assert.equal(before.receipt.creditAdmission, undefined);
    assert.ok(before.receipt.unmeteredAdmission);
    assert.deepEqual(before.counts, {
      run_snapshots: 1,
      plugin_task_admissions: 1,
      plugin_task_unmetered_admissions: 1,
      creative_project_generation_links: 1,
      extension_external_operations: 0,
    });
    await measure("warm.control.close", () =>
      terminateRuntimeChild(current.control),
    );
    await measure("warm.worker.close", () =>
      terminateRuntimeChild(current.worker),
    );
    const coldOwner = await measure("cold.main.prepareProjectBridge", () =>
      f.prepareProjectBridge(prepared.runtime.expectedCatalogEntries[0]!),
    );
    await measure("cold.preparation.release", () =>
      f.runRelease(coldOwner.preparationEnvironment),
    );
    const coldPrepared = coldOwner.complete();
    assert.equal(coldPrepared.kind, "installed");
    if (coldPrepared.kind !== "installed") return;
    await measure("cold.prepared.release", () =>
      f.runRelease(coldPrepared.runtime.release),
    );
    const cold = await measure("cold.runtime.start", () =>
      start(coldPrepared.runtime),
    );
    t.after(() => {
      t.diagnostic(
        JSON.stringify({
          phase: "fixture.cleanup",
          runtimeChildrenPhysicallyJoined: [
            current.control,
            current.worker,
            cold.control,
            cold.worker,
          ].every(
            (child) => child.exitCode !== null || child.signalCode !== null,
          ),
        }),
      );
    });
    assert.notEqual(cold.control.pid, current.control.pid);
    assert.notEqual(cold.worker.pid, current.worker.pid);
    const coldLease = await measure("cold.http.mount", mount);
    assert.notEqual(coldLease.mountRef, lease.mountRef);
    const hints = await measure("cold.http.recovery.get", () =>
      client.plugins.getRecovery(coldLease.mountRef),
    );
    assert.equal(hints.intents.length, 1);
    assert.equal(hints.intents[0]!.phase, "dispatched");
    assert.equal(hints.intents[0]!.retryable, true);
    assert.deepEqual(hints.intents[0]!.request, request);
    assert.deepEqual(readState().intent, before.intent);
    assert.deepEqual(readState().counts, before.counts);
    const restaged = await measure("cold.http.recovery.stage.replay", () =>
      client.plugins.stageRecovery(coldLease.mountRef, request),
    );
    assert.equal(restaged.disposition, "replayed");
    const replay = await measure("cold.http.generation.actions.replay", () =>
      post(`/api/v1/plugins/ui/mounts/${coldLease.mountRef}/actions`, request),
    );
    assert.equal(
      replay.status,
      200,
      `${replay.body}\n${f
        .logs(cold.control)
        .stderr.split("\n")
        .filter((line) => line.startsWith("OWNED_NATIVE_COLD_RECOVERY"))
        .join("\n")}`,
    );
    const output = JSON.parse(replay.body).output;
    assert.equal(output.runId, before.receipt.binding.runId);
    assert.equal(output.threadId, request.input.threadId);
    assert.equal(
      output.threadRevision,
      request.input.expectedThreadRevision + 1,
    );
    assert.equal(output.messageId, before.receipt.turn.messages[0].messageId);
    const after = readState();
    assert.deepEqual(after.counts, before.counts);
    assert.deepEqual(after.receipt, before.receipt);
    assert.equal(after.intent.phase, "accepted");
    assert.equal(after.intent.dispatchAttemptCount, 2);
    assert.equal(after.intent.rawIdempotencyKey, request.input.idempotencyKey);
    assert.deepEqual(JSON.parse(after.intent.receiptJson), output);
    assert.equal(
      (
        await measure("cold.http.recovery.accepted.get", () =>
          client.plugins.getRecovery(coldLease.mountRef),
        )
      ).intents[0]!.phase,
      "accepted",
    );
    assert.equal(await readFile(networkMarker, "utf8").catch(() => null), null);
    assert.ok(
      (await f.audit()).every((entry) =>
        entry.origin.startsWith("http://127.0.0.1:"),
      ),
    );
    t.diagnostic(
      `Original actions HTTP 500 after genuine COMMIT; cold GET recovery and POST stage replay retain the exact request; explicit same-key POST actions HTTP 200 restores original Run ${output.runId}; accepted journal, one Run/funding/link and zero model/supplier requests.`,
    );
  },
);
