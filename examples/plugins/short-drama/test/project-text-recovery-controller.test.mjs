import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPluginCreativeProjectClient } from "@crewon/plugin-sdk/ui";
import { browser, settle } from "./ui.test-support.mjs";
import { sourceModule } from "./generation-observation.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
import { recoveryTextService } from "./text-recovery.test-support.mjs";
import { projectTextsUiCodec } from "../src/project-texts-ui-codec.mjs";
import { projectTextRecoveryCodec } from "../src/project-text-recovery-codec.mjs";
const { ProjectTextController } = await sourceModule(
  fileURLToPath(
    new URL("../src/workbench/ProjectTextController.ts", import.meta.url),
  ),
);
const { createPluginProjectTextUiClient } = await sourceModule(
  fileURLToPath(new URL("../src/project-texts-ui-service.ts", import.meta.url)),
);
const { createPluginProjectTextRecoveryClient } = await sourceModule(
  fileURLToPath(
    new URL("../src/project-text-recovery-service.ts", import.meta.url),
  ),
);
after(async () => browser.happyDOM.close());
const draft = {
  title: "来信",
  logline: "一封旧信改变了命运。",
  synopsis: "他寻找寄件人。",
  episodes: [{ episodeId: "one", title: "午夜", summary: "来信到达。" }],
};
function make(services, details) {
  const controller = new ProjectTextController({
    client: createPluginProjectTextUiClient(services, projectTextsUiCodec),
    projects: createPluginCreativeProjectClient(services),
    recovery: createPluginProjectTextRecoveryClient(
      services,
      projectTextRecoveryCodec,
    ),
  });
  controller.setReady(true);
  controller.setProject(details);
  return controller;
}

test("late recovery from another project cannot inject its request or freeze the current project", async () => {
  const service = recoveryTextService(),
    old = service.metadata.create("旧项目", "旧需求。"),
    next = service.metadata.create("新项目", "新需求。"),
    held = deferred();
  service.loseBeforeNextWrite();
  await assert.rejects(
    service.services.invoke("crewon.project-texts.v1.saveOutlineCandidate", {
      projectId: old.project.projectId,
      idempotencyKey: "old-key",
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: draft,
      },
    }),
  );
  const services = {
    async invoke(action, input, options) {
      const result = await service.services.invoke(action, input, options);
      if (
        action === "crewon.project-text-recovery.v1.getPending" &&
        input.projectId === old.project.projectId
      )
        await held.promise;
      return result;
    },
  };
  const controller = make(services, old);
  try {
    await settle();
    controller.setProject(next);
    await settle();
    await controller.open();
    held.resolve();
    await settle();
    assert.equal(controller.getSnapshot().recovery.intent, null);
    assert.equal(controller.getSnapshot().draft.title, "新项目");
    assert.equal(controller.getSnapshot().opening, false);
    assert.equal(service.writeCalls.length, 1);
    assert.equal(
      service.intents.size,
      1,
      "ignored old request remains durable",
    );
  } finally {
    held.resolve();
    controller.dispose();
  }
});

test("confirmed save fences another write until journal ACK while preserving a newer local draft", async () => {
  const service = recoveryTextService(),
    details = service.metadata.create("来信", "新编辑不能抢先产生第二个key。"),
    held = deferred();
  let delay = true;
  const services = {
    async invoke(action, input, options) {
      const result = await service.services.invoke(action, input, options);
      if (delay && action === "crewon.project-texts.v1.getArtifact") {
        delay = false;
        await held.promise;
      }
      return result;
    },
  };
  const controller = make(services, details);
  try {
    await settle();
    await controller.open();
    controller.setDraft(draft);
    const saving = controller.save();
    await settle();
    controller.setDraft({ ...draft, synopsis: "保存确认后的新编辑仍要保留。" });
    assert.equal(controller.canSave, false);
    await controller.save();
    assert.equal(service.writeCalls.length, 1);
    held.resolve();
    await saving;
    assert.equal(
      controller.getSnapshot().draft.synopsis,
      "保存确认后的新编辑仍要保留。",
    );
    assert.equal(controller.getSnapshot().dirty, true);
    assert.equal(controller.canSave, true);
    await controller.save();
    assert.equal([...service.artifacts.values()][0].revisions.length, 2);
  } finally {
    held.resolve();
    controller.dispose();
  }
});

test("a late recovery view cannot keep opening true after another view acknowledges that intent", async () => {
  const service = recoveryTextService(),
    details = service.metadata.create("来信", "并发只关闭已确认记录。"),
    held = deferred();
  await service.services.invoke(
    "crewon.project-texts.v1.saveOutlineCandidate",
    {
      projectId: details.project.projectId,
      idempotencyKey: "accepted-key",
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: draft,
      },
    },
  );
  let delay = true;
  const services = {
    async invoke(action, input, options) {
      const result = await service.services.invoke(action, input, options);
      if (delay && action === "crewon.project-texts.v1.getRevision") {
        delay = false;
        await held.promise;
      }
      return result;
    },
  };
  const controller = make(services, details);
  try {
    await settle();
    assert.equal(controller.getSnapshot().opening, true);
    const record = [...service.intents.values()][0];
    await service.services.invoke(
      "crewon.project-text-recovery.v1.acknowledge",
      {
        projectId: details.project.projectId,
        intentId: record.intentId,
        expectedRevision: record.revision,
      },
    );
    await controller.recovery.check();
    held.resolve();
    await settle();
    assert.equal(controller.getSnapshot().opening, false);
    assert.equal(controller.getSnapshot().recovery.intent, null);
    await controller.open();
    assert.equal(controller.getSnapshot().content.contentRevision, 1);
    assert.equal(controller.getSnapshot().phase, "ready");
  } finally {
    held.resolve();
    controller.dispose();
  }
});

test("old conflict read cannot replace the newer recovered head used for an explicit new candidate", async () => {
  const service = recoveryTextService(),
    details = service.metadata.create("来信", "恢复会撤销旧冲突读取。"),
    pending = deferred(),
    conflict = deferred();
  let holdPending = false,
    holdConflict = false;
  const services = {
    async invoke(action, input, options) {
      const result = await service.services.invoke(action, input, options);
      if (
        holdPending &&
        action === "crewon.project-text-recovery.v1.getPending"
      ) {
        holdPending = false;
        await pending.promise;
      }
      if (holdConflict && action === "crewon.project-texts.v1.getOutline") {
        holdConflict = false;
        await conflict.promise;
      }
      return result;
    },
  };
  const controller = make(services, details);
  try {
    await settle();
    await controller.open();
    controller.setDraft(draft);
    await controller.save();
    const item = [...service.artifacts.values()][0];
    item.artifact = { ...item.artifact, revision: 2 };
    controller.setDraft({ ...draft, synopsis: "冲突中的内容。" });
    holdPending = true;
    const saving = controller.save();
    await settle();
    holdConflict = true;
    const reading = controller.refreshConflict();
    await settle();
    item.artifact = { ...item.artifact, revision: 3 };
    pending.resolve();
    await saving;
    await controller.refreshRecovery();
    await controller.acknowledgeRecovery();
    conflict.resolve();
    await reading;
    assert.equal(controller.getSnapshot().view.artifact.revision, 3);
    assert.equal(controller.getSnapshot().draft.synopsis, "冲突中的内容。");
    await controller.save();
    assert.equal(
      service.writeCalls.at(-1).input.request.expectedArtifactRevision,
      3,
    );
    assert.equal(item.revisions.length, 2);
  } finally {
    pending.resolve();
    conflict.resolve();
    controller.dispose();
  }
});
