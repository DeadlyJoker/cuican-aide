import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { nativePlanningFixture } from "./native-project-planning-runtime.test-support.ts";
import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import { RuntimeWorker } from "../runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "../standalone-adapters.ts";
import { parseProjectPlanningProposal } from "@crewon/contracts/project-planning";
import { parseDesktopProjectExecutionConfiguration } from "@crewon/contracts/plugins";
import { assertDesktopPluginBootstrapIssued } from "../../../crewon-ui/electron/desktopPluginBootstrap.ts";
import { createNativeProjectPlanningRuntime } from "./native-project-planning-runtime.ts";

test("actual Main metadata approval and sealed principal discover enabled immutable Short18 without loading Node or claiming execution readiness", async (t) => {
  const f = await nativePlanningFixture(t);
  assert.equal(f.native.port.canPublish(f.run), true);
  assert.deepEqual(await f.read(), []);
  assert.equal(
    await f.native.worker.installedPluginExecution.authorizePackage(
      {
        candidate: {
          descriptor: f.f.installed.descriptor,
          packageDigest: f.f.identity.packageDigest,
        },
        scope: f.f.scope,
        purpose: "submit",
      },
      new AbortController().signal,
    ),
    "deny",
  );
  await f.select("enabled");
  const capabilities = await f.read();
  assert.equal(capabilities.length, 1);
  assert.deepEqual(capabilities[0]!.source, {
    ...f.f.identity,
    contributionId: "workbench",
  });
  assert.equal(capabilities[0]!.moduleAvailable, true);
  assert.equal(capabilities[0]!.textPlansAvailable, true);
  assert.equal(capabilities[0]!.executionReady, false);
  const oldPort = await f.cold();
  assert.equal(oldPort.canPublish(f.run), false);
  await assert.rejects(async () =>
    oldPort.readCapabilities({
      run: f.run,
      claim: f.claim,
      signal: new AbortController().signal,
    }),
  );
  assert.deepEqual(await f.read(), capabilities);
  const database = new DatabaseSync(join(f.f.dataDirectory, "control.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM run_snapshots").get()!.n,
      1,
    );
    for (const table of [
      "plugin_task_admissions",
      "plugin_query_task_admissions",
      "creative_projects",
      "project_text_plans",
      "extension_external_operations",
      "plugin_credit_reservations",
    ]) {
      const present = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (present)
        assert.equal(
          database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
          0,
        );
    }
  } finally {
    database.close();
  }
});

test("actual Native producer rejects foreign Run owner and aborted claims, suppresses disabled metadata, and refuses changed installed bytes", async (t) => {
  const f = await nativePlanningFixture(t);
  await f.select("enabled");
  const foreign = { ...f.run, createdByActorId: "another-actor" };
  assert.equal(f.native.port.canPublish(foreign), false);
  await assert.rejects(
    f.native.port.readCapabilities({
      run: foreign,
      claim: f.claim,
      signal: new AbortController().signal,
    }),
    /project_planning_owner_invalid/u,
  );
  const aborted = new AbortController();
  aborted.abort(new Error("native_planning_claim_withdrawn"));
  await assert.rejects(
    async () =>
      f.native.port.readCapabilities({
        run: f.run,
        claim: f.claim,
        signal: aborted.signal,
      }),
    /native_planning_claim_withdrawn/u,
  );
  assert.equal((await f.read()).length, 1);
  await f.select("disabled");
  assert.deepEqual(await f.read(), []);
  await f.select("enabled");
  const asset = join(
    f.native.main.authority.installRoot,
    "packages",
    f.f.identity.packageDigest.slice(7),
    "ui.mjs",
  );
  const original = readFileSync(asset);
  chmodSync(asset, 0o600);
  writeFileSync(
    asset,
    Buffer.from("throw new Error('changed_metadata_only_asset');"),
  );
  await assert.rejects(f.read());
  writeFileSync(asset, original);
  chmodSync(asset, 0o444);
  assert.equal((await f.read()).length, 1);
});

test("an actual ordinary Kernel consumes the Main-issued metadata port and persists only a proposal through its original Run", async (t) => {
  const f = await nativePlanningFixture(t);
  await f.select("enabled");
  await f.f.store.retryWorkItem({
    workItemId: f.claim.workItem.workItemId,
    ownerId: f.claim.lease.ownerId,
    leaseId: f.claim.lease.leaseId,
    leaseEpoch: f.claim.lease.epoch,
    retryAfterMs: 0,
    reasonCode: "named_metadata_fixture_releases_original_claim",
  });
  let samples = 0;
  const transport: ModelTransportPort = {
    adapterName: "named-model-with-real-native-metadata",
    adapterVersion: "1",
    modelId: "named-model",
    async *stream(request) {
      samples++;
      assert.ok(
        request.tools.some(
          (tool) => tool.name === "crewon_project_capabilities",
        ),
      );
      const last = request.input.items
        .filter((item) => item.type === "tool_result")
        .at(-1);
      if (!last || last.type !== "tool_result") {
        yield {
          type: "tool.call",
          kind: "function",
          callId: "native-discovery",
          name: "crewon_project_capabilities",
          input: "{}",
        };
      } else if (last.callId === "native-discovery") {
        const capabilities = JSON.parse(last.output).capabilities;
        assert.equal(capabilities.length, 1);
        assert.equal(capabilities[0].executionReady, false);
        yield {
          type: "tool.call",
          kind: "function",
          callId: "native-proposal",
          name: "crewon_project_propose",
          input: JSON.stringify({
            capabilityId: capabilities[0].capabilityId,
            title: "雨夜来信",
            briefText: "摄影师收到父亲的旧信。",
            instruction: "先审阅两集创作建议。",
            start: "brief",
            target: "script",
            episodeCount: 2,
            adoption: "manual",
          }),
        };
      } else {
        const proposal = parseProjectPlanningProposal(JSON.parse(last.output));
        assert.equal(proposal.origin.runId, f.run.runId);
        assert.equal(proposal.origin.threadId, f.run.threadId);
        assert.equal(proposal.origin.callId, "native-proposal");
        assert.equal(
          proposal.capability.source.packageDigest,
          f.f.identity.packageDigest,
        );
        yield { type: "output.delta", delta: "请在实际工作台确认建议。" };
      }
      yield { type: "completed", checkpoint: null };
    },
  };
  let lease = 0;
  const worker = f.own(
    new RuntimeWorker(
      {
        store: f.f.store,
        execution: f.execution,
        kernel: new CrewONAgentKernel({ transport, streamMaxRetries: 0 }),
        policy: new PinnedRunExecutionPolicy({
          authorityId: f.run.authorityId,
          runtimeGeneration: f.run.runtimeGeneration,
          agentVersionId: f.run.agentVersionId,
          policySnapshotId: f.run.policySnapshotId,
          workspaceBindingId: f.run.workspaceBindingId,
        }),
        projectPlanning: f.native.port,
      },
      {
        ownerId: "native-planning-original-worker",
        nextLeaseId: () => `native-planning-next-lease-${++lease}`,
        leaseDurationMs: 10000,
        retryAfterMs: 0,
        scanIntervalMs: null,
      },
    ),
  );
  const outcome = await worker.wake();
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.equal(samples, 3);
  const locator = { tenantId: f.actor.tenantId, runId: f.run.runId };
  const events = await f.f.store.listRunEvents(locator, 0, 1000);
  const proposals = events.filter(
    (event) =>
      event.type === "tool.completed" &&
      event.data.name === "crewon_project_propose",
  );
  assert.equal(proposals.length, 1);
  const proposal = proposals[0]!;
  assert.ok(proposal.type === "tool.completed");
  assert.equal(proposal.data.isError, false);
  assert.equal(proposal.data.outputTruncated, false);
  assert.ok(Buffer.byteLength(proposal.data.output) <= 8192);
  await worker.close();
  await f.cold();
  assert.deepEqual(await f.f.store.listRunEvents(locator, 0, 1000), events);
  const admission = await f.f.store.extensionStore().loadPluginTaskAdmission({
    ...locator,
    spaceId: f.actor.spaceId,
  });
  assert.equal(admission, null);
});

test("named prepared-target ports affect only the readiness hint while discovery retains actual Main principal and immutable SQLite metadata", async (t) => {
  const f = await nativePlanningFixture(t);
  await f.select("enabled");
  const bootstrap = assertDesktopPluginBootstrapIssued(f.f.bootstrap);
  assert.ok("projects" in bootstrap);
  const source = {
    pluginId: f.f.identity.pluginId,
    packageDigest: f.f.identity.packageDigest,
    contributionId: "workbench",
  };
  const projects = parseDesktopProjectExecutionConfiguration(
    {
      ...bootstrap.projects,
      version: "crewon.desktop-project-execution.v1",
      pluginGenerations: {
        publications: [
          {
            source,
            target: { ...source, action: "project.execute" },
          },
        ],
      },
    },
    { publications: bootstrap.publications },
  );
  type Owner = Parameters<typeof createNativeProjectPlanningRuntime>[0];
  let prepared = false,
    targetReads = 0;
  // This named release/target pair does not claim a Main Node preparation or issue a Run grant.
  const namedRelease = {
    entries: [
      {
        packageIdentity: f.f.identity,
        configuration: f.f.configuration,
        target: f.f.entry.configuredTarget,
      },
    ],
  } as unknown as ReturnType<Owner["release"]>;
  const port = createNativeProjectPlanningRuntime({
    actor: f.native.main.authority.actor,
    scope: f.native.main.authority.scope,
    projects,
    installRoot: f.native.main.authority.installRoot,
    store: f.f.store,
    current(signal) {
      signal?.throwIfAborted();
      f.native.main.assertCurrent();
    },
    async operate(work, signal) {
      signal?.throwIfAborted();
      f.native.main.assertCurrent();
      const result = await work();
      signal?.throwIfAborted();
      f.native.main.assertCurrent();
      return result;
    },
    release: () => namedRelease,
    async target(identity, configuration, target, purpose) {
      targetReads++;
      assert.deepEqual(identity, f.f.identity);
      assert.deepEqual(configuration, f.f.configuration);
      assert.deepEqual(target, f.f.entry.configuredTarget);
      assert.equal(purpose, "submit");
      return prepared;
    },
  });
  const input = {
    run: f.run,
    claim: f.claim,
    signal: new AbortController().signal,
  };
  const before = await port.readCapabilities(input);
  assert.equal(before[0]!.executionReady, false);
  prepared = true;
  const after = await port.readCapabilities(input);
  assert.equal(after[0]!.executionReady, true);
  assert.equal(after[0]!.capabilityId, before[0]!.capabilityId);
  assert.deepEqual(after[0]!.source, before[0]!.source);
  prepared = false;
  assert.deepEqual(await port.readCapabilities(input), before);
  assert.equal(targetReads, 3);
  assert.equal(
    await f.f.store.extensionStore().loadPluginTaskAdmission({
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      runId: f.run.runId,
    }),
    null,
  );
});
