import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createCreativeProject,
  setCreativeProjectState,
} from "./creative-project.ts";
import { appendProjectBriefRevision } from "./creative-project-revisions.ts";
import {
  parseProjectOutlineContent,
  parseProjectScriptContent,
  projectTextOpaqueId,
} from "./project-text-content.ts";
import { parseProjectTextArtifact } from "./project-text-artifact.ts";
import { parseProjectTextArtifactRevision } from "./project-text-revision.ts";
import {
  projectTextDependencyStatus,
  saveProjectOutlineCandidate,
  saveProjectScriptCandidate,
  selectProjectTextRevision,
  setProjectTextArtifactLocked,
} from "./project-text-mutations.ts";
import type {
  ProjectOutlineRevision,
  ProjectScriptContent,
} from "./project-text-types.ts";

const actor = {
  tenantId: "tenant",
  spaceId: "space",
  principalId: "person",
  actorId: "human",
};
const at = "2026-10-05T00:00:00.000Z";
const digester = {
  sha256: (input: string) =>
    `sha256:${createHash("sha256").update(input).digest("hex")}`,
};
const initial = appendProjectBriefRevision(
  {
    project: createCreativeProject({
      scope: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        projectId: "project",
      },
      actor,
      title: "夜航",
      at,
    }),
    actor,
    expectedProjectRevision: 1,
    text: "三个雨夜的故事",
    at,
  },
  digester,
);
const outlineContent = {
  title: "夜航",
  logline: "修复师发现线索",
  synopsis: "一次雨夜相遇。",
  episodes: [
    { episodeId: "ep-1", title: "第一集", summary: "发现线索" },
    { episodeId: "ep-2", title: "第二集", summary: "追查线索" },
    { episodeId: "ep-3", title: "第三集", summary: "揭开谜团" },
  ],
};
const scriptContent: ProjectScriptContent = {
  title: "第一集",
  scenes: [
    {
      sceneId: "scene-1",
      location: "修复室",
      timeOfDay: "夜",
      action: "她抬起头。",
      dialogue: [{ speaker: "修复师", text: "你终于来了。" }],
    },
  ],
};
function outline() {
  return saveProjectOutlineCandidate(
    {
      ...initial,
      artifact: null,
      artifactId: "outline-1",
      actor,
      expectedArtifactRevision: 0,
      content: outlineContent,
      at,
    },
    digester,
  );
}
function script(source: ProjectOutlineRevision | null = null) {
  return saveProjectScriptCandidate(
    {
      ...initial,
      artifact: null,
      artifactId: "script-1",
      actor,
      expectedArtifactRevision: 0,
      episodeId: "ep-1",
      outline: source,
      content: scriptContent,
      at,
    },
    digester,
  );
}

test("outline and script candidates freeze content, dependencies and actual audit without selecting", () => {
  const mutable = structuredClone(outlineContent);
  const saved = saveProjectOutlineCandidate(
    {
      ...initial,
      artifact: null,
      artifactId: "outline-1",
      actor,
      expectedArtifactRevision: 0,
      content: mutable,
      at,
    },
    digester,
  );
  mutable.episodes[0]!.summary = "changed";
  assert.equal(saved.artifact.revision, 1);
  assert.equal(saved.artifact.selectedContentRevision, null);
  assert.equal(saved.contentRevision.kind, "outline");
  assert.equal(
    saved.contentRevision.contentDigest,
    parseProjectTextArtifactRevision(saved.contentRevision, digester)
      .contentDigest,
  );
  assert.equal(
    saved.contentRevision.brief.contentDigest,
    initial.brief.contentDigest,
  );
  assert.ok(Object.isFrozen(saved.contentRevision.content));
  assert.equal(initial.project.revision, 2);
  assert.equal(
    parseProjectTextArtifact(saved.artifact).ownerPrincipalId,
    actor.principalId,
  );
});
test("scripts may be imported independently without invented outline provenance", () => {
  const saved = script();
  assert.equal(saved.contentRevision.kind, "script");
  assert.equal(saved.contentRevision.outline, null);
  const selected = selectProjectTextRevision(
    {
      ...initial,
      actor,
      artifact: saved.artifact,
      expectedArtifactRevision: 1,
      contentRevision: saved.contentRevision,
      latestBrief: initial.brief,
      selectedOutline: null,
      at,
    },
    digester,
  );
  assert.equal(selected.artifact.selectedContentRevision, 1);
});
test("a supplied outline must be the same project, include the episode and freeze the same brief", () => {
  const source = outline().contentRevision as ProjectOutlineRevision;
  assert.equal(
    script(source).contentRevision.outline?.contentDigest,
    source.contentDigest,
  );
  assert.throws(
    () =>
      saveProjectScriptCandidate(
        {
          ...initial,
          artifact: null,
          artifactId: "script",
          actor,
          expectedArtifactRevision: 0,
          episodeId: "missing",
          outline: source,
          content: scriptContent,
          at,
        },
        digester,
      ),
    /project_text_outline_reference_invalid/,
  );
  const next = appendProjectBriefRevision(
    {
      project: initial.project,
      actor,
      expectedProjectRevision: 2,
      text: "新需求",
      at,
    },
    digester,
  );
  assert.throws(
    () =>
      saveProjectScriptCandidate(
        {
          ...next,
          artifact: null,
          artifactId: "script",
          actor,
          expectedArtifactRevision: 0,
          episodeId: "ep-1",
          outline: source,
          content: scriptContent,
          at,
        },
        digester,
      ),
    /project_text_outline_reference_invalid/,
  );
});
test("candidate append preserves a locked selected revision and uses independent head CAS", () => {
  const first = outline();
  const selected = selectProjectTextRevision(
    {
      ...initial,
      actor,
      artifact: first.artifact,
      expectedArtifactRevision: 1,
      contentRevision: first.contentRevision,
      latestBrief: initial.brief,
      selectedOutline: null,
      at,
    },
    digester,
  );
  const locked = setProjectTextArtifactLocked({
    ...initial,
    actor,
    artifact: selected.artifact,
    expectedArtifactRevision: 2,
    locked: true,
    at,
  });
  const candidate = saveProjectOutlineCandidate(
    {
      ...initial,
      actor,
      artifact: locked.artifact,
      artifactId: locked.artifact.artifactId,
      expectedArtifactRevision: 3,
      content: { ...outlineContent, logline: "另一个候选" },
      at,
    },
    digester,
  );
  assert.equal(candidate.artifact.selectedContentRevision, 1);
  assert.equal(candidate.artifact.locked, true);
  assert.equal(candidate.artifact.latestContentRevision, 2);
  assert.throws(
    () =>
      selectProjectTextRevision(
        {
          ...initial,
          actor,
          artifact: candidate.artifact,
          expectedArtifactRevision: 4,
          contentRevision: candidate.contentRevision,
          latestBrief: initial.brief,
          selectedOutline: null,
          at,
        },
        digester,
      ),
    /project_text_locked/,
  );
  assert.throws(
    () =>
      saveProjectOutlineCandidate(
        {
          ...initial,
          actor,
          artifact: candidate.artifact,
          artifactId: "outline-1",
          expectedArtifactRevision: 3,
          content: outlineContent,
          at,
        },
        digester,
      ),
    /project_text_revision_conflict/,
  );
  assert.throws(
    () =>
      setProjectTextArtifactLocked({
        ...initial,
        actor,
        artifact: first.artifact,
        expectedArtifactRevision: 1,
        locked: true,
        at,
      }),
    /project_text_selection_required/,
  );
});
test("brief and selected outline changes are explicit stale projections, never rewrites", () => {
  const source = outline().contentRevision as ProjectOutlineRevision;
  const saved = script(source);
  assert.equal(
    projectTextDependencyStatus(saved.contentRevision, initial.brief, source)
      .dependencyState,
    "current",
  );
  assert.deepEqual(
    projectTextDependencyStatus(saved.contentRevision, initial.brief, null)
      .staleReasons,
    ["outline-selection-changed"],
  );
  const changed = appendProjectBriefRevision(
    {
      project: initial.project,
      actor,
      expectedProjectRevision: 2,
      text: "新需求",
      at,
    },
    digester,
  );
  assert.deepEqual(
    projectTextDependencyStatus(saved.contentRevision, changed.brief, source)
      .staleReasons,
    ["brief-changed"],
  );
  assert.throws(
    () =>
      selectProjectTextRevision(
        {
          project: changed.project,
          actor,
          artifact: saved.artifact,
          expectedArtifactRevision: 1,
          contentRevision: saved.contentRevision,
          latestBrief: changed.brief,
          selectedOutline: source,
          at,
        },
        digester,
      ),
    /project_text_dependencies_stale/,
  );
  assert.equal(saved.artifact.selectedContentRevision, null);
});
test("strict content rejects duplicate local identities, unknown fields, invalid Unicode and UTF8 overflow", () => {
  assert.throws(
    () =>
      parseProjectOutlineContent({
        ...outlineContent,
        episodes: [outlineContent.episodes[0], outlineContent.episodes[0]],
      }),
    /project_text_duplicate_item/,
  );
  assert.throws(
    () =>
      parseProjectScriptContent({
        ...scriptContent,
        scenes: [scriptContent.scenes[0], scriptContent.scenes[0]],
      }),
    /project_text_duplicate_item/,
  );
  assert.throws(
    () => parseProjectOutlineContent({ ...outlineContent, extra: true }),
    /fields_invalid/,
  );
  assert.throws(
    () =>
      parseProjectOutlineContent({
        ...outlineContent,
        logline: "汉".repeat(683),
      }),
    /project_text_content_limit/,
  );
  assert.throws(
    () => parseProjectScriptContent({ ...scriptContent, title: "\ud800" }),
    /json_invalid/,
  );
  assert.throws(
    () =>
      parseProjectScriptContent({
        title: "空场次",
        scenes: [{ ...scriptContent.scenes[0], action: "", dialogue: [] }],
      }),
    /project_text_content_invalid/,
  );
});
test("parsers do not invoke accessors and reject tampered immutable digests", () => {
  let reads = 0;
  const input = {
    ...outlineContent,
    get synopsis() {
      reads++;
      return "secret";
    },
  };
  assert.throws(() => parseProjectOutlineContent(input), /json_invalid/);
  assert.equal(reads, 0);
  const saved = outline();
  assert.throws(
    () =>
      parseProjectTextArtifactRevision(
        { ...saved.contentRevision, contentDigest: `sha256:${"0".repeat(64)}` },
        digester,
      ),
    /project_text_digest_mismatch/,
  );
  assert.throws(
    () =>
      parseProjectTextArtifact({
        ...saved.artifact,
        selectedContentRevision: 2,
      }),
    /project_text_artifact_invalid/,
  );
  assert.throws(
    () =>
      parseProjectTextArtifact({
        ...saved.artifact,
        updatedAt: "2026-10-04T23:59:59.000Z",
      }),
    /project_text_artifact_invalid/,
  );
});
test("owner, project scope and archived project boundaries remain enforced", () => {
  assert.throws(
    () =>
      saveProjectOutlineCandidate(
        {
          ...initial,
          artifact: null,
          artifactId: "outline",
          actor: { ...actor, principalId: "other" },
          expectedArtifactRevision: 0,
          content: outlineContent,
          at,
        },
        digester,
      ),
    /creative_project_owner_mismatch/,
  );
  assert.throws(
    () =>
      saveProjectOutlineCandidate(
        {
          ...initial,
          artifact: null,
          artifactId: "outline",
          actor: { ...actor, tenantId: "other" },
          expectedArtifactRevision: 0,
          content: outlineContent,
          at,
        },
        digester,
      ),
    /creative_project_scope_mismatch/,
  );
  const archived = setCreativeProjectState({
    project: initial.project,
    actor,
    expectedProjectRevision: 2,
    state: "archived",
    at,
  });
  assert.throws(
    () =>
      saveProjectOutlineCandidate(
        {
          project: archived,
          brief: initial.brief,
          artifact: null,
          artifactId: "outline",
          actor,
          expectedArtifactRevision: 0,
          content: outlineContent,
          at,
        },
        digester,
      ),
    /creative_project_archived/,
  );
});

test("new text locators reject dot segments while preserving opaque non-dot identities", () => {
  for (const id of [".", ".."]) {
    assert.throws(
      () => projectTextOpaqueId(id),
      /project_text_identity_invalid/,
    );
    assert.throws(
      () =>
        parseProjectOutlineContent({
          ...outlineContent,
          episodes: [{ ...outlineContent.episodes[0], episodeId: id }],
        }),
      /project_text_identity_invalid/,
    );
    assert.throws(
      () =>
        parseProjectScriptContent({
          ...scriptContent,
          scenes: [{ ...scriptContent.scenes[0], sceneId: id }],
        }),
      /project_text_identity_invalid/,
    );
    assert.throws(
      () =>
        saveProjectOutlineCandidate(
          {
            ...initial,
            artifact: null,
            artifactId: id,
            actor,
            expectedArtifactRevision: 0,
            content: outlineContent,
            at,
          },
          digester,
        ),
      /project_text_identity_invalid/,
    );
  }
  assert.equal(projectTextOpaqueId("episode/一"), "episode/一");
});
