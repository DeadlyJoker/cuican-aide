import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import type { CreativeProjectCommitOptions } from "./creative-project-store-port.ts";
import { deferred } from "./creative-project.test-support.ts";
import {
  actor,
  createProjectTextFixture,
  outlineCommand,
  outlineContent,
  scriptContent,
} from "./project-text.test-support.ts";

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError && error.code === code;
}
test("shared commands save three-episode outline and independent script without altering project or selecting candidates", async () => {
  const f = await createProjectTextFixture();
  const saved = await f.service.saveOutlineCandidate(
    actor,
    outlineCommand(f.project.projectId),
  );
  assert.equal(saved.artifact.latestContentRevision, 1);
  assert.equal(saved.artifact.selectedContentRevision, null);
  const imported = await f.service.saveScriptCandidate(actor, {
    projectId: f.project.projectId,
    episodeId: "outside-episode",
    expectedArtifactRevision: 0,
    briefRevision: 1,
    outline: null,
    content: scriptContent,
    idempotencyKey: "import",
  });
  assert.equal(imported.contentRevision?.outline, null);
  const view = await f.service.getArtifact(actor, {
    projectId: f.project.projectId,
    artifactId: imported.artifact.artifactId,
  });
  assert.equal(view?.dependencyState, "unselected");
  assert.equal(view?.selectedRevision, null);
  assert.deepEqual(
    await f.original.service.getProject(actor, {
      projectId: f.project.projectId,
    }),
    f.project,
  );
});
test("same key returns the original receipt after later state changes and changed input conflicts", async () => {
  const f = await createProjectTextFixture();
  const command = outlineCommand(f.project.projectId);
  const saved = await f.service.saveOutlineCandidate(actor, command);
  await f.original.service.setProjectState(actor, {
    projectId: f.project.projectId,
    state: "archived",
    expectedProjectRevision: f.project.revision,
    idempotencyKey: "archive",
  });
  const replay = await f.service.saveOutlineCandidate(actor, command);
  assert.deepEqual(replay, { ...saved, disposition: "replayed" });
  assert.equal(f.store.commits.length, 1);
  await assert.rejects(
    f.service.saveOutlineCandidate(actor, {
      ...command,
      content: { ...outlineContent, synopsis: "changed" },
    }),
    hasCode("project_text_idempotency_conflict"),
  );
  await assert.rejects(
    f.service.saveOutlineCandidate(actor, {
      ...command,
      expectedArtifactRevision: 1,
      idempotencyKey: "new",
    }),
    hasCode("creative_project_archived"),
  );
});
test("selection, manual revision and late candidate never overwrite selected content; locked selection preserves choice", async () => {
  const f = await createProjectTextFixture();
  const first = await f.service.saveScriptCandidate(actor, {
    projectId: f.project.projectId,
    episodeId: "ep-1",
    expectedArtifactRevision: 0,
    briefRevision: 1,
    outline: null,
    content: scriptContent,
    idempotencyKey: "script",
  });
  const selected = await f.service.selectRevision(actor, {
    projectId: f.project.projectId,
    artifactId: first.artifact.artifactId,
    expectedArtifactRevision: 1,
    contentRevision: 1,
    idempotencyKey: "select",
  });
  const manual = await f.service.saveScriptCandidate(actor, {
    projectId: f.project.projectId,
    episodeId: "ep-1",
    expectedArtifactRevision: 2,
    briefRevision: 1,
    outline: null,
    content: { ...scriptContent, title: "人工修订" },
    idempotencyKey: "manual",
  });
  assert.equal(manual.artifact.selectedContentRevision, 1);
  const locked = await f.service.setLocked(actor, {
    projectId: f.project.projectId,
    artifactId: first.artifact.artifactId,
    expectedArtifactRevision: 3,
    locked: true,
    idempotencyKey: "lock",
  });
  await f.service.saveScriptCandidate(actor, {
    projectId: f.project.projectId,
    episodeId: "ep-1",
    expectedArtifactRevision: 4,
    briefRevision: 1,
    outline: null,
    content: { ...scriptContent, title: "晚到候选" },
    idempotencyKey: "late",
  });
  await assert.rejects(
    f.service.selectRevision(actor, {
      projectId: f.project.projectId,
      artifactId: first.artifact.artifactId,
      expectedArtifactRevision: 5,
      contentRevision: 2,
      idempotencyKey: "replace",
    }),
    hasCode("project_text_locked"),
  );
  const view = await f.service.getScript(actor, {
    projectId: f.project.projectId,
    episodeId: "ep-1",
  });
  assert.equal(
    view?.selectedRevision?.content.title,
    selected.contentRevision?.content.title,
  );
  assert.equal(view?.artifact.locked, locked.artifact.locked);
});
test("real outline episode references are checked and selected scripts become visibly stale after upstream selection", async () => {
  const f = await createProjectTextFixture();
  const outline = await f.service.saveOutlineCandidate(
    actor,
    outlineCommand(f.project.projectId),
  );
  await f.service.selectRevision(actor, {
    projectId: f.project.projectId,
    artifactId: outline.artifact.artifactId,
    expectedArtifactRevision: 1,
    contentRevision: 1,
    idempotencyKey: "outline-select",
  });
  const common = {
    projectId: f.project.projectId,
    expectedArtifactRevision: 0,
    briefRevision: 1,
    outline: { artifactId: outline.artifact.artifactId, contentRevision: 1 },
    content: scriptContent,
  };
  await assert.rejects(
    f.service.saveScriptCandidate(actor, {
      ...common,
      episodeId: "missing",
      idempotencyKey: "missing",
    }),
    hasCode("project_text_outline_reference_invalid"),
  );
  const script = await f.service.saveScriptCandidate(actor, {
    ...common,
    episodeId: "ep-1",
    idempotencyKey: "script",
  });
  await f.service.selectRevision(actor, {
    projectId: f.project.projectId,
    artifactId: script.artifact.artifactId,
    expectedArtifactRevision: 1,
    contentRevision: 1,
    idempotencyKey: "script-select",
  });
  await f.service.saveOutlineCandidate(actor, {
    ...outlineCommand(f.project.projectId, "outline-2"),
    expectedArtifactRevision: 2,
    content: { ...outlineContent, logline: "新的大纲" },
  });
  await f.service.selectRevision(actor, {
    projectId: f.project.projectId,
    artifactId: outline.artifact.artifactId,
    expectedArtifactRevision: 3,
    contentRevision: 2,
    idempotencyKey: "new-outline-select",
  });
  const view = await f.service.getScript(actor, {
    projectId: f.project.projectId,
    episodeId: "ep-1",
  });
  assert.deepEqual(view?.staleReasons, ["outline-selection-changed"]);
  assert.equal(view?.artifact.selectedContentRevision, 1);
  await assert.rejects(
    f.service.selectRevision(actor, {
      projectId: f.project.projectId,
      artifactId: script.artifact.artifactId,
      expectedArtifactRevision: 2,
      contentRevision: 1,
      idempotencyKey: "stale-select",
    }),
    hasCode("project_text_dependencies_stale"),
  );
});
test("reads and writes are current-principal scoped; corrupt foreign Store records fail closed", async () => {
  const f = await createProjectTextFixture();
  const saved = await f.service.saveOutlineCandidate(
    actor,
    outlineCommand(f.project.projectId),
  );
  for (const foreign of [
    { ...actor, principalId: "other" },
    { ...actor, tenantId: "other" },
    { ...actor, spaceId: "other" },
  ]) {
    await assert.rejects(
      f.service.getArtifact(foreign, {
        projectId: f.project.projectId,
        artifactId: saved.artifact.artifactId,
      }),
      hasCode("creative_project_not_found"),
    );
    await assert.rejects(
      f.service.saveOutlineCandidate(
        foreign,
        outlineCommand(f.project.projectId, "foreign"),
      ),
      hasCode("creative_project_not_found"),
    );
  }
  f.store.override = (method, value) =>
    method === "loadArtifact"
      ? { ...saved.artifact, ownerPrincipalId: "other" }
      : value;
  await assert.rejects(
    f.service.getArtifact(actor, {
      projectId: f.project.projectId,
      artifactId: saved.artifact.artifactId,
    }),
    hasCode("project_text_store_result_invalid"),
  );
  assert.equal(f.store.commits.length, 1);
});
test("late read authorization withdrawal rejects the projection", async () => {
  const f = await createProjectTextFixture();
  const saved = await f.service.saveOutlineCandidate(
    actor,
    outlineCommand(f.project.projectId),
  );
  f.store.before = async (method) => {
    if (method === "loadArtifact") f.denied = true;
  };
  await assert.rejects(
    f.service.getArtifact(actor, {
      projectId: f.project.projectId,
      artifactId: saved.artifact.artifactId,
    }),
    hasCode("authorization_denied"),
  );
});
test("commit policy fence refuses withdrawal while awaiting transaction work even without caller authority", async () => {
  const f = await createProjectTextFixture();
  f.store.beforeCommit = async () => {
    f.denied = true;
  };
  await assert.rejects(
    f.service.saveOutlineCandidate(actor, outlineCommand(f.project.projectId)),
    hasCode("authorization_denied"),
  );
  assert.equal(f.store.commits.length, 0);
  assert.equal(f.store.receipts.size, 0);
});
test("caller sync fence withdraws before commit, but confirmed commit is not changed into failure", async () => {
  const f = await createProjectTextFixture();
  let withdrawn = false;
  const options = {
    authority: {
      assertCurrent: async () => {},
      assertActive: () => {
        if (withdrawn) throw new Error("withdrawn");
      },
    },
  };
  f.store.beforeCommit = async () => {
    withdrawn = true;
  };
  await assert.rejects(
    f.service.saveOutlineCandidate(
      actor,
      outlineCommand(f.project.projectId),
      options,
    ),
  );
  assert.equal(f.store.commits.length, 0);
  withdrawn = false;
  f.store.beforeCommit = null;
  f.store.afterCommit = () => {
    withdrawn = true;
    f.denied = true;
  };
  const saved = await f.service.saveOutlineCandidate(
    actor,
    outlineCommand(f.project.projectId),
    options,
  );
  assert.equal(saved.disposition, "committed");
  assert.equal(f.store.commits.length, 1);
});
test("old UI transaction qualifier is explicitly rejected without invoking getters", async () => {
  const f = await createProjectTextFixture();
  let gets = 0;
  const unsupported = {
    authority: {
      assertCurrent: async () => {},
      assertActive: () => {},
      get transaction() {
        gets++;
        return {};
      },
    },
  } as unknown as CreativeProjectCommitOptions;
  await assert.rejects(
    f.service.saveOutlineCandidate(
      actor,
      outlineCommand(f.project.projectId),
      unsupported,
    ),
    hasCode("project_text_transaction_authority_unsupported"),
  );
  assert.equal(gets, 0);
  assert.equal(f.store.commits.length, 0);
});
test("caller commands are detached before waits and unknown/accessor fields never run", async () => {
  const f = await createProjectTextFixture();
  let reads = 0;
  const accessor = {
    ...outlineCommand(f.project.projectId),
    get briefRevision() {
      reads++;
      return 1;
    },
  };
  await assert.rejects(f.service.saveOutlineCandidate(actor, accessor));
  assert.equal(reads, 0);
  const extra = { ...outlineCommand(f.project.projectId), extra: true };
  await assert.rejects(f.service.saveOutlineCandidate(actor, extra));
  const entered = deferred(),
    release = deferred();
  f.store.before = async (method) => {
    if (method === "loadMutationReceipt") {
      entered.resolve();
      await release.promise;
    }
  };
  const command = structuredClone(outlineCommand(f.project.projectId));
  const pending = f.service.saveOutlineCandidate(actor, command);
  await entered.promise;
  command.content.synopsis = "mutated";
  release.resolve();
  const saved = await pending;
  assert.equal(
    saved.contentRevision?.kind === "outline"
      ? saved.contentRevision.content.synopsis
      : null,
    outlineContent.synopsis,
  );
});
test("pages use bounded keyset cursors and reject malformed or over-limit Store output", async () => {
  const f = await createProjectTextFixture();
  assert.deepEqual(
    await f.service.listArtifacts(actor, {
      projectId: f.project.projectId,
      afterArtifactId: null,
      limit: 16,
    }),
    { artifacts: [], nextArtifactId: null },
  );
  const saved = await f.service.saveOutlineCandidate(
    actor,
    outlineCommand(f.project.projectId),
  );
  await f.service.saveOutlineCandidate(actor, {
    ...outlineCommand(f.project.projectId, "outline-2"),
    expectedArtifactRevision: 1,
  });
  const page = await f.service.listRevisions(actor, {
    projectId: f.project.projectId,
    artifactId: saved.artifact.artifactId,
    afterContentRevision: 0,
    limit: 1,
  });
  assert.equal(page.nextContentRevision, 1);
  const next = await f.service.listRevisions(actor, {
    projectId: f.project.projectId,
    artifactId: saved.artifact.artifactId,
    afterContentRevision: 1,
    limit: 1,
  });
  assert.equal(next.revisions[0]?.contentRevision, 2);
  assert.equal(next.nextContentRevision, null);
  await assert.rejects(
    f.service.listArtifacts(actor, {
      projectId: f.project.projectId,
      afterArtifactId: null,
      limit: 17,
    }),
    hasCode("project_text_limit_invalid"),
  );
  f.store.override = (method, value) =>
    method === "listArtifacts"
      ? { artifacts: [saved.artifact], nextArtifactId: "other" }
      : value;
  await assert.rejects(
    f.service.listArtifacts(actor, {
      projectId: f.project.projectId,
      afterArtifactId: null,
      limit: 1,
    }),
    hasCode("project_text_store_result_invalid"),
  );
});
test("stored digest tampering is rejected before a revision or selected view is returned", async () => {
  const f = await createProjectTextFixture();
  const saved = await f.service.saveOutlineCandidate(
    actor,
    outlineCommand(f.project.projectId),
  );
  f.store.override = (method, value) =>
    method === "loadRevision"
      ? { ...saved.contentRevision, contentDigest: `sha256:${"0".repeat(64)}` }
      : value;
  await assert.rejects(
    f.service.getRevision(actor, {
      projectId: f.project.projectId,
      artifactId: saved.artifact.artifactId,
      contentRevision: 1,
    }),
    hasCode("project_text_store_result_invalid"),
  );
});
test("commit-time identical receipt replay preserves original generated ID and checks current policy", async () => {
  const f = await createProjectTextFixture();
  const command = outlineCommand(f.project.projectId);
  const entered = deferred(),
    release = deferred();
  let arrivals = 0;
  f.store.beforeCommit = async () => {
    if (++arrivals === 1) {
      entered.resolve();
      await release.promise;
    }
  };
  const first = f.service.saveOutlineCandidate(actor, command);
  await entered.promise;
  const original = await f.service.saveOutlineCandidate(actor, command);
  release.resolve();
  const replay = await first;
  assert.deepEqual(replay, { ...original, disposition: "replayed" });
  assert.equal(f.store.commits.length, 1);
});

test("a head-read race returns the original receipt rather than reporting a stale CAS", async () => {
  const f = await createProjectTextFixture();
  const command = outlineCommand(f.project.projectId);
  const entered = deferred();
  const release = deferred();
  let reads = 0;
  f.store.before = async (method) => {
    if (method === "loadOutline" && ++reads === 1) {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = f.service.saveOutlineCandidate(actor, command);
  await entered.promise;
  const original = await f.service.saveOutlineCandidate(actor, command);
  release.resolve();
  assert.deepEqual(await pending, { ...original, disposition: "replayed" });
  assert.equal(f.store.commits.length, 1);
});

test("a commit-time replay cannot publish an old receipt after policy withdrawal", async () => {
  const f = await createProjectTextFixture();
  const command = outlineCommand(f.project.projectId);
  const entered = deferred();
  const release = deferred();
  let arrivals = 0;
  f.store.beforeCommit = async () => {
    if (++arrivals === 1) {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = f.service.saveOutlineCandidate(actor, command);
  await entered.promise;
  await f.service.saveOutlineCandidate(actor, command);
  f.denied = true;
  release.resolve();
  await assert.rejects(pending, hasCode("authorization_denied"));
  assert.equal(f.store.commits.length, 1);
});

test("dot episode, scene and artifact locators fail before any metadata commit", async () => {
  const f = await createProjectTextFixture();
  for (const id of [".", ".."]) {
    await assert.rejects(
      f.service.saveOutlineCandidate(actor, {
        ...outlineCommand(f.project.projectId),
        content: {
          ...outlineContent,
          episodes: [{ ...outlineContent.episodes[0]!, episodeId: id }],
        },
      }),
      hasCode("project_text_identity_invalid"),
    );
    await assert.rejects(
      f.service.saveScriptCandidate(actor, {
        projectId: f.project.projectId,
        episodeId: id,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: null,
        content: scriptContent,
        idempotencyKey: "dot-episode",
      }),
      hasCode("project_text_identity_invalid"),
    );
    await assert.rejects(
      f.service.saveScriptCandidate(actor, {
        projectId: f.project.projectId,
        episodeId: "ep-1",
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: null,
        content: {
          ...scriptContent,
          scenes: [{ ...scriptContent.scenes[0]!, sceneId: id }],
        },
        idempotencyKey: "dot-scene",
      }),
      hasCode("project_text_identity_invalid"),
    );
    await assert.rejects(
      f.service.selectRevision(actor, {
        projectId: f.project.projectId,
        artifactId: id,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "dot-ref",
      }),
      hasCode("project_text_identity_invalid"),
    );
    await assert.rejects(
      f.service.getArtifact(actor, {
        projectId: f.project.projectId,
        artifactId: id,
      }),
      hasCode("project_text_identity_invalid"),
    );
  }
  assert.equal(f.store.commits.length, 0);
  assert.equal(f.store.receipts.size, 0);
});
