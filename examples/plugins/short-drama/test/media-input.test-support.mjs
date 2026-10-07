import assert from "node:assert/strict";
import { build } from "esbuild";
import { textService } from "./text-ui.test-support.mjs";
import { projectMediaInputsUiCodec } from "../src/project-media-inputs-ui-codec.mjs";
import { createPluginMediaInputUiClient } from "../src/project-media-inputs-ui-client.ts";
const { outputFiles } = await build({
  entryPoints: [
    new URL("../src/workbench/ProjectMediaInputController.ts", import.meta.url)
      .pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
});
const { ProjectMediaInputController } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
);
const copy = (value) => structuredClone(value);
const digest = `sha256:${"a".repeat(64)}`,
  at = "2026-10-06T00:00:00.000Z";

/** Portable public DTO fixture only. It does not model Main identity, SQL or a provider. */
export function mediaInputFixture() {
  const text = textService(),
    details = text.metadata.create("雨夜来信", "三集雨夜悬疑，先探索角色。"),
    projectId = details.project.projectId;
  const views = new Map(),
    records = new Map(),
    receipts = new Map(),
    calls = [];
  let loss = null,
    gate = null,
    physical = false,
    configurationRevision = 1;
  const addAsset = (id, kind, name) => {
    const content = {
      projectId,
      assetId: id,
      kind,
      contentRevision: 1,
      brief: { briefRevision: 1, contentDigest: details.brief.contentDigest },
      script: null,
      content: {
        name,
        setting: "悬疑短剧设定",
        visualPrompt: "雨夜、柔和灯光。",
      },
      createdAt: at,
      contentDigest: digest,
    };
    const reference = {
      projectId,
      assetId: id,
      referenceRevision: 1,
      assetContentRevision: 1,
      assetContentDigest: digest,
      source: {
        kind: "concept-selection",
        conceptAssetId: "concept-" + id,
        conceptAssetRevision: 1,
        selectionRevision: 1,
        conceptSelectionDigest: digest,
        resultLinkDigest: digest,
        generationLinkDigest: digest,
        sourceRunId: "original-run",
        sourceBindingDigest: digest,
        pluginId: "crewon.short-drama",
        pluginVersion: "19.0.1",
        packageDigest: digest,
        configurationRevision: 1,
        configurationDigest: digest,
        operationId: "11111111-1111-4111-8111-111111111111",
        operationRevision: 2,
        operationDigest: digest,
        rawResultDigest: digest,
        resultIndex: 0,
      },
      createdAt: at,
      contentDigest: digest,
    };
    views.set(id, {
      asset: {
        projectId,
        assetId: id,
        kind,
        revision: 4,
        latestContentRevision: 1,
        selectedContentRevision: 1,
        latestReferenceRevision: 1,
        selectedReferenceRevision: 1,
        locked: true,
        createdAt: at,
        updatedAt: at,
      },
      selectedContentRevision: content,
      selectedReferenceRevision: reference,
      dependencyState: "current",
      staleReasons: [],
      referenceState: "current",
    });
  };
  addAsset("character-a", "character", "林予");
  addAsset("character-b", "character", "许晟");
  addAsset("scene-a", "scene", "雨夜车站");
  const assetClient = {
    async listAssets(q) {
      assert.equal(q.projectId, projectId);
      return {
        assets: [...views.values()].map((v) => copy(v.asset)),
        nextAssetId: null,
      };
    },
    async getAsset(q) {
      return { view: copy(views.get(q.assetId) ?? null) };
    },
  };
  const queryText = async (method, q, o) =>
    text.services.invoke("crewon.project-texts.v1." + method, q, o);
  const textClient = {
    listArtifacts: (q, o) => queryText("listArtifacts", q, o),
    getArtifact: (q, o) => queryText("getArtifact", q, o),
  };
  const services = {
    async invoke(action, input, options) {
      if (action.startsWith("crewon.project-assets.v2."))
        return assetClient[action.split(".").at(-1)](input, options);
      if (!action.startsWith("crewon.project-media-inputs.v1."))
        return text.services.invoke(action, input, options);
      const request = projectMediaInputsUiCodec.parseRequest({ action, input });
      calls.push(copy(request));
      if (action.endsWith("getOptions"))
        return {
          configuration: {
            revision: configurationRevision,
            workflows: [
              "krea2-reference-four-view",
              "flux2-three-reference-storyboard",
            ],
          },
        };
      if (action.endsWith("listInputs")) {
        const all = [...records.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .filter(
              ([id]) =>
                input.afterMediaInputId === null ||
                id > input.afterMediaInputId,
            ),
          chosen = all.slice(0, input.limit);
        return {
          inputs: chosen.map(([id, versions]) => {
            const r = versions.at(-1);
            return {
              projectId,
              mediaInputId: id,
              latestInputRevision: r.inputRevision,
              item: copy(r.item),
              workflowId: r.workflowId,
              createdAt: r.createdAt,
            };
          }),
          nextMediaInputId:
            all.length > chosen.length ? chosen.at(-1)[0] : null,
        };
      }
      if (action.endsWith("loadInput")) {
        const versions = records.get(input.mediaInputId);
        const r =
          input.inputRevision === null
            ? versions?.at(-1)
            : versions?.find((r) => r.inputRevision === input.inputRevision);
        return {
          state: r
            ? {
                input: copy(r),
                latestInputRevision: versions.at(-1).inputRevision,
              }
            : null,
        };
      }
      assert.ok(action.endsWith("saveInput"));
      if (gate) {
        const held = gate;
        gate = null;
        await held;
      }
      if (loss === "before") {
        loss = null;
        throw Error("before dispatch response lost");
      }
      if (receipts.has(input.idempotencyKey)) {
        const r = receipts.get(input.idempotencyKey);
        assert.deepEqual(r.command, input);
        return { ...copy(r.response), disposition: "replayed" };
      }
      const { idempotencyKey, expectedInputRevision, ...content } = input,
        mediaInputId = input.mediaInputId ?? "media-" + (records.size + 1);
      const versions = records.get(mediaInputId) ?? [];
      if (versions.length !== expectedInputRevision)
        throw Error("project_media_input_revision_conflict");
      const r = {
        ...copy(content),
        mediaInputId,
        inputRevision: expectedInputRevision + 1,
        contentDigest: digest,
        createdAt: at,
      };
      records.set(mediaInputId, [...versions, r]);
      const response = { disposition: "committed", input: r };
      receipts.set(idempotencyKey, {
        command: copy(input),
        response: copy(response),
      });
      if (loss === "after") {
        loss = null;
        throw Error("COMMIT response lost");
      }
      return response;
    },
  };
  const client = createPluginMediaInputUiClient(
    services,
    projectMediaInputsUiCodec,
  );
  const create = () =>
    new ProjectMediaInputController({
      client,
      assets: assetClient,
      texts: textClient,
      physicalWritesPending: () => physical,
    });
  async function addScript() {
    const response = await queryText("saveScriptCandidate", {
      projectId,
      episodeId: "episode-1",
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: null,
        content: {
          title: "第一集 · 来信",
          scenes: [
            {
              sceneId: "scene-1",
              location: "雨夜车站",
              timeOfDay: "夜",
              action: "林予与许晟相遇。",
              dialogue: [],
            },
          ],
        },
      },
      idempotencyKey: "script-candidate",
    });
    await queryText("selectRevision", {
      projectId,
      artifactId: response.artifact.artifactId,
      request: {
        expectedArtifactRevision: response.artifact.revision,
        contentRevision: 1,
      },
      idempotencyKey: "select-script",
    });
    return response.artifact.artifactId;
  }
  return {
    text,
    details,
    projectId,
    views,
    records,
    calls,
    services,
    client,
    create,
    addScript,
    loss: (where) => {
      loss = where;
    },
    hold: (promise) => {
      gate = promise;
    },
    physical: (value) => {
      physical = value;
    },
    configuration: (value) => {
      configurationRevision = value;
    },
  };
}
export async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
export async function openMedia(f) {
  const c = f.create();
  c.setProject(f.details);
  c.setReady(true);
  c.activate();
  await settle();
  assert.equal(c.getSnapshot().phase, "ready");
  return c;
}
export function characterDraft(c) {
  c.newInput("krea2-reference-four-view");
  c.chooseReference("character", "character-a");
  c.setPrompt("保留林予五官，正面、侧面与背面。");
}
