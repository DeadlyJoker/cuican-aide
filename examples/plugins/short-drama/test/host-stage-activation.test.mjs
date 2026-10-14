import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { mediaInputFixture } from "./media-input.test-support.mjs";

const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(
    `../dist/${process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "54.0.0"}/`,
    import.meta.url,
  ).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
function hostFixture(stage = "overview") {
  const original = mediaInputFixture(),
    calls = [];
  const props = (nextStage) => {
    const value = persistentProps(true);
    return {
      ...value,
      data: {
        ...value.data,
        hostPresentation: {
          surface: "workbench",
          context: { projectId: original.projectId, stage: nextStage },
        },
      },
    };
  };
  const mounted = fixture(definition, {
    props: props(stage),
    services: {
      async invoke(action, input, options) {
        calls.push({ action, input: structuredClone(input) });
        if (
          action === "crewon.project-asset-recovery.v2.getPending" ||
          action === "crewon.project-media-generations.v2.getRecovery"
        )
          return { intent: null };
        if (action === "crewon.project-assets.v2.getRevision")
          return {
            contentRevision: structuredClone(
              original.views.get(input.assetId)?.selectedContentRevision ??
                null,
            ),
          };
        if (action.startsWith("crewon.plugin-navigation"))
          throw new Error("host_navigation_update_required");
        return original.services.invoke(action, input, options);
      },
    },
  });
  return { ...mounted, original, calls, props };
}
const mutation = (call) =>
  /\.(?:createConversation|startStage|start|generate|saveCandidate|saveInput|selectRevision|setLocked|adoptMediaReference)$/u.test(
    call.action,
  );
const reads = (f, action) => f.calls.filter((call) => call.action === action);

test("host context changes activate role, art and picture modules with reads only", async () => {
  const f = hostFixture();
  try {
    await settle();
    assert.equal(reads(f, "crewon.project-assets.v2.listAssets").length, 0);
    assert.equal(
      reads(f, "crewon.project-media-inputs.v1.listInputs").length,
      0,
    );
    f.instance.update(f.props("characters"));
    await settle();
    assert.equal(reads(f, "crewon.project-assets.v2.listAssets").length, 1);
    assert.ok(
      f.container
        .querySelector('[aria-label="资产列表"]')
        .textContent.includes("角色 1"),
    );
    assert.equal(f.button("新建角色").disabled, false);
    assert.equal(
      f.container
        .querySelector('[aria-label="共享资产"]')
        .textContent.includes("正在读取共享资产"),
      false,
    );
    f.instance.update(f.props("art"));
    await settle();
    assert.ok(
      f.container
        .querySelector('[aria-label="资产列表"]')
        .textContent.includes("场景 1"),
    );
    assert.equal(f.button("新建场景").disabled, false);
    assert.equal(
      reads(f, "crewon.project-assets.v2.listAssets").length,
      1,
      "already loaded shared assets are reused",
    );
    f.instance.update(f.props("references"));
    await settle();
    assert.equal(
      reads(f, "crewon.project-media-inputs.v1.listInputs").length,
      1,
    );
    assert.equal(
      reads(f, "crewon.project-media-inputs.v1.getOptions").length,
      1,
    );
    assert.ok(f.container.querySelector('[aria-label="已保存媒体输入"]'));
    assert.equal(f.button("新建T10 · 角色参考四视图").disabled, false);
    assert.ok(reads(f, "crewon.project-texts.v1.listArtifacts").length > 0);
    assert.equal(f.calls.some(mutation), false);
  } finally {
    await f.dispose();
  }
});

test("restoring a picture stage activates its read controller immediately", async () => {
  const f = hostFixture("references");
  try {
    await settle();
    assert.equal(
      reads(f, "crewon.project-media-inputs.v1.listInputs").length,
      1,
    );
    assert.equal(
      reads(f, "crewon.project-media-inputs.v1.getOptions").length,
      1,
    );
    assert.equal(f.calls.some(mutation), false);
  } finally {
    await f.dispose();
  }
});

test("asset return-to-edit synchronizes the same host project tab instead of changing only the local page", async () => {
  const f = hostFixture("characters");
  try {
    await settle();
    await f.click(f.button("新建角色"));
    await f.input(
      f.container.querySelector('[aria-label="资产名称"]'),
      "未保存角色草稿",
    );
    f.instance.update(f.props("art"));
    await settle();
    await f.click(f.button("返回继续编辑"));
    const request = f.calls.find((call) =>
      call.action.startsWith("crewon.plugin-navigation"),
    );
    assert.ok(request);
    assert.equal(request.input.key, `project:${f.original.projectId}`);
    assert.deepEqual(request.input.context, {
      projectId: f.original.projectId,
      stage: "characters",
    });
    assert.equal(
      f.container
        .querySelector('[aria-label="项目制作阶段"] [aria-current="page"]')
        .textContent.trim(),
      "美术",
      "the host remains the stage authority until it updates context",
    );
    f.instance.update(f.props("characters"));
    await settle();
    assert.equal(
      f.container.querySelector('[aria-label="资产名称"]').value,
      "未保存角色草稿",
    );
    assert.equal(f.calls.some(mutation), false);
  } finally {
    await f.dispose();
  }
});

test("asset concept exploration synchronizes host stage and preserves an unexecuted local concept draft", async () => {
  const f = hostFixture("characters");
  try {
    await settle();
    const assetButton = [
      ...f.container
        .querySelector('[aria-label="资产列表"]')
        .querySelectorAll("button"),
    ].find((button) => button.textContent.includes("角色 1"));
    await f.click(assetButton);
    await f.click(f.button("用这版设定探索概念图"));
    const request = f.calls.find((call) =>
      call.action.startsWith("crewon.plugin-navigation"),
    );
    assert.ok(request);
    assert.equal(request.input.key, `project:${f.original.projectId}`);
    assert.deepEqual(request.input.context, {
      projectId: f.original.projectId,
      stage: "overview",
    });
    f.instance.update(f.props("overview"));
    await settle();
    assert.ok(
      f.container
        .querySelector('[aria-label="概念描述起点"]')
        .textContent.includes("林予"),
    );
    assert.equal(f.calls.some(mutation), false);
  } finally {
    await f.dispose();
  }
});
