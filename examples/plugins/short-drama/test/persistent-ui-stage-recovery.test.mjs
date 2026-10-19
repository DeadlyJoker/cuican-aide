import assert from "node:assert/strict";
import { after, test } from "node:test";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { deferred, persistentProps } from "./persistent-ui.test-support.mjs";
import { recoveryTextService } from "./text-recovery.test-support.mjs";
import { sourceUiDefinition } from "./source-ui.test-support.mjs";
import { mediaInputFixture } from "./media-input.test-support.mjs";
import { assetControllerFixture } from "./asset-controller.test-support.mjs";
const definition = await sourceUiDefinition();
after(async () => browser.happyDOM.close());

test("late script recovery preserves the host's character stage; opening its result navigates explicitly", async () => {
  const service = recoveryTextService();
  const { project } = service.metadata.create(
    "重录",
    "角色与剧本共享项目，恢复不能抢走当前页面。",
  );
  const projectId = project.projectId;
  const outline = await service.services.invoke(
    "crewon.project-texts.v1.saveOutlineCandidate",
    {
      projectId,
      idempotencyKey: "outline-original",
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: {
          title: "重录",
          logline: "员工拒念谎言。",
          synopsis: "柜台前的选择。",
          episodes: [
            {
              episodeId: "ep1",
              title: "不念自愿",
              summary: "没拿到工资，仍拒绝谎言。",
            },
          ],
        },
      },
    },
  );
  // Only the original script journal remains pending for the cold mount.
  service.intents.clear();
  await service.services.invoke("crewon.project-texts.v1.saveScriptCandidate", {
    projectId,
    episodeId: "ep1",
    idempotencyKey: "script-original",
    request: {
      expectedArtifactRevision: 0,
      briefRevision: 1,
      outline: { artifactId: outline.artifact.artifactId, contentRevision: 1 },
      content: {
        title: "不念自愿",
        scenes: [
          {
            sceneId: "shot01",
            location: "柜台",
            timeOfDay: "夜",
            action: "林夏放下钥匙离开。",
            dialogue: [],
          },
        ],
      },
    },
  });
  const gate = deferred(),
    navigation = [];
  const props = (stage) => ({
    ...persistentProps(true),
    data: {
      ...persistentProps(true).data,
      hostPresentation: { surface: "workbench", context: { projectId, stage } },
    },
  });
  const f = fixture(definition, {
    props: props("characters"),
    services: {
      async invoke(action, input, options) {
        if (action === "crewon.plugin-navigation.open-page") {
          navigation.push(structuredClone(input));
          f.instance.update(props(input.context.stage));
          return {
            version: "crewon.plugin-ui-navigation.v1",
            pageId: "project-page",
          };
        }
        if (action === "crewon.project-text-recovery.v1.getPending")
          await gate.promise;
        return service.services.invoke(action, input, options);
      },
    },
  });
  const current = () =>
    f.container.querySelector('.drama-stage-tabs [aria-current="page"]')
      ?.textContent;
  try {
    await settle();
    assert.equal(current(), "角色");
    gate.resolve();
    await settle();
    await settle();
    assert.equal(
      current(),
      "角色",
      "background recovery cannot replace the selected host stage",
    );
    assert.equal(navigation.length, 0);
    assert.equal(
      service.writeCalls.length,
      2,
      "reads never create a replacement candidate",
    );
    await f.click(f.container.querySelector('[aria-label="项目操作"]'));
    await f.click(f.button("操作记录"));
    service.failRecoveryRead(true);
    await f.click(f.button("读取已保存结果"));
    assert.equal(current(), "角色", "failed recovery cannot navigate away");
    assert.equal(navigation.length, 0);
    service.failRecoveryRead(false);
    await f.click(f.button("读取已保存结果"));
    assert.equal(current(), "分集剧本");
    assert.equal(navigation.at(-1).context.stage, "script");
    assert.match(f.container.textContent, /林夏放下钥匙离开/);
    assert.equal(service.writeCalls.length, 2);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

test("an asset change hint refreshes the original character list and preserves an unsaved draft", async () => {
  const media = mediaInputFixture(),
    recovery = assetControllerFixture().recovery;
  const saved = new Map(media.views);
  media.views.clear();
  const props = (revision) => ({
    ...persistentProps(true),
    data: {
      ...persistentProps(true).data,
      hostPresentation: {
        surface: "workbench",
        context: {
          projectId: media.details.project.projectId,
          stage: "characters",
        },
        projectAssetChangeRevision: revision,
      },
    },
  });
  const calls = [];
  const f = fixture(definition, {
    props: props(0),
    services: {
      async invoke(action, input, options) {
        calls.push(action);
        if (action.startsWith("crewon.project-asset-recovery.v2."))
          return recovery[action.split(".").at(-1)](input, options);
        return media.services.invoke(action, input, options);
      },
    },
  });
  const directory = () =>
    f.container.querySelectorAll('[aria-label="资产列表"] > button');
  try {
    await settle();
    assert.equal(directory().length, 0);
    for (const [id, value] of saved) media.views.set(id, value);
    f.instance.update(props(1));
    await settle();
    assert.equal(
      directory().length,
      2,
      "the saved candidates appear without a manual refresh",
    );
    assert.equal(
      f.container.querySelector('.drama-stage-tabs [aria-current="page"]')
        .textContent,
      "角色",
    );
    const reads = () =>
      calls.filter((action) => action === "crewon.project-assets.v2.listAssets")
        .length;
    const count = reads();
    f.instance.update(props(1));
    await settle();
    assert.equal(
      reads(),
      count,
      "the same hint does not trigger repeated reads",
    );
    await f.click(f.button("新建角色"));
    await f.input(
      f.container.querySelector('[aria-label="资产名称"]'),
      "未保存角色",
    );
    media.views.delete("character-b");
    f.instance.update(props(2));
    await settle();
    assert.equal(
      reads(),
      count,
      "background hints wait while a draft is dirty",
    );
    assert.equal(
      f.container.querySelector('[aria-label="资产名称"]').value,
      "未保存角色",
    );
  } finally {
    await f.dispose();
  }
});
