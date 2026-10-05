import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { textService } from "./text-ui.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "20.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(() => browser.happyDOM.close());
const proposal = {
  schemaVersion: "crewon.project-planning-proposal.v1",
  kind: "newProject",
  capability: {
    capabilityId: `sha256:${"a".repeat(64)}`,
    source: {
      pluginId: "crewon.short-drama",
      publisherId: "example.publisher",
      version,
      packageDigest: `sha256:${"a".repeat(64)}`,
      contributionId: "workbench",
    },
    title: "AI 短剧",
    kind: "short-drama",
    stages: ["brief", "outline", "script"],
    maximumEpisodes: 16,
    moduleAvailable: true,
    textPlansAvailable: true,
    executionReady: false,
  },
  origin: {
    runId: "original-chat-run",
    threadId: "original-chat",
    callId: "original-tool",
  },
  input: {
    capabilityId: `sha256:${"a".repeat(64)}`,
    title: "午夜来信",
    briefText: "都市悬疑\n一封没有署名的信。",
    instruction: "保留角色动机，创作两集大纲与剧本。",
    start: "outline",
    target: "script",
    episodeCount: 2,
    adoption: "manual",
  },
};
function mount(draft = proposal) {
  const service = textService(),
    calls = [];
  const props = persistentProps(true);
  props.data.projectPlanningDraft = structuredClone(draft);
  const f = fixture(definition, {
    props,
    services: {
      async invoke(action, input, options) {
        calls.push({ action, input: structuredClone(input) });
        return service.services.invoke(action, input, options);
      },
    },
  });
  return { f, service, calls };
}
const field = (f, label) =>
  f.container.querySelector(`[aria-label="${label}"]`);
test("viewing a chat draft performs no write; explicit project confirmation saves edited inputs and only prefills a plan", async () => {
  const { f, service, calls } = mount();
  try {
    await settle();
    assert.match(f.container.textContent, /Agent 项目建议|午夜来信/u);
    assert.equal(service.metadata.records.size, 0);
    await f.click(f.button("查看并创建项目"));
    const dialog = f.container.querySelector("dialog");
    assert.equal(dialog.open, true);
    assert.equal(dialog.querySelector("input").value, proposal.input.title);
    assert.equal(
      dialog.querySelector("textarea").value,
      proposal.input.briefText,
    );
    assert.equal(service.metadata.records.size, 0);
    await f.input(dialog.querySelector("input"), "午夜来信·修订");
    await f.click(f.button("创建项目"));
    const create = calls.find(
      (x) => x.action === "crewon.creative-projects.v1.createProject",
    );
    assert.equal(create.input.request.title, "午夜来信·修订");
    assert.equal(create.input.request.briefText, proposal.input.briefText);
    assert.equal(service.metadata.records.size, 1);
    assert.equal(field(f, "计划创作要求").value, proposal.input.instruction);
    assert.equal(field(f, "计划集数").value, "2");
    assert.equal(field(f, "计划使用的项目对话").value, "");
    assert.equal(f.button("开始文字计划").disabled, true);
    assert.equal(
      calls.filter(
        (x) =>
          x.action.endsWith(".start") ||
          x.action.endsWith(".createConversation") ||
          x.action.endsWith(".submitConceptGeneration"),
      ).length,
      0,
    );
    assert.equal(f.container.querySelectorAll(".stage-item").length, 5);
  } finally {
    await f.dispose();
  }
});
test("canceled draft review does not leak into a normal new project or silently authorize a plan", async () => {
  const { f, service, calls } = mount();
  try {
    await settle();
    await f.click(f.button("查看并创建项目"));
    await f.click(f.button("取消"));
    await f.click(f.button("新建项目"));
    const dialog = f.container.querySelector("dialog");
    assert.equal(dialog.querySelector("input").value, "");
    assert.equal(dialog.querySelector("textarea").value, "");
    await f.input(dialog.querySelector("input"), "手动探索");
    await f.input(dialog.querySelector("textarea"), "另一个独立故事。");
    await f.click(f.button("创建项目"));
    assert.equal(service.metadata.records.size, 1);
    assert.equal(field(f, "计划创作要求").value, "");
    assert.equal(field(f, "计划集数").value, "3");
    assert.equal(calls.filter((x) => x.action.endsWith(".start")).length, 0);
  } finally {
    await f.dispose();
  }
});
test("malformed proposal data cannot display a review control or create a project", async () => {
  const { f, service } = mount({
    ...proposal,
    input: { ...proposal.input, episodeCount: 17 },
  });
  try {
    await settle();
    assert.equal(
      f.container.querySelector('[aria-label="Agent 项目建议"]'),
      null,
    );
    assert.equal(service.metadata.records.size, 0);
  } finally {
    await f.dispose();
  }
});
