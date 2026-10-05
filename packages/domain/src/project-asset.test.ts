import assert from "node:assert/strict";
import test from "node:test";
import { appendProjectBriefRevision } from "./creative-project-revisions.ts";
import { saveProjectScriptCandidate } from "./project-text-mutations.ts";
import {
  parseProjectAsset,
  parseProjectAssetRevision,
} from "./project-asset-records.ts";
import {
  saveProjectAssetCandidate,
  selectProjectAssetRevision,
  setProjectAssetLocked,
  projectAssetDependencyStatus,
} from "./project-asset-mutations.ts";
import {
  saveProjectAssetReferenceCandidate,
  selectProjectAssetReferenceRevision,
  parseProjectAssetReferenceRevision,
  projectAssetReferenceState,
} from "./project-asset-reference.ts";
import { parseProjectAssetContent } from "./project-asset-validation.ts";
import {
  assetActor as actor,
  assetAt as at,
  assetDigester as digester,
  projectAssetDomainFixture,
} from "./project-asset.test-support.ts";
function selected() {
  const f = projectAssetDomainFixture();
  const result = selectProjectAssetRevision(
    {
      project: f.project,
      actor,
      asset: f.asset,
      expectedAssetRevision: 1,
      contentRevision: f.content,
      latestBrief: f.brief,
      selectedScript: null,
      at,
    },
    digester,
  );
  return { ...f, asset: result.asset };
}
function reference() {
  const f = selected(),
    result = saveProjectAssetReferenceCandidate(
      {
        project: f.project,
        actor,
        asset: f.asset,
        expectedAssetRevision: f.asset.revision,
        contentRevision: f.content,
        conceptSelection: f.selection,
        resultLink: f.resultLink,
        expectedConceptSelectionRevision: 1,
        at,
      },
      digester,
    );
  return { ...f, asset: result.asset, reference: result.referenceRevision };
}
test("three asset kinds save detached immutable candidates without selecting or changing the project", () => {
  const f = projectAssetDomainFixture();
  for (const kind of ["character", "scene", "prop"] as const) {
    const result = saveProjectAssetCandidate(
      {
        project: f.project,
        actor,
        asset: null,
        assetId: kind,
        kind,
        expectedAssetRevision: 0,
        brief: f.brief,
        script: null,
        content: f.content.content,
        at,
      },
      digester,
    );
    assert.equal(result.asset.selectedContentRevision, null);
    assert.equal(result.asset.latestReferenceRevision, 0);
    assert.equal(result.asset.locked, false);
    assert.equal(result.asset.kind, kind);
    assert.ok(Object.isFrozen(result.contentRevision.content));
    assert.deepEqual(
      parseProjectAssetRevision(result.contentRevision, digester),
      result.contentRevision,
    );
  }
  assert.equal(f.project.revision, 3);
});
test("persistent lock preserves both adopted pointers while permitting new content candidates", () => {
  const f = selected(),
    locked = setProjectAssetLocked({
      project: f.project,
      actor,
      asset: f.asset,
      expectedAssetRevision: f.asset.revision,
      locked: true,
      at,
    }).asset;
  const saved = saveProjectAssetCandidate(
    {
      project: f.project,
      actor,
      asset: locked,
      assetId: locked.assetId,
      kind: "character",
      expectedAssetRevision: locked.revision,
      brief: f.brief,
      script: null,
      content: { ...f.content.content, setting: "新的候选" },
      at,
    },
    digester,
  );
  assert.equal(saved.asset.locked, true);
  assert.equal(saved.asset.selectedContentRevision, 1);
  assert.equal(saved.contentRevision.contentRevision, 2);
  assert.throws(
    () =>
      selectProjectAssetRevision(
        {
          project: f.project,
          actor,
          asset: saved.asset,
          expectedAssetRevision: saved.asset.revision,
          contentRevision: saved.contentRevision,
          latestBrief: f.brief,
          selectedScript: null,
          at,
        },
        digester,
      ),
    /locked/,
  );
  assert.equal(
    selectProjectAssetRevision(
      {
        project: f.project,
        actor,
        asset: saved.asset,
        expectedAssetRevision: saved.asset.revision,
        contentRevision: f.content,
        latestBrief: f.brief,
        selectedScript: null,
        at,
      },
      digester,
    ).asset.selectedContentRevision,
    1,
  );
});
test("CAS, owner, identity, archive and head invariants fail closed", () => {
  const f = selected(),
    input = {
      project: f.project,
      actor,
      asset: f.asset,
      expectedAssetRevision: f.asset.revision,
      locked: true,
      at,
    };
  assert.throws(
    () => setProjectAssetLocked({ ...input, expectedAssetRevision: 1 }),
    /revision_conflict/,
  );
  assert.throws(
    () =>
      setProjectAssetLocked({
        ...input,
        actor: { ...actor, principalId: "other" },
      }),
    /owner_mismatch/,
  );
  assert.throws(
    () =>
      setProjectAssetLocked({
        ...input,
        actor: { ...actor, tenantId: "other" },
      }),
    /scope_mismatch/,
  );
  assert.throws(
    () =>
      setProjectAssetLocked({
        ...input,
        project: { ...f.project, state: "archived" },
      }),
    /archived/,
  );
  assert.throws(
    () =>
      parseProjectAsset({ ...f.asset, updatedAt: "2025-01-01T00:00:00.000Z" }),
    /head_invalid/,
  );
  assert.throws(
    () => parseProjectAsset({ ...f.asset, selectedReferenceRevision: 1 }),
    /head_invalid/,
  );
  assert.throws(
    () =>
      saveProjectAssetCandidate(
        {
          project: f.project,
          actor,
          asset: f.asset,
          assetId: f.asset.assetId,
          kind: "scene",
          expectedAssetRevision: f.asset.revision,
          brief: f.brief,
          script: null,
          content: f.content.content,
          at,
        },
        digester,
      ),
    /identity_mismatch/,
  );
});
test("late candidates retain historical brief and nullable manual script provenance but adoption requires current sources", () => {
  const f = selected(),
    updated = appendProjectBriefRevision(
      {
        project: f.project,
        actor,
        expectedProjectRevision: 3,
        text: "新需求",
        at,
      },
      digester,
    );
  const late = saveProjectAssetCandidate(
    {
      project: updated.project,
      actor,
      asset: f.asset,
      assetId: f.asset.assetId,
      kind: "character",
      expectedAssetRevision: f.asset.revision,
      brief: f.brief,
      script: null,
      content: f.content.content,
      at,
    },
    digester,
  );
  assert.deepEqual(late.contentRevision.brief, f.content.brief);
  assert.equal(late.contentRevision.script, null);
  assert.deepEqual(
    projectAssetDependencyStatus(late.contentRevision, updated.brief, null),
    { dependencyState: "stale", staleReasons: ["brief-changed"] },
  );
  assert.throws(
    () =>
      selectProjectAssetRevision(
        {
          project: updated.project,
          actor,
          asset: late.asset,
          expectedAssetRevision: late.asset.revision,
          contentRevision: late.contentRevision,
          latestBrief: updated.brief,
          selectedScript: null,
          at,
        },
        digester,
      ),
    /source_stale/,
  );
});
test("script sources freeze actual episode and revision, and another selected script makes them stale", () => {
  const f = projectAssetDomainFixture(),
    saved = saveProjectAssetCandidate(
      {
        project: f.project,
        actor,
        asset: null,
        assetId: "prop",
        kind: "prop",
        expectedAssetRevision: 0,
        brief: f.brief,
        script: f.script,
        content: f.content.content,
        at,
      },
      digester,
    );
  assert.equal(saved.contentRevision.script?.episodeId, "episode-1");
  assert.equal(
    projectAssetDependencyStatus(saved.contentRevision, f.brief, f.script)
      .dependencyState,
    "current",
  );
  const changed = saveProjectScriptCandidate(
    {
      project: f.project,
      actor,
      artifact: null,
      artifactId: "other-script",
      episodeId: "episode-1",
      expectedArtifactRevision: 0,
      brief: f.brief,
      outline: null,
      content: f.script.content,
      at,
    },
    digester,
  );
  assert.equal(changed.contentRevision.kind, "script");
  assert.deepEqual(
    projectAssetDependencyStatus(
      saved.contentRevision,
      f.brief,
      changed.contentRevision as typeof f.script,
    ).staleReasons,
    ["script-selection-changed"],
  );
});
test("image references freeze the original result identity and are not URLs, filenames or byte hashes", () => {
  const f = reference();
  assert.equal(f.asset.selectedReferenceRevision, null);
  assert.equal(f.reference.assetContentDigest, f.content.contentDigest);
  assert.equal(f.reference.source.resultLinkDigest, f.resultLink.contentDigest);
  assert.equal(f.reference.source.sourceRunId, "R-original");
  assert.equal(
    f.reference.source.configurationDigest,
    f.resultLink.configurationDigest,
  );
  assert.equal(f.reference.source.operationRevision, 3);
  assert.equal(
    f.reference.source.conceptSelectionDigest,
    f.selection.contentDigest,
  );
  assert.equal(f.reference.source.resultIndex, 0);
  assert.equal("url" in f.reference.source, false);
  assert.equal("filename" in f.reference.source, false);
  assert.deepEqual(
    parseProjectAssetReferenceRevision(f.reference, digester),
    f.reference,
  );
  assert.ok(Object.isFrozen(f.reference.source));
});
test("reference candidates are allowed under lock, but adopting a different anchor is refused", () => {
  const f = reference(),
    adopted = selectProjectAssetReferenceRevision(
      {
        project: f.project,
        actor,
        asset: f.asset,
        expectedAssetRevision: f.asset.revision,
        selectedContentRevision: f.content,
        referenceRevision: f.reference,
        at,
      },
      digester,
    ),
    locked = setProjectAssetLocked({
      project: f.project,
      actor,
      asset: adopted.asset,
      expectedAssetRevision: adopted.asset.revision,
      locked: true,
      at,
    }).asset,
    candidate = saveProjectAssetReferenceCandidate(
      {
        project: f.project,
        actor,
        asset: locked,
        expectedAssetRevision: locked.revision,
        contentRevision: f.content,
        conceptSelection: f.selection,
        resultLink: f.resultLink,
        expectedConceptSelectionRevision: 1,
        at,
      },
      digester,
    );
  assert.equal(candidate.asset.selectedReferenceRevision, 1);
  assert.equal(candidate.asset.locked, true);
  assert.throws(
    () =>
      selectProjectAssetReferenceRevision(
        {
          project: f.project,
          actor,
          asset: candidate.asset,
          expectedAssetRevision: candidate.asset.revision,
          selectedContentRevision: f.content,
          referenceRevision: candidate.referenceRevision,
          at,
        },
        digester,
      ),
    /locked/,
  );
});
test("changing adopted content retains the old anchor as stale rather than silently retargeting it", () => {
  const f = reference(),
    adopted = selectProjectAssetReferenceRevision(
      {
        project: f.project,
        actor,
        asset: f.asset,
        expectedAssetRevision: f.asset.revision,
        selectedContentRevision: f.content,
        referenceRevision: f.reference,
        at,
      },
      digester,
    ),
    saved = saveProjectAssetCandidate(
      {
        project: f.project,
        actor,
        asset: adopted.asset,
        assetId: f.asset.assetId,
        kind: "character",
        expectedAssetRevision: adopted.asset.revision,
        brief: f.brief,
        script: null,
        content: { ...f.content.content, name: "新设定" },
        at,
      },
      digester,
    ),
    selected = selectProjectAssetRevision(
      {
        project: f.project,
        actor,
        asset: saved.asset,
        expectedAssetRevision: saved.asset.revision,
        contentRevision: saved.contentRevision,
        latestBrief: f.brief,
        selectedScript: null,
        at,
      },
      digester,
    );
  assert.equal(selected.asset.selectedReferenceRevision, 1);
  assert.equal(
    projectAssetReferenceState(
      selected.asset,
      saved.contentRevision,
      f.reference,
    ),
    "stale",
  );
  assert.throws(
    () =>
      selectProjectAssetReferenceRevision(
        {
          project: f.project,
          actor,
          asset: selected.asset,
          expectedAssetRevision: selected.asset.revision,
          selectedContentRevision: saved.contentRevision,
          referenceRevision: f.reference,
          at,
        },
        digester,
      ),
    /reference_stale/,
  );
});
test("reference source requires exact concept selection CAS, same project and an intact result digest", () => {
  const f = selected(),
    input = {
      project: f.project,
      actor,
      asset: f.asset,
      expectedAssetRevision: f.asset.revision,
      contentRevision: f.content,
      conceptSelection: f.selection,
      resultLink: f.resultLink,
      expectedConceptSelectionRevision: 1,
      at,
    };
  assert.throws(
    () =>
      saveProjectAssetReferenceCandidate(
        { ...input, expectedConceptSelectionRevision: 2 },
        digester,
      ),
    /selection_changed/,
  );
  assert.throws(
    () =>
      saveProjectAssetReferenceCandidate(
        {
          ...input,
          resultLink: {
            ...f.resultLink,
            image: { ...f.resultLink.image, url: "https://foreign.example/" },
          },
        },
        digester,
      ),
    /operation_result_link_invalid/,
  );
  assert.throws(
    () =>
      saveProjectAssetReferenceCandidate(
        { ...input, project: { ...f.project, projectId: "foreign" } },
        digester,
      ),
    /scope_mismatch/,
  );
});
test("record and recipe accessors, custom prototypes, cycles and dot locators never run caller code", () => {
  const f = selected();
  let reads = 0;
  const getter = { ...f.asset };
  Object.defineProperty(getter, "kind", {
    enumerable: true,
    get: () => {
      reads++;
      return "character";
    },
  });
  assert.throws(() => parseProjectAsset(getter));
  const input = {
    project: f.project,
    actor,
    asset: f.asset,
    expectedAssetRevision: f.asset.revision,
    locked: true,
    at,
  };
  Object.defineProperty(input, "asset", {
    enumerable: true,
    get: () => {
      reads++;
      return f.asset;
    },
  });
  assert.throws(() => setProjectAssetLocked(input));
  assert.equal(reads, 0);
  assert.throws(() =>
    parseProjectAsset(Object.assign(Object.create({}), f.asset)),
  );
  assert.throws(() => parseProjectAsset({ ...f.asset, assetId: ".." }));
  const cycle: Record<string, unknown> = { ...f.asset };
  cycle.assetId = cycle;
  assert.throws(() => parseProjectAsset(cycle));
});
test("content preserves multiline text, enforces UTF8 and scalar bounds, and rejects mutated digests", () => {
  const f = projectAssetDomainFixture();
  assert.equal(
    parseProjectAssetContent(f.content.content).visualPrompt,
    f.content.content.visualPrompt,
  );
  assert.throws(() =>
    parseProjectAssetContent({
      ...f.content.content,
      visualPrompt: "界".repeat(667),
    }),
  );
  assert.throws(() =>
    parseProjectAssetContent({
      ...f.content.content,
      setting: "a".repeat(6145),
    }),
  );
  assert.throws(() =>
    parseProjectAssetContent({ ...f.content.content, name: "\ud800" }),
  );
  assert.throws(
    () =>
      parseProjectAssetRevision(
        { ...f.content, content: { ...f.content.content, name: "伪修改" } },
        digester,
      ),
    /digest_mismatch/,
  );
  assert.throws(() =>
    parseProjectAssetReferenceRevision(
      {
        ...reference().reference,
        source: { ...reference().reference.source, resultIndex: 16 },
      },
      digester,
    ),
  );
});
