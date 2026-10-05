import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_TEXT_RECOVERY_METHOD_ACTIONS,
  type ProjectTextRecoveryPendingResponse,
  type ProjectTextRecoveryAcknowledgementResponse,
} from "@crewon/contracts/project-text-recovery";
import {
  PROJECT_TEXT_UI_METHOD_ACTIONS,
  type ProjectTextMutationResponse,
} from "@crewon/contracts/project-texts-ui";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import { PluginProjectTextRecoveryApplicationService } from "./plugin-project-text-recovery-application-service.ts";
import { PluginProjectTextActionOwner } from "./plugin-project-text-action-owner.ts";
import { isPluginProjectTextRecoveryActionOwner } from "./plugin-project-text-recovery-action-owner.ts";
import { projectTextRecoveryFixture } from "./plugin-project-text-recovery.test-support.ts";
import {
  outlineContent,
  scriptContent,
  sha256,
} from "./project-text.test-support.ts";
import {
  uiTestActor,
  uiTestMountCommand,
  uiDeferred,
} from "./plugin-ui.test-support.ts";
import {
  capturePluginProjectTextRecoveryInvocationCommitAuthority,
  capturePluginProjectTextUiInvocationCommitAuthority,
  capturePluginUiInvocationCommitAuthority,
} from "./plugin-ui-invocation-authority.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
const candidate = (projectId: string, key = "once") => ({
  projectId,
  request: {
    expectedArtifactRevision: 0,
    briefRevision: 1,
    content: outlineContent,
  },
  idempotencyKey: key,
});
test("four actual manual writes stage before commit, share real candidates, and ACK before the next intent", async (t) => {
  const f = await projectTextRecoveryFixture();
  t.after(f.close);
  const projectId = f.project.projectId;
  assert.equal(isPluginProjectTextRecoveryActionOwner(f.recoveryOwner), true);
  assert.equal(
    f.recoveryOwner.supportsAction(
      "crewon.project-texts.v1.saveOutlineCandidate",
    ),
    false,
  );
  const ack = async () => {
    const { intent } = (await f.recover("getPending", {
      projectId,
    })) as unknown as ProjectTextRecoveryPendingResponse;
    assert.equal(intent!.phase, "accepted");
    const response = (await f.recover("acknowledge", {
      projectId,
      intentId: intent!.intentId,
      expectedRevision: intent!.revision,
    })) as unknown as ProjectTextRecoveryAcknowledgementResponse;
    assert.equal(response.disposition, "acknowledged");
    return intent!;
  };
  f.store.beforeCommit = async () => {
    assert.equal(f.state.record!.phase, "pending");
  };
  const saved = (await f.invoke(
    "saveOutlineCandidate",
    candidate(projectId),
  )) as unknown as ProjectTextMutationResponse;
  assert.equal(saved.disposition, "committed");
  const first = await ack();
  assert.equal(
    first.request.action,
    PROJECT_TEXT_UI_METHOD_ACTIONS.saveOutlineCandidate,
  );
  const artifactId = saved.artifact.artifactId;
  await f.invoke("selectRevision", {
    projectId,
    artifactId,
    request: { expectedArtifactRevision: 1, contentRevision: 1 },
    idempotencyKey: "select",
  });
  await ack();
  await f.invoke("saveScriptCandidate", {
    projectId,
    episodeId: "ep-1",
    request: {
      expectedArtifactRevision: 0,
      briefRevision: 1,
      outline: { artifactId, contentRevision: 1 },
      content: scriptContent,
    },
    idempotencyKey: "script",
  });
  await ack();
  await f.invoke("setLocked", {
    projectId,
    artifactId,
    request: { expectedArtifactRevision: 2, locked: true },
    idempotencyKey: "lock",
  });
  await ack();
  assert.equal(f.store.commits.length, 4);
  assert.equal(f.state.stageCalls, 4);
  assert.deepEqual(await f.recover("getPending", { projectId }), {
    intent: null,
  });
});
test("lost confirmed reply survives a new actual owner/mount and original key replay keeps one candidate", async (t) => {
  const f = await projectTextRecoveryFixture();
  t.after(f.close);
  const input = candidate(f.project.projectId);
  f.state.dropReply = true;
  await assert.rejects(f.invoke("saveOutlineCandidate", input));
  assert.equal(f.store.commits.length, 1);
  assert.equal(f.state.record!.phase, "accepted");
  await f.close();
  f.state.dropReply = false;
  const cold = f.createOwners();
  t.after(() =>
    Promise.all([cold.textOwner.close(), cold.recoveryOwner.close()]),
  );
  const lease = await cold.service.openMount(uiTestActor, uiTestMountCommand);
  const call = (action: string, input: unknown) =>
    cold.service.invoke(uiTestActor, {
      mountRef: lease.mountRef,
      action,
      input: input as never,
    });
  const pending = (await call(PROJECT_TEXT_RECOVERY_METHOD_ACTIONS.getPending, {
    projectId: f.project.projectId,
  })) as unknown as ProjectTextRecoveryPendingResponse;
  assert.deepEqual(pending.intent!.request, {
    action: PROJECT_TEXT_UI_METHOD_ACTIONS.saveOutlineCandidate,
    input,
  });
  const replay = (await call(
    PROJECT_TEXT_UI_METHOD_ACTIONS.saveOutlineCandidate,
    input,
  )) as unknown as ProjectTextMutationResponse;
  assert.equal(replay.disposition, "replayed");
  assert.equal(f.store.commits.length, 1);
  await call(PROJECT_TEXT_RECOVERY_METHOD_ACTIONS.acknowledge, {
    projectId: f.project.projectId,
    intentId: pending.intent!.intentId,
    expectedRevision: pending.intent!.revision,
  });
  assert.equal(f.state.record!.acknowledgedAt !== null, true);
});
test("pending cannot ACK or accept another key; the original full input stays recoverable", async (t) => {
  const f = await projectTextRecoveryFixture();
  t.after(f.close);
  const entered = uiDeferred(),
    release = uiDeferred();
  f.store.beforeCommit = async () => {
    entered.resolve();
    await release.promise;
  };
  const input = candidate(f.project.projectId),
    write = f.invoke("saveOutlineCandidate", input);
  await entered.promise;
  const { intent } = (await f.recover("getPending", {
    projectId: f.project.projectId,
  })) as unknown as ProjectTextRecoveryPendingResponse;
  assert.equal(intent!.phase, "pending");
  assert.deepEqual(intent!.request.input, input);
  await assert.rejects(
    f.recover("acknowledge", {
      projectId: f.project.projectId,
      intentId: intent!.intentId,
      expectedRevision: intent!.revision,
    }),
    { code: "project_text_ui_intent_pending" },
  );
  await assert.rejects(
    f.invoke(
      "saveOutlineCandidate",
      candidate(f.project.projectId, "different"),
    ),
    { code: "project_text_ui_intent_pending" },
  );
  assert.equal(f.store.commits.length, 0);
  release.resolve();
  await write;
  assert.equal(f.store.commits.length, 1);
});
test("exact invocation membership precedes field reads; copied, old text, Run and completed contexts cannot ACK", async (t) => {
  const f = await projectTextRecoveryFixture();
  t.after(f.close);
  let getters = 0;
  const forged = {};
  Object.defineProperty(forged, "actor", {
    get: () => {
      getters++;
      return uiTestActor;
    },
  });
  await assert.rejects(
    f.recoveryOwner.actions.invoke(forged as PluginUiActionContext),
    { code: "plugin_project_text_recovery_transaction_required" },
  );
  assert.equal(getters, 0);
  await f.recover("getPending", { projectId: f.project.projectId });
  const context = f.state.contexts.at(-1)!;
  assert.throws(
    () =>
      capturePluginProjectTextRecoveryInvocationCommitAuthority({ ...context }),
    { code: "plugin_project_text_recovery_transaction_required" },
  );
  await assert.rejects(f.recoveryOwner.actions.invoke(context), {
    code: "plugin_project_text_recovery_transaction_required",
  });
  assert.equal(f.state.ackCalls, 0);
  // While genuinely dispatched, the three qualification families remain mutually exclusive.
  const entered = uiDeferred(),
    release = uiDeferred();
  f.state.beforeRead = async () => {
    const actual = f.state.contexts.at(-1)!;
    assert.equal(
      capturePluginUiInvocationCommitAuthority(actual).transaction,
      undefined,
    );
    assert.throws(() =>
      capturePluginProjectTextUiInvocationCommitAuthority(actual),
    );
    assert.equal(
      capturePluginProjectTextRecoveryInvocationCommitAuthority(actual)
        .recoveryTransaction.actionId,
      PROJECT_TEXT_RECOVERY_METHOD_ACTIONS.getPending,
    );
    entered.resolve();
    await release.promise;
  };
  const read = f.recover("getPending", { projectId: f.project.projectId });
  await entered.promise;
  release.resolve();
  await read;
});
test("independent project PDP and host withdrawal retain the journal and prevent ACK publication", async (t) => {
  const f = await projectTextRecoveryFixture();
  t.after(f.close);
  await f.invoke("saveOutlineCandidate", candidate(f.project.projectId));
  const record = f.state.record!;
  f.state.denyWrite = true;
  await assert.rejects(
    f.recover("acknowledge", {
      projectId: f.project.projectId,
      intentId: record.intentId,
      expectedRevision: record.revision,
    }),
    { code: "creative_project_authorization_denied" },
  );
  assert.equal(f.state.ackCalls, 0);
  assert.equal(
    (
      (await f.recover("getPending", {
        projectId: f.project.projectId,
      })) as unknown as ProjectTextRecoveryPendingResponse
    ).intent!.phase,
    "accepted",
  );
  f.textState.projectAllowed = false;
  await assert.rejects(
    f.recover("getPending", { projectId: f.project.projectId }),
  );
  assert.equal(f.state.record!.acknowledgedAt, null);
});
test("recovery close withdraws synchronously and physically joins an in-flight read", async () => {
  const f = await projectTextRecoveryFixture();
  const entered = uiDeferred(),
    release = uiDeferred();
  f.state.beforeRead = async () => {
    entered.resolve();
    await release.promise;
  };
  const read = f.recover("getPending", { projectId: f.project.projectId });
  await entered.promise;
  let joined = false;
  const closing = f.recoveryOwner.close().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  await assert.rejects(
    f.recover("getPending", { projectId: f.project.projectId }),
    { code: "plugin_project_text_recovery_actions_unavailable" },
  );
  release.resolve();
  await assert.rejects(read);
  await closing;
  await f.textOwner.close();
  assert.equal(joined, true);
});
test("confirmed ACK remains deliverable after local close and original same CAS key replays without another transition", async (t) => {
  const f = await projectTextRecoveryFixture();
  t.after(f.close);
  await f.invoke("saveOutlineCandidate", candidate(f.project.projectId));
  const record = f.state.record!,
    input = {
      projectId: f.project.projectId,
      intentId: record.intentId,
      expectedRevision: record.revision,
    };
  f.state.afterAck = () => {
    void f.recoveryOwner.close();
    f.ui.state.allowed.delete("invoke");
  };
  const response = (await f.recover(
    "acknowledge",
    input,
  )) as unknown as ProjectTextRecoveryAcknowledgementResponse;
  assert.equal(response.disposition, "acknowledged");
  assert.equal(response.revision, record.revision + 1);
  f.ui.state.allowed.add("invoke");
  f.state.afterAck = null;
  const cold = f.createOwners();
  t.after(() =>
    Promise.all([cold.textOwner.close(), cold.recoveryOwner.close()]),
  );
  const lease = await cold.service.openMount(uiTestActor, uiTestMountCommand);
  const replay = (await cold.service.invoke(uiTestActor, {
    mountRef: lease.mountRef,
    action: PROJECT_TEXT_RECOVERY_METHOD_ACTIONS.acknowledge,
    input,
  })) as unknown as ProjectTextRecoveryAcknowledgementResponse;
  assert.equal(replay.disposition, "replayed");
  assert.equal(f.state.record!.revision, response.revision);
});
test("recovery publications are explicit; older unapproved text package keeps the original four-write path", async (t) => {
  const f = await projectTextRecoveryFixture();
  t.after(f.close);
  const recovery = new PluginProjectTextRecoveryApplicationService({
    journal: f.journal,
    projects: f.projects.store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    publications: [
      { ...f.publications[0]!, packageDigest: `sha256:${"b".repeat(64)}` },
    ],
    clock: { now: () => f.ui.state.now },
    ids: { nextId: () => "unused" },
    digester: { sha256 },
  });
  const owner = new PluginProjectTextActionOwner({
    texts: f.texts,
    publications: f.publications,
    authorization: { authorize: async () => undefined },
    recovery,
  });
  t.after(() => owner.close());
  const older = f.createOwners([
    { ...f.publications[0]!, packageDigest: `sha256:${"b".repeat(64)}` },
  ]);
  t.after(() =>
    Promise.all([older.textOwner.close(), older.recoveryOwner.close()]),
  );
  const lease = await older.service.openMount(uiTestActor, uiTestMountCommand);
  await older.service.invoke(uiTestActor, {
    mountRef: lease.mountRef,
    action: PROJECT_TEXT_UI_METHOD_ACTIONS.saveOutlineCandidate,
    input: candidate(f.project.projectId),
  });
  assert.equal(f.state.stageCalls, 0);
  assert.equal(f.state.record, null);
  assert.equal(f.store.commits.length, 1);
});
test("constructor captures port methods without evaluating accessors or accepting late replacement", async (t) => {
  const f = await projectTextRecoveryFixture();
  t.after(f.close);
  let getters = 0;
  const bad = {};
  Object.defineProperty(bad, "getPending", {
    get: () => {
      getters++;
      throw new Error("must not read");
    },
  });
  const badJournal = Object.create(f.journal) as typeof f.journal;
  Object.defineProperty(badJournal, "getPending", {
    get: () => {
      getters++;
      throw new Error("must not read");
    },
  });
  assert.throws(
    () =>
      new PluginProjectTextRecoveryApplicationService({
        journal: badJournal,
        projects: f.projects.store,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        publications: f.publications,
        clock: { now: () => f.ui.state.now },
        ids: { nextId: () => "unused" },
        digester: { sha256 },
      }),
  );
  assert.equal(getters, 0);
  f.journal.getPending = async () => {
    throw new Error("late replaced port");
  };
  assert.deepEqual(
    await f.recover("getPending", { projectId: f.project.projectId }),
    { intent: null },
  );
});
