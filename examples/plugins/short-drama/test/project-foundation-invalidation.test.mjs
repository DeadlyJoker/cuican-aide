import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPluginProjectFoundationClient } from "@crewon/plugin-sdk/project-foundation-ui";
import { browser, settle } from "./ui.test-support.mjs";
import { sourceModule } from "./generation-observation.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
import { foundationService } from "./foundation-ui.test-support.mjs";
const { ProjectFoundationController } = await sourceModule(
  fileURLToPath(
    new URL("../src/workbench/ProjectFoundationController.ts", import.meta.url),
  ),
);
after(async () => browser.happyDOM.close());

async function fixture(wrap = (invoke) => invoke) {
  const service = foundationService();
  const details = service.seed("creative");
  let physicalPending = false;
  const controller = new ProjectFoundationController({
    client: createPluginProjectFoundationClient({
      invoke: wrap(service.services.invoke),
    }),
    physicalWritesPending: () => physicalPending,
    committed: async () => {},
  });
  controller.setProject(details);
  controller.setReady(true);
  await settle();
  return {
    service,
    details,
    controller,
    projectId: details.project.projectId,
    pending(value) {
      physicalPending = value;
    },
  };
}

test("scoped background invalidation reads the real candidate and keeps the dirty draft without a loading transition", async () => {
  const f = await fixture();
  const states = [],
    off = f.controller.subscribe(() => states.push(f.controller.getSnapshot()));
  try {
    f.controller.setProposalDraft("我的未提交方案。");
    f.service.proposal(f.projectId, "Agent已经保存的候选方案。");
    const before = f.service.methodCalls("listProposals").length;
    f.controller.invalidate("foreign-project");
    await settle();
    assert.equal(f.service.methodCalls("listProposals").length, before);
    f.controller.invalidate(f.projectId);
    await settle();
    assert.equal(
      f.controller.getSnapshot().proposal.text,
      "Agent已经保存的候选方案。",
    );
    assert.equal(f.controller.getSnapshot().proposalDraft, "我的未提交方案。");
    assert.ok(states.every((state) => state.loading === false));
    assert.equal(f.service.methodCalls("listProposals").length, before + 1);
    assert.equal(f.service.methodCalls("confirmProposal").length, 0);
    assert.equal(f.service.methodCalls("saveProposal").length, 0);
  } finally {
    off();
    f.controller.dispose();
  }
});

test("multiple hints during a physical write coalesce to one read after its original save settles", async () => {
  const gate = deferred();
  let delay = true;
  const f = await fixture((invoke) => async (action, input, options) => {
    const result = await invoke(action, input, options);
    if (action.endsWith(".saveProposal") && delay) {
      delay = false;
      f.pending(true);
      try {
        await gate.promise;
      } finally {
        f.pending(false);
      }
    }
    return result;
  });
  try {
    f.controller.setProposalDraft("手动保存的原请求。");
    const saving = f.controller.saveProposal();
    await settle();
    const before = f.service.methodCalls("listProposals").length;
    for (let index = 0; index < 5; index++)
      f.controller.invalidate(f.projectId);
    await settle();
    assert.equal(f.service.methodCalls("listProposals").length, before);
    assert.equal(f.controller.getSnapshot().saving, true);
    gate.resolve();
    await saving;
    await settle();
    assert.equal(f.service.methodCalls("listProposals").length, before + 1);
    assert.equal(f.service.methodCalls("saveProposal").length, 1);
    assert.equal(
      f.controller.getSnapshot().proposal.text,
      "手动保存的原请求。",
    );
    assert.equal(f.controller.getSnapshot().pending, false);
  } finally {
    gate.resolve();
    f.controller.dispose();
  }
});

test("an unknown original write retains body/key and postpones reads until explicit retry confirms it", async () => {
  const f = await fixture();
  try {
    f.controller.setProposalDraft("未知结果的原方案。");
    f.service.loseNextReply();
    assert.equal(await f.controller.saveProposal(), false);
    const before = f.service.methodCalls("listProposals").length;
    f.controller.invalidate(f.projectId);
    await settle();
    assert.equal(f.controller.getSnapshot().pending, true);
    assert.equal(f.service.methodCalls("listProposals").length, before);
    assert.equal(await f.controller.retry(), true);
    await settle();
    const writes = f.service.methodCalls("saveProposal");
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].input, writes[0].input);
    assert.equal(f.service.proposals.get(f.projectId).length, 1);
    assert.equal(f.service.methodCalls("listProposals").length, before + 1);
    assert.equal(f.controller.getSnapshot().pending, false);
  } finally {
    f.controller.dispose();
  }
});

test("a late old-project background reply cannot replace a newly opened project's candidate", async () => {
  const gate = deferred();
  let heldProject = null;
  const f = await fixture((invoke) => async (action, input, options) => {
    const result = await invoke(action, input, options);
    if (action.endsWith(".listProposals") && input.projectId === heldProject)
      await gate.promise;
    return result;
  });
  try {
    f.service.proposal(f.projectId, "原项目候选。");
    heldProject = f.projectId;
    f.controller.invalidate(f.projectId);
    await settle();
    const next = f.service.seed("creative");
    f.service.proposal(next.project.projectId, "另一个项目的候选。");
    f.controller.setProject(next);
    await settle();
    gate.resolve();
    await settle();
    assert.equal(f.controller.getSnapshot().projectId, next.project.projectId);
    assert.equal(
      f.controller.getSnapshot().proposal.text,
      "另一个项目的候选。",
    );
    assert.equal(
      f.controller.getSnapshot().proposalDraft,
      "另一个项目的候选。",
    );
  } finally {
    gate.resolve();
    f.controller.dispose();
  }
});

test("a background reply held across another lane's physical write waits and rereads once after settlement", async () => {
  const gate = deferred();
  let pause = false;
  const f = await fixture((invoke) => async (action, input, options) => {
    const result = await invoke(action, input, options);
    if (pause && action.endsWith(".listProposals")) {
      pause = false;
      await gate.promise;
    }
    return result;
  });
  try {
    f.service.proposal(f.projectId, "读取开始时的候选。");
    const before = f.service.methodCalls("listProposals").length;
    pause = true;
    f.controller.invalidate(f.projectId);
    await settle();
    f.pending(true);
    f.service.proposal(f.projectId, "物理操作结束后的最新候选。");
    gate.resolve();
    await settle();
    assert.equal(f.controller.getSnapshot().proposal, null);
    assert.equal(f.service.methodCalls("listProposals").length, before + 1);
    f.pending(false);
    f.controller.refreshWriteActivity();
    await settle();
    assert.equal(
      f.controller.getSnapshot().proposal.text,
      "物理操作结束后的最新候选。",
    );
    assert.equal(f.service.methodCalls("listProposals").length, before + 2);
    f.controller.refreshWriteActivity();
    await settle();
    assert.equal(f.service.methodCalls("listProposals").length, before + 2);
  } finally {
    gate.resolve();
    f.controller.dispose();
  }
});
