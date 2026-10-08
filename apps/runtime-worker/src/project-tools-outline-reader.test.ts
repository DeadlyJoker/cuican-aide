import assert from "node:assert/strict";
import test from "node:test";
import { ProjectTextApplicationService } from "@crewon/application";
import { parameterChangeRecipe } from "../../../packages/store/src/project-foundation-store.test-support.ts";
import {
  structuredProjectTextCanonicalJson,
  extensionCanonicalJson,
} from "@crewon/domain";
import type {
  ProjectToolsContentChunk,
  ProjectToolsArtifactView,
} from "@crewon/contracts/project-tools";
import {
  structuredOutlineFixture,
  longOutlineDocument,
  candidate,
  actor,
  selection,
  time,
  digester,
} from "../../../packages/store/src/project-structured-outline.test-support.ts";
import { composeInstalledPluginProjectToolsDependencies } from "./plugins/installed-plugin-project-tools.ts";
import { invokeProjectTool } from "./plugins/project-tools-service-invoke.ts";
import { boundedProjectToolsResponse } from "./plugins/project-tools-service-projection.ts";
import type { ProjectToolsRequests } from "./plugins/project-tools-service-request.ts";
import type { ProjectToolsMethod } from "@crewon/contracts/project-tools";

test("real SQLite mixed outline candidates and selected heads use original bounded Node reads without rewriting history", async (t) => {
  const f = await structuredOutlineFixture(t, "sqlite", longOutlineDocument());
  let allowed = true;
  const dependencies = composeInstalledPluginProjectToolsDependencies({
    store: f.first.parent,
    config: {
      version: "crewon.project-tools.v1",
      authorization: {
        authorize: async () =>
          allowed
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "named-read-withdrawn" },
      },
    },
    resolveActor: async () => actor,
  });
  const projectId = f.created.project.projectId;
  const legacyContent = {
    title: "旧大纲",
    logline: "旧线索",
    synopsis: "历史保持原样",
    episodes: [{ episodeId: "old-episode", title: "旧集", summary: "旧摘要" }],
  };
  const historicalTexts = new ProjectTextApplicationService({
    store: f.first.text,
    projects: f.first.projects,
    authorization: dependencies.authorization,
    clock: { now: () => time(1) },
    ids: { nextId: () => "historical-outline" },
    digester,
  });
  const legacy = await historicalTexts.saveOutlineCandidate(actor, {
    projectId,
    expectedArtifactRevision: 0,
    briefRevision: 1,
    content: legacyContent,
    idempotencyKey: "reader-legacy",
  });
  const structured = await f.first.text.commitStructuredOutlineCandidate(
    candidate(f, "reader-structured", legacy.artifact),
  );
  assert.ok(
    structured.contentRevision?.schemaVersion ===
      "crewon.project-text-revision.v2",
  );
  const read = async (
    method: ProjectToolsMethod,
    request: ProjectToolsRequests[ProjectToolsMethod],
  ) =>
    boundedProjectToolsResponse(
      await invokeProjectTool({
        dependencies,
        actor,
        method,
        request,
        authority: undefined,
        idempotencyKey: undefined,
      }),
    );
  const view = (
    (await read("readOutline", { projectId })) as {
      view: ProjectToolsArtifactView;
    }
  ).view;
  assert.equal(view.artifact.latestContentRevision, 2);
  assert.equal(view.selectedRevision, null);
  await assert.rejects(
    invokeProjectTool({
      dependencies,
      actor,
      method: "saveOutlineCandidate",
      request: {
        projectId,
        expectedArtifactRevision: view.artifact.revision,
        briefRevision: 1,
        content: legacyContent,
      },
      authority: undefined,
      idempotencyKey: "reject-legacy-downgrade",
    }),
    /structured_outline_write_unsupported/,
  );
  const replay = (await invokeProjectTool({
    dependencies,
    actor,
    method: "saveOutlineCandidate",
    request: {
      projectId,
      expectedArtifactRevision: 0,
      briefRevision: 1,
      content: legacyContent,
    },
    authority: undefined,
    idempotencyKey: "reader-legacy",
  })) as { disposition: string };
  assert.equal(replay.disposition, "replayed");
  const canonical = structuredProjectTextCanonicalJson(
    structured.contentRevision.content,
  );
  assert.ok(Buffer.byteLength(canonical) > 64 * 1024);
  const reconstruct = async (contentRevision: number) => {
    let offset = 0;
    const chunks: string[] = [];
    do {
      const page = (await read("readContent", {
        projectId,
        source: {
          kind: "text",
          artifactId: view.artifact.artifactId,
          contentRevision,
        },
        offset,
      })) as ProjectToolsContentChunk;
      assert.ok(Array.from(page.text).length <= 1024);
      assert.equal(page.offset, offset);
      assert.equal(
        page.contentDigest,
        contentRevision === 2
          ? structured.contentRevision!.contentDigest
          : legacy.contentRevision!.contentDigest,
      );
      chunks.push(page.text);
      if (page.nextOffset === null) return chunks.join("");
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    } while (true);
  };
  assert.equal(await reconstruct(2), canonical);
  assert.equal(await reconstruct(1), extensionCanonicalJson(legacyContent));
  const history = (await read("listRevisions", {
    projectId,
    artifactId: view.artifact.artifactId,
    afterContentRevision: 0,
    limit: 4,
  })) as { revisions: { contentRevision: number }[] };
  assert.deepEqual(
    history.revisions.map((r) => r.contentRevision),
    [1, 2],
  );
  const selected = await f.first.text.commitStructuredOutlineSelection(
    selection(
      f,
      "reader-select",
      structured.artifact,
      structured.contentRevision,
    ),
  );
  const adopted = (
    (await read("readOutline", { projectId })) as {
      view: ProjectToolsArtifactView;
    }
  ).view;
  assert.equal(adopted.selectedRevision?.contentRevision, 2);
  assert.equal(adopted.dependencyState, "current");
  assert.equal(adopted.artifact.revision, selected.artifact.revision);
  assert.equal(await f.count("project_text_revisions"), 2);
  await f.foundations.commitFoundationChange(
    parameterChangeRecipe(
      f.created.project,
      f.confirmed.foundation,
      "reader-foundation-change",
      6,
    ),
  );
  await assert.rejects(
    read("readOutline", { projectId }),
    /outline_foundation_stale/,
  );
  assert.equal(
    await reconstruct(2),
    canonical,
    "historical content stays readable after a Foundation change",
  );
  allowed = false;
  await assert.rejects(
    read("readContent", {
      projectId,
      source: {
        kind: "text",
        artifactId: view.artifact.artifactId,
        contentRevision: 2,
      },
      offset: 0,
    }),
    /creative_project_access_denied/,
  );
  assert.equal(await f.count("project_text_revisions"), 2);
});

test("the mixed outline reader preserves legacy script content and absent reader behavior", async (t) => {
  const f = await structuredOutlineFixture(t, "sqlite");
  const dependencies = composeInstalledPluginProjectToolsDependencies({
    store: f.first.parent,
    config: {
      version: "crewon.project-tools.v1",
      authorization: { authorize: async () => ({ outcome: "allow" }) },
    },
    resolveActor: async () => actor,
  });
  const projectId = f.created.project.projectId;
  const content = {
    title: "第一集",
    scenes: [
      {
        sceneId: "scene-1",
        location: "渡口",
        timeOfDay: "夜",
        action: "等待",
        dialogue: [],
      },
    ],
  };
  const saved = await dependencies.texts.saveScriptCandidate(actor, {
    projectId,
    episodeId: "episode-1",
    expectedArtifactRevision: 0,
    briefRevision: 1,
    outline: null,
    content,
    idempotencyKey: "reader-script",
  });
  const request = {
    projectId,
    source: {
      kind: "text" as const,
      artifactId: saved.artifact.artifactId,
      contentRevision: 1,
    },
    offset: 0,
  };
  const full = await invokeProjectTool({
    dependencies,
    method: "readContent",
    request,
    actor,
    authority: undefined,
    idempotencyKey: undefined,
  });
  const { outlines: _outlines, ...legacy } = dependencies;
  const original = await invokeProjectTool({
    dependencies: legacy,
    method: "readContent",
    request,
    actor,
    authority: undefined,
    idempotencyKey: undefined,
  });
  assert.deepEqual(full, original);
  assert.equal(
    (full as ProjectToolsContentChunk).text,
    extensionCanonicalJson(content),
  );
  assert.equal(await f.count("project_text_revisions"), 1);
});
