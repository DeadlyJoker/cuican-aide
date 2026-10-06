import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ProjectMediaInputApplicationService,
  ProjectTextApplicationService,
  type SaveProjectMediaInputCommand,
  type ProjectMediaWorkflowReview,
  type ProjectMediaInputAuthorizationPort,
  projectMediaInputAuthority,
  type ProjectMediaWorkflowId,
} from "@crewon/application";
import { projectMaterialPreparerFixture } from "./project-material-preparer.test-support.ts";
import { selectionVerifier } from "../../../packages/store/src/project-concept-selection.test-support.ts";
import { ProjectReferenceMaterialReader } from "./project-reference-material-reader.ts";
import { ProjectReferenceMaterialFreezer } from "./project-reference-material-freezer.ts";
import { ProjectMaterialPreparer } from "./project-material-preparer.ts";
import { ProjectMediaMaterialPreparer } from "./project-media-material-preparer.ts";
import { materialPng } from "./project-material-png.test-support.ts";

/** Actual selected references, adopted imported script, SQL media archive and encrypted PNG files.
 * External permissions, workflow deployment review, DNS and provider responses remain named fixtures.
 */
export async function projectMediaInputFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: {
    migrate?: boolean;
    sameCharacterBytes?: boolean;
    workflowDigestsFixture?: Partial<Record<ProjectMediaWorkflowId, string>>;
  } = {},
) {
  const f = await projectMaterialPreparerFixture(t, backend);
  const newReference = async (
    kind: "scene" | "character",
    name: string,
    selectionRevision: number,
  ) => {
    const saved = await f.assets.saveCandidate(f.actor, {
      projectId: f.query.projectId,
      assetId: null,
      kind,
      expectedAssetRevision: 0,
      briefRevision: 1,
      script: null,
      content: {
        name,
        setting: `Named ${name} setting`,
        visualPrompt: `Named ${name} visual`,
      },
      idempotencyKey: `asset-${name}`,
    });
    const assetId = saved.asset.assetId;
    await f.assets.selectRevision(f.actor, {
      projectId: f.query.projectId,
      assetId,
      expectedAssetRevision: 1,
      contentRevision: 1,
      idempotencyKey: `content-${name}`,
    });
    await f.assets.saveReferenceCandidate(f.actor, {
      projectId: f.query.projectId,
      assetId,
      expectedAssetRevision: 2,
      assetContentRevision: 1,
      conceptAssetId: f.reference.assetId,
      selectionRevision,
      idempotencyKey: `ref-${name}`,
    });
    await f.assets.selectReference(f.actor, {
      projectId: f.query.projectId,
      assetId,
      expectedAssetRevision: 3,
      referenceRevision: 1,
      idempotencyKey: `select-ref-${name}`,
    });
    return {
      projectId: f.query.projectId,
      assetId,
      kind,
      expectedAssetRevision: 4,
      contentRevision: 1,
      referenceRevision: 1,
    };
  };
  const scene = await newReference("scene", "雨夜旧站", 1);
  await f.selectionStore.commitConceptImageSelection(
    f.secondSelectionInput,
    f.selectionCommitOptions,
  );
  const characterTwo = await newReference("character", "许晟", 2);
  const texts = new ProjectTextApplicationService({
    store: f.parent.projectTextStore(),
    projects: f.parent.creativeProjectStore(),
    authorization: { authorize: async () => f.decision(f.policy.allow) },
    clock: f.dependencies.clock,
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
  });
  const script = await texts.saveScriptCandidate(f.actor, {
    projectId: f.query.projectId,
    episodeId: "episode-1",
    expectedArtifactRevision: 0,
    briefRevision: 1,
    outline: null,
    content: {
      title: "旧站来信",
      scenes: [
        {
          sceneId: "scene-1",
          location: "旧站",
          timeOfDay: "雨夜",
          action: "林予与许晟相遇。",
          dialogue: [{ speaker: "林予", text: "信是谁留下的？" }],
        },
      ],
    },
    idempotencyKey: "media-imported-script",
  });
  await texts.selectRevision(f.actor, {
    projectId: f.query.projectId,
    artifactId: script.artifact.artifactId,
    expectedArtifactRevision: 1,
    contentRevision: 1,
    idempotencyKey: "media-script-selected",
  });
  const mediaPolicy = {
    read: true,
    write: true,
    qualify: true,
    active: true,
    afterGrant: undefined as undefined | (() => Promise<void>),
  };
  const authorization: ProjectMediaInputAuthorizationPort = {
    authorize: async (input) => {
      await mediaPolicy.afterGrant?.();
      return f.decision(
        input.action === "projectMediaInput:read"
          ? mediaPolicy.read
          : input.action === "projectMediaInput:write"
            ? mediaPolicy.write
            : mediaPolicy.qualify,
      );
    },
    assertActive: () => {
      if (!mediaPolicy.active) throw new Error("named_media_owner_retired");
    },
  };
  const reviews: readonly ProjectMediaWorkflowReview[] = [
    {
      targetIdentity: f.reviewedTarget,
      workflow: {
        workflowId: "krea2-reference-four-view",
        workflowDigest:
          options.workflowDigestsFixture?.["krea2-reference-four-view"] ??
          f.digester.sha256("named-deployed-T10-graph"),
        output: { kind: "image", nodeId: "129", dimensions: "workflow-native" },
      },
    },
    {
      targetIdentity: f.reviewedTarget,
      workflow: {
        workflowId: "flux2-three-reference-storyboard",
        workflowDigest:
          options.workflowDigestsFixture?.[
            "flux2-three-reference-storyboard"
          ] ?? f.digester.sha256("named-deployed-D18-graph"),
        output: { kind: "image", nodeId: "17", dimensions: "workflow-native" },
      },
    },
  ];
  const command: SaveProjectMediaInputCommand = {
    projectId: f.query.projectId,
    mediaInputId: null,
    expectedInputRevision: 0,
    item: { kind: "character-reference", assetId: f.query.assetId },
    briefRevision: 1,
    script: null,
    workflowId: "krea2-reference-four-view",
    prompt: "Preserve 林予 identity; four views.",
    references: { character: f.query },
    target: f.request.target,
    idempotencyKey: "save-media-input",
  };
  const d18Command: SaveProjectMediaInputCommand = {
    ...command,
    item: { kind: "storyboard-frame-exploration", episodeId: "episode-1" },
    script: { artifactId: script.artifact.artifactId, contentRevision: 1 },
    workflowId: "flux2-three-reference-storyboard",
    prompt: "At the rainy station, character 1 林予 meets character 2 许晟.",
    references: { scene, characterOne: f.query, characterTwo },
    idempotencyKey: "save-D18-input",
  };
  const open = (next = f) => {
    const store = next.parent
      .projectAssetStore({ verifier: selectionVerifier })
      .projectMediaInputStore();
    const app = new ProjectMediaInputApplicationService({
      store,
      sources: next.sources,
      targets: next.targets,
      reviews,
      authorization,
      ids: { nextMediaInputId: () => randomUUID() },
      clock: f.dependencies.clock,
    });
    const reader = new ProjectReferenceMaterialReader({
      sources: next.sources,
      adapter: {
        deriveReadDestination(source) {
          const url = new URL(source.resultLink.image.url);
          return {
            origin: url.origin + "/",
            path: url.pathname + url.search,
            output: {
              filename: source.resultLink.image.filename,
              subfolder: "named-source-output",
              type: "output",
            },
          };
        },
      },
      authorization: { authorize: async () => f.decision(f.state.readAllowed) },
      clock: f.dependencies.clock,
      dns: { resolveAll: async () => [{ address: "8.8.8.8", family: 4 }] },
      transport: {
        request: async (request) => {
          f.state.sourceGets++;
          return {
            status: 200,
            headers: { "content-type": "image/png" },
            body:
              request.target.endpoint.pathname.endsWith("/1.png") &&
              !options.sameCharacterBytes
                ? materialPng(3, 1)
                : Buffer.from(f.state.bytes),
          };
        },
      },
    });
    const freezer = new ProjectReferenceMaterialFreezer({
        sources: next.sources,
        reader,
        archive: next.archive,
        authorization: {
          authorize: async () => f.decision(f.state.freezeAllowed),
        },
      }),
      preparer = new ProjectMaterialPreparer({ ...next.dependencies, freezer }),
      media = new ProjectMediaMaterialPreparer({
        store,
        preparer,
        reviews,
        authorization,
      });
    return { store, app, media, preparer, freezer };
  };
  const current = open();
  if (options.migrate !== false) await current.store.migrate();
  const cold = async () => {
    const next = await f.cold();
    return { ...next, ...open({ ...f, ...next }) };
  };
  const countMedia = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "project_media_inputs",
          "project_media_input_revisions",
          "project_media_input_receipts",
        ].map(async (name) => [name, await f.count(name)]),
      ),
    );
  const authority = (action: "read" | "write" | "qualify", input = command) =>
    projectMediaInputAuthority({
      actor: f.actor,
      projectId: input.projectId,
      action,
      review:
        action === "read"
          ? null
          : reviews.find((r) => r.workflow.workflowId === input.workflowId)!,
      mediaInputId: input.mediaInputId,
      inputRevision: null,
      command: input,
      authorization,
    });
  return {
    ...f,
    ...current,
    mediaPolicy,
    mediaAuthorization: authorization,
    reviews,
    command,
    d18Command,
    texts,
    script,
    scene,
    characterTwo,
    newReference,
    cold,
    countMedia,
    mediaAuthority: authority,
  };
}
