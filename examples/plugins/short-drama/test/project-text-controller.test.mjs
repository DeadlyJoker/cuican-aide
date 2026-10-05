import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPluginCreativeProjectClient } from "@crewon/plugin-sdk/ui";
import { browser, settle } from "./ui.test-support.mjs";
import { sourceModule } from "./generation-observation.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
import { textService } from "./text-ui.test-support.mjs";
import { projectTextsUiCodec } from "../src/project-texts-ui-codec.mjs";
const { ProjectTextController } = await sourceModule(
  fileURLToPath(
    new URL("../src/workbench/ProjectTextController.ts", import.meta.url),
  ),
);
const { createPluginProjectTextUiClient } = await sourceModule(
  fileURLToPath(new URL("../src/project-texts-ui-service.ts", import.meta.url)),
);
after(async () => browser.happyDOM.close());
function makeController(services, details, physicalWritesPending) {
  const controller = new ProjectTextController({
    client: createPluginProjectTextUiClient(services, projectTextsUiCodec),
    projects: createPluginCreativeProjectClient(services),
    physicalWritesPending,
  });
  controller.setReady(true);
  controller.setProject(details);
  return controller;
}
for (const heldAction of [
  "crewon.creative-projects.v1.getBrief",
  "crewon.project-texts.v1.getOutline",
]) {
  test(`late ${heldAction} cannot replace newer known project/brief or archive state`, async () => {
    const service = textService();
    const details = service.metadata.create("来信", "旧需求。");
    const held = deferred();
    let delay = true;
    const services = {
      async invoke(action, input, options) {
        const result = await service.services.invoke(action, input, options);
        if (action === heldAction && delay) {
          delay = false;
          await held.promise;
        }
        return result;
      },
    };
    const controller = makeController(services, details);
    try {
      const opening = controller.open();
      await settle();
      const newer = service.metadata.externalBrief(
        details.project.projectId,
        "期间已经确认的新需求。",
      );
      controller.setProject({
        ...newer,
        project: {
          ...newer.project,
          state: "archived",
          revision: newer.project.revision + 1,
        },
      });
      held.resolve();
      await opening;
      assert.equal(controller.getSnapshot().currentBriefRevision, 2);
      assert.equal(controller.getSnapshot().archived, true);
      assert.equal(controller.canSave, false);
    } finally {
      held.resolve();
      controller.dispose();
    }
  });
}
test("withdrawn UI wait retains original write key after physical join and genuine reconnect retry", async () => {
  const service = textService();
  const details = service.metadata.create("来信", "连接中断不能重复保存。");
  const held = deferred();
  let physicalPending = false,
    delay = true;
  const services = {
    async invoke(action, input, options) {
      const result = await service.services.invoke(action, input, options);
      if (action === "crewon.project-texts.v1.saveOutlineCandidate" && delay) {
        delay = false;
        physicalPending = true;
        try {
          await held.promise;
        } finally {
          physicalPending = false;
        }
      }
      return result;
    },
  };
  const controller = makeController(services, details, () => physicalPending);
  try {
    await controller.open();
    controller.setDraft({
      title: "来信",
      logline: "收到来自过去的信。",
      synopsis: "他寻找旧信的寄件人。",
      episodes: [
        { episodeId: "episode-one", title: "午夜", summary: "迟到的信到达。" },
      ],
    });
    const writing = controller.save();
    await settle();
    controller.setReady(false);
    controller.setReady(true);
    await controller.retry();
    assert.equal(
      service.calls.filter((call) => call.method === "saveOutlineCandidate")
        .length,
      1,
      "unjoined original write still fences retry",
    );
    held.resolve();
    await writing;
    assert.equal(controller.getSnapshot().failure, "uncertain");
    await controller.retry();
    const writes = service.calls.filter(
      (call) => call.method === "saveOutlineCandidate",
    );
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].input, writes[0].input);
    assert.equal([...service.artifacts.values()][0].revisions.length, 1);
    assert.equal(controller.getSnapshot().failure, null);
  } finally {
    held.resolve();
    controller.dispose();
  }
});
