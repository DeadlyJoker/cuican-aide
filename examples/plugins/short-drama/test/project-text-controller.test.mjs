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

const externalOutline = async (service, details, revision, synopsis) =>
  service.services.invoke("crewon.project-texts.v1.saveOutlineCandidate", {
    projectId: details.project.projectId,
    idempotencyKey: `external-${revision}`,
    request: {
      expectedArtifactRevision: revision,
      briefRevision: 1,
      content: {
        title: "来信",
        logline: "来自过去的信。",
        synopsis,
        episodes: [{ episodeId: "one", title: "午夜", summary: "信到达。" }],
      },
    },
  });

test("external text hint reads new candidate without loading; preserves edits and explicit history", async () => {
  const service = textService(),
    details = service.metadata.create("来信", "需求。"),
    c = makeController(service.services, details);
  try {
    await c.open();
    const states = [];
    c.subscribe(() => states.push(c.getSnapshot().phase));
    await externalOutline(service, details, 0, "第一候选。");
    c.invalidate(details.project.projectId);
    await settle();
    assert.equal(c.getSnapshot().content.contentRevision, 1);
    assert.ok(!states.includes("loading"));
    c.setDraft({ ...c.getSnapshot().draft, synopsis: "未保存编辑。" });
    await externalOutline(service, details, 1, "第二候选。");
    c.invalidate(details.project.projectId);
    await settle();
    assert.equal(c.getSnapshot().view.artifact.latestContentRevision, 2);
    assert.equal(c.getSnapshot().draft.synopsis, "未保存编辑。");
    assert.equal(c.getSnapshot().content.contentRevision, 1);
  } finally {
    c.dispose();
  }
});

test("text hints wait for physical write settlement and ignore another project", async () => {
  const service = textService(),
    details = service.metadata.create("来信", "需求。");
  let pending = true;
  const c = makeController(service.services, details, () => pending);
  try {
    pending = false;
    await c.open();
    pending = true;
    await externalOutline(service, details, 0, "已保存候选。");
    const before = service.calls.length;
    c.invalidate("another-project");
    c.invalidate(details.project.projectId);
    c.invalidate(details.project.projectId);
    await settle();
    assert.equal(service.calls.length, before);
    pending = false;
    c.refreshWriteActivity();
    await settle();
    assert.equal(c.getSnapshot().content.contentRevision, 1);
    assert.equal(
      service.calls.slice(before).filter((x) => x.method === "getOutline")
        .length,
      1,
    );
  } finally {
    c.dispose();
  }
});

test("background text read retains explicit older revision and edits made while the read is held", async () => {
  const service = textService(),
    details = service.metadata.create("来信", "需求。"),
    held = deferred();
  let hold = false;
  const services = {
    async invoke(action, input, options) {
      const result = await service.services.invoke(action, input, options);
      if (hold && action === "crewon.project-texts.v1.getOutline") {
        hold = false;
        await held.promise;
      }
      return result;
    },
  };
  const c = makeController(services, details);
  try {
    await externalOutline(service, details, 0, "第一候选。");
    await c.open();
    const older = c.getSnapshot().content;
    await externalOutline(service, details, 1, "第二候选。");
    await c.open();
    c.editRevision(older);
    c.invalidate(details.project.projectId);
    await settle();
    assert.equal(c.getSnapshot().view.artifact.latestContentRevision, 2);
    assert.equal(c.getSnapshot().content.contentRevision, 1);
    hold = true;
    c.invalidate(details.project.projectId);
    await settle();
    c.setDraft({ ...c.getSnapshot().draft, synopsis: "读取期间编辑。" });
    held.resolve();
    await settle();
    assert.equal(c.getSnapshot().draft.synopsis, "读取期间编辑。");
    assert.equal(c.getSnapshot().phase, "ready");
  } finally {
    held.resolve();
    c.dispose();
  }
});

test("late background text read cannot cross a project switch", async () => {
  const service = textService(),
    old = service.metadata.create("旧", "旧需求。"),
    next = service.metadata.create("新", "新需求。"),
    held = deferred();
  let hold = false;
  const services = {
    async invoke(action, input, options) {
      const result = await service.services.invoke(action, input, options);
      if (
        hold &&
        action === "crewon.project-texts.v1.getOutline" &&
        input.projectId === old.project.projectId
      ) {
        hold = false;
        await held.promise;
      }
      return result;
    },
  };
  const c = makeController(services, old);
  try {
    await c.open();
    hold = true;
    c.invalidate(old.project.projectId);
    await settle();
    c.setProject(next);
    await c.open();
    held.resolve();
    await settle();
    assert.equal(c.getSnapshot().draft.title, "新");
    assert.equal(c.getSnapshot().view, null);
  } finally {
    held.resolve();
    c.dispose();
  }
});

test("background invalidation keeps the just-saved candidate visible while its old adopted version remains authoritative", async () => {
  const service = textService();
  const details = service.metadata.create(
    "来信",
    "保留已采用版本，审读新的候选。",
  );
  const c = makeController(service.services, details);
  try {
    await externalOutline(service, details, 0, "原采用正文。");
    await c.open();
    await c.select(1);
    c.setDraft({ ...c.getSnapshot().draft, synopsis: "刚保存的新候选正文。" });
    await c.save();
    assert.equal(c.getSnapshot().content.contentRevision, 2);
    c.invalidate(details.project.projectId);
    await settle();
    assert.equal(c.getSnapshot().content.contentRevision, 2);
    assert.equal(c.getSnapshot().draft.synopsis, "刚保存的新候选正文。");
    assert.equal(c.getSnapshot().dirty, false);
    assert.equal(c.getSnapshot().view.artifact.selectedContentRevision, 1);
    assert.equal(c.getSnapshot().view.artifact.latestContentRevision, 2);
    await c.open();
    assert.equal(c.getSnapshot().content.contentRevision, 1);
  } finally {
    c.dispose();
  }
});
