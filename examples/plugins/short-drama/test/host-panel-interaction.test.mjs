import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { deferred, persistentProps } from "./persistent-ui.test-support.mjs";
import { mediaInputFixture } from "./media-input.test-support.mjs";

const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(
    `../dist/${process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "50.1.1"}/`,
    import.meta.url,
  ).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());

function panelFixture(stage = "overview") {
  const original = mediaInputFixture(),
    gate = deferred(),
    navigation = [],
    calls = [];
  const props = (next) => {
    const value = persistentProps(true);
    return {
      ...value,
      data: {
        ...value.data,
        hostPresentation: {
          surface: "workbench",
          context: { projectId: original.projectId, stage: next },
        },
      },
    };
  };
  const f = fixture(definition, {
    props: props(stage),
    services: {
      async invoke(action, input, options) {
        calls.push(action);
        if (action.startsWith("crewon.plugin-navigation")) {
          navigation.push(structuredClone(input));
          return navigation.length === 1 ? gate.promise : {};
        }
        if (
          action === "crewon.project-asset-recovery.v2.getPending" ||
          action === "crewon.project-media-generations.v2.getRecovery"
        )
          return { intent: null };
        if (action === "crewon.project-assets.v2.listAssets")
          return { assets: [], nextAssetId: null };
        return original.services.invoke(action, input, options);
      },
    },
  });
  return { ...f, gate, navigation, calls, props };
}
const selected = (f) =>
  f.container
    .querySelector('.drama-stage-tabs [aria-current="page"]')
    ?.textContent.trim();

test("panel switches immediately while host navigation is pending, coalesces later clicks and never executes", async () => {
  const f = panelFixture();
  try {
    await settle();
    f.button("角色").click();
    await settle();
    assert.equal(selected(f), "角色");
    assert.equal(f.navigation.length, 1);
    f.button("美术").click();
    f.button("分集剧本").click();
    await settle();
    assert.equal(selected(f), "分集剧本");
    assert.equal(
      f.navigation.length,
      1,
      "one physical host navigation at a time",
    );
    f.gate.resolve({});
    await settle();
    assert.deepEqual(
      f.navigation.map((value) => value.context.stage),
      ["characters", "script"],
    );
    assert.equal(
      f.calls.some((action) =>
        /startStage|createConversation|generate|saveCandidate/.test(action),
      ),
      false,
    );
  } finally {
    f.gate.resolve({});
    await f.dispose();
  }
});

test("navigation rejection restores the confirmed stage and shows a useful error", async () => {
  const f = panelFixture();
  try {
    await settle();
    const confirmed = selected(f);
    f.button("角色").click();
    await settle();
    assert.equal(selected(f), "角色");
    f.gate.reject(new Error("named navigation refusal"));
    await settle();
    assert.equal(selected(f), confirmed);
    assert.match(
      f.container.querySelector(".drama-navigation-error").textContent,
      /阶段同步未完成/,
    );
  } finally {
    await f.dispose();
  }
});

test("project operations are outside the output, records open on demand and Escape restores focus", async () => {
  const f = panelFixture("characters");
  try {
    await settle();
    assert.equal(
      f.container.textContent.includes("项目管理与待处理记录"),
      false,
    );
    assert.equal(
      f.container
        .querySelector(".drama-project-editor")
        .textContent.includes("归档项目"),
      false,
    );
    assert.equal(
      f.container.querySelectorAll(".drama-project-editor h2").length,
      1,
    );
    const trigger = f.container.querySelector('[aria-label="项目操作"]');
    await f.click(trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    await f.click(f.button("操作记录"));
    const dialog = f.container.querySelector(".drama-records-dialog");
    assert.equal(dialog.open, true);
    dialog.dispatchEvent(
      new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await settle();
    assert.equal(dialog.open, false);
    assert.ok(
      browser.document.activeElement === trigger,
      "focus returns to project operations",
    );
    const empty = f.container.querySelector(".drama-asset-empty").outerHTML;
    const file = new URL("./snapshots/host-panel-empty.html", import.meta.url);
    if (process.env.CREWON_UPDATE_PANEL_SNAPSHOTS === "1")
      await writeFile(file, empty + "\n");
    assert.equal(empty, (await readFile(file, "utf8")).trimEnd());
  } finally {
    await f.dispose();
  }
});
