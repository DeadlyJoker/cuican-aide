import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  RunExecutionService,
  ThreadApplicationService,
  TurnApplicationService,
} from "@crewon/application";
import {
  captureDesktopNativePluginPolicy,
  createDesktopNativePluginAuthority,
} from "../../../crewon-ui/electron/desktopNativePluginAuthority.ts";
import { composeDesktopLocalPluginProjectApproval } from "../../../crewon-ui/electron/desktopLocalPluginProjectApproval.ts";
import {
  executionSetupFixture,
  fixtureHash,
} from "../../../crewon-ui/electron/desktopLocalPluginExecutionSetup.test-support.ts";
import {
  assertDesktopPluginBootstrapIssued,
  parseDesktopPluginApproval,
} from "../../../crewon-ui/electron/desktopPluginBootstrap.ts";
import { loadInstalledPluginAuthorityConfig } from "./installed-plugin-authority-config.ts";
import { createInstalledPluginWorkerAuthority } from "./installed-plugin-worker-authority.ts";

/** Real Main producers and immutable/SQLite metadata. The Node/UI entries throw if imported. */
export async function nativePlanningFixture(t: TestContext) {
  const f = await executionSetupFixture({
    version: "18.0.0",
    projectContext: true,
  });
  let native: ReturnType<typeof open> | null = null;
  const owned = new Set<{ close(): Promise<void> }>();
  t.after(async () => {
    await Promise.all([...owned].map((owner) => owner.close()));
    await native?.close();
    await f.cleanup();
  });
  const approval = composeDesktopLocalPluginProjectApproval({
    approval: parseDesktopPluginApproval(f.approval),
    descriptor: f.installed.descriptor,
    packageDigest: f.identity.packageDigest,
  });
  await f.stop();
  writeFileSync(f.approvalPath, JSON.stringify(approval), { mode: 0o600 });
  await f.start();
  const setup = f.create(),
    preview = await setup.preview({
      bootstrap: f.bootstrap,
      pluginId: f.identity.pluginId,
    });
  const setupClaim = setup.claimPreview({
    previewId: preview.previewId,
    approveExecution: true,
  });
  await f.stop();
  await setup.commitPolicyWhileStopped(setupClaim);
  await f.start();
  const bootstrap = assertDesktopPluginBootstrapIssued(f.bootstrap);
  assert.equal(bootstrap.schemaVersion, "crewon.desktop-plugin-bootstrap.v2");
  assert.ok("projects" in bootstrap && bootstrap.projects.textPlans);
  const actor = bootstrap.actor,
    clock = { now: () => new Date().toISOString() };
  let ids = 0;
  const dependencies = {
    store: f.store,
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    clock,
    ids: { nextId: (kind: string) => `native-planning-${kind}-${++ids}` },
    digester: { sha256: fixtureHash },
  };
  await f.store.extensionStore().migratePluginAdmissions();
  const threads = new ThreadApplicationService(dependencies);
  const thread = await threads.createThread(actor, {
    kind: "thread.create",
    title: null,
    workspaceId: null,
    idempotencyKey: "native-planning-ordinary-thread",
  });
  const turn = await new TurnApplicationService(dependencies).startTurn(actor, {
    kind: "turn.start",
    threadId: thread.state.threadId,
    expectedThreadRevision: thread.state.revision,
    content: "讨论雨夜来信的两集短剧计划。",
    requestedAgentVersionId: "native-planning-default-agent",
    executionIntent: "none",
    toolPermissionMode: "requestApproval",
    idempotencyKey: "native-planning-ordinary-turn",
    route: {
      authorityId: "native-planning-original-kernel",
      runtimeGeneration: "native-planning-generation",
      agentVersionId: "native-planning-default-agent",
      policySnapshotId: "native-planning-policy",
      workspaceBindingId: null,
    },
  });
  const claim = await f.store.claimNextWorkItem({
    ownerId: "native-planning-worker",
    leaseId: "native-planning-lease",
    leaseDurationMs: 60000,
  });
  assert.ok(claim);
  assert.equal(claim.workItem.runId, turn.runState.runId);
  const execution = new RunExecutionService(dependencies);
  await execution.startRun(claim);
  const run = await execution.loadRun(claim);
  native = open();

  function open() {
    const policy = captureDesktopNativePluginPolicy(
      f.dataDirectory,
      f.bootstrap,
    );
    assert.ok(policy);
    const main = createDesktopNativePluginAuthority({
      dataDirectory: f.dataDirectory,
      bootstrap: f.bootstrap,
      policy,
    });
    const path = join(f.dataDirectory, "planning-worker.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: "crewon.installed-plugin-native-worker.v1",
        installRoot: main.authority.installRoot,
        releaseDocumentPath: join(f.dataDirectory, "no-node-preparation.json"),
        nativeAuthorityPath: main.path,
        historicalScope: null,
        timeoutMs: 1000,
      }),
      { mode: 0o600 },
    );
    try {
      const worker = createInstalledPluginWorkerAuthority(
        loadInstalledPluginAuthorityConfig(path, {}),
      );
      assert.ok(worker.projectPlanning);
      return {
        main,
        worker,
        port: worker.projectPlanning,
        async close() {
          await worker.close();
          main.close();
        },
      };
    } catch (error) {
      main.close();
      throw error;
    }
  }
  return {
    f,
    actor,
    run,
    claim,
    execution,
    own: <T extends { close(): Promise<void> }>(owner: T): T => {
      owned.add(owner);
      return owner;
    },
    get native() {
      return native!;
    },
    read: () =>
      native!.port.readCapabilities({
        run,
        claim,
        signal: new AbortController().signal,
      }),
    select: async (state: "enabled" | "disabled") => {
      const current = await f.store.pluginInstallationStore().loadSelection({
        scope: f.scope,
        pluginId: f.identity.pluginId,
      });
      assert.ok(current);
      await f.store.pluginInstallationStore().commitSelection({
        scope: f.scope,
        actor,
        expectedSelectionRevision: current.revision,
        selection: {
          ...current,
          revision: current.revision + 1,
          state,
          updatedAt: clock.now(),
          updatedByActorId: actor.actorId,
          updatedByPrincipalId: actor.principalId,
        },
        receipt: {
          idempotencyKey: `native-planning-selection-${current.revision + 1}`,
          requestDigest: fixtureHash(
            `native-planning-selection-${current.revision + 1}`,
          ),
        },
      });
    },
    cold: async () => {
      const previous = native!;
      await previous.close();
      native = null;
      await f.stop();
      await f.start();
      native = open();
      return previous.port;
    },
  };
}
