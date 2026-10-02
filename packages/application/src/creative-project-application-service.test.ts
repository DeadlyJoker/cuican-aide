import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import type { CreativeProjectApplicationService } from "./creative-project-application-service.ts";
import {
  actor,
  createCommand,
  createFixture,
  deferred,
  withContentDigest,
} from "./creative-project.test-support.ts";
import type {
  ChangeConceptAssetResult,
  CreateCreativeProjectResult,
} from "./creative-project-store-port.ts";

// S0 step 2 Application contracts against an owner-filtered in-memory fixture.
// These tests do not prove database persistence, generation, charging or UI flows.

test("creates a personally owned project and initial brief in one atomic recipe", async () => {
  const fixture = createFixture();
  const first = await fixture.service.createProject(actor, createCommand());
  assert.equal(first.kind, "create-project");
  assert.equal(first.disposition, "committed");
  assert.equal(first.project.ownerPrincipalId, actor.principalId);
  assert.equal(first.project.createdByActorId, actor.actorId);
  assert.equal(first.project.tenantId, actor.tenantId);
  assert.equal(first.project.spaceId, actor.spaceId);
  assert.equal(first.brief.projectId, first.project.projectId);
  assert.equal(first.brief.briefRevision, 1);
  assert.equal(first.project.latestBriefRevision, 1);
  assert.equal(first.brief.text, createCommand().briefText);
  assert.equal(fixture.store.commits.length, 1);
  assert.equal(fixture.store.projects.size, 1);
  assert.equal(fixture.store.briefs.size, 1);
  assert.equal(fixture.store.receipts.size, 1);
  assert.deepEqual(
    fixture.store.calls
      .filter((call) => call.method.startsWith("commit"))
      .map((call) => call.method),
    ["commitProjectCreation"],
  );
  assert.deepEqual(fixture.idCalls, ["creativeProject"]);
});

test("failed creation publishes neither the project, brief nor receipt", async () => {
  const fixture = createFixture();
  fixture.store.failCommit = true;
  await assert.rejects(
    fixture.service.createProject(actor, createCommand()),
    appError("internal", "creative_project_service_unavailable"),
  );
  assert.equal(fixture.store.projects.size, 0);
  assert.equal(fixture.store.briefs.size, 0);
  assert.equal(fixture.store.receipts.size, 0);
  fixture.store.failCommit = false;
  const retry = await fixture.service.createProject(actor, createCommand());
  assert.equal(retry.disposition, "committed");
  assert.equal(fixture.store.commits.length, 1);
});

test("lost-reply replay returns its original snapshot without new IDs or clock reads", async () => {
  const fixture = createFixture();
  const first = await fixture.service.createProject(actor, createCommand());
  const renamed = await fixture.service.renameProject(actor, {
    projectId: first.project.projectId,
    title: "新的列表名称",
    expectedProjectRevision: first.project.revision,
    idempotencyKey: "rename-1",
  });
  assert.notEqual(renamed.project.title, first.project.title);
  const counts = { ids: fixture.idCalls.length, clock: fixture.clockCalls };
  const replay = await fixture.service.createProject(actor, createCommand());
  assert.deepEqual(replay, { ...first, disposition: "replayed" });
  assert.deepEqual(
    { ids: fixture.idCalls.length, clock: fixture.clockCalls },
    counts,
  );
  await assert.rejects(
    fixture.service.createProject(actor, {
      ...createCommand(),
      briefText: "旧键不能承载新的需求。",
    }),
    appError("conflict", "creative_project_idempotency_conflict"),
  );
  assert.equal(fixture.store.commits.length, 2);
});

test("concurrent identical creates commit once and return the same original identity", async () => {
  const fixture = createFixture();
  const results = await Promise.all([
    fixture.service.createProject(actor, createCommand()),
    fixture.service.createProject(actor, createCommand()),
  ]);
  assert.deepEqual(results.map((result) => result.disposition).sort(), [
    "committed",
    "replayed",
  ]);
  assert.equal(results[0].project.projectId, results[1].project.projectId);
  assert.deepEqual(results[0].brief, results[1].brief);
  assert.equal(fixture.store.commits.length, 1);
  assert.equal(fixture.store.receipts.size, 1);
  assert.equal(fixture.store.projects.size, 1);
});

test("ownership uses the principal, while receipts also distinguish the audit actor", async () => {
  const fixture = createFixture();
  const first = await fixture.service.createProject(actor, createCommand());
  const otherActor = { ...actor, actorId: "actor-2" };
  assert.deepEqual(
    await fixture.service.getProject(otherActor, {
      projectId: first.project.projectId,
    }),
    first.project,
  );
  const second = await fixture.service.createProject(
    otherActor,
    createCommand(),
  );
  assert.notEqual(second.project.projectId, first.project.projectId);
  assert.equal(second.project.ownerPrincipalId, first.project.ownerPrincipalId);
  assert.equal(second.project.createdByActorId, "actor-2");
  const otherPrincipal = { ...actor, principalId: "principal-2" };
  const third = await fixture.service.createProject(
    otherPrincipal,
    createCommand(),
  );
  assert.notEqual(third.project.projectId, first.project.projectId);
  assert.equal(third.project.ownerPrincipalId, "principal-2");
  assert.equal(fixture.store.receipts.size, 3);
  assert.deepEqual(
    (await fixture.service.listProjects(otherPrincipal, listQuery())).projects,
    [third.project],
  );
  await assert.rejects(
    fixture.service.getProject(otherPrincipal, {
      projectId: first.project.projectId,
    }),
    appError("notFound", "creative_project_not_found"),
  );
  for (const foreign of [
    { ...actor, spaceId: "space-2" },
    { ...actor, tenantId: "tenant-2" },
  ]) {
    await assert.rejects(
      fixture.service.getProject(foreign, {
        projectId: first.project.projectId,
      }),
      appError("notFound"),
    );
    assert.deepEqual(
      (await fixture.service.listProjects(foreign, listQuery())).projects,
      [],
    );
  }
});

test("concepts pin stored brief revisions; new briefs and renaming preserve old input digests", async () => {
  const fixture = createFixture();
  const { first, concept } = await seedConcept(fixture);
  const oldBrief = structuredClone(first.brief);
  const oldConcept = structuredClone(concept.assetRevision);
  const nextBrief = await fixture.service.appendBrief(actor, {
    projectId: first.project.projectId,
    text: "第二版：在清晨重逢。",
    expectedProjectRevision: concept.project.revision,
    idempotencyKey: "brief-2",
  });
  const renamed = await fixture.service.renameProject(actor, {
    projectId: first.project.projectId,
    title: "仅修改列表名称",
    expectedProjectRevision: nextBrief.project.revision,
    idempotencyKey: "rename-1",
  });
  const nextConcept = await fixture.service.appendConceptRevision(actor, {
    projectId: first.project.projectId,
    assetId: concept.asset.assetId,
    briefRevision: nextBrief.brief.briefRevision,
    prompt: "清晨写实概念图",
    expectedProjectRevision: renamed.project.revision,
    expectedAssetMetadataRevision: concept.asset.revision,
    idempotencyKey: "concept-2",
  });
  assert.deepEqual(
    await fixture.service.getBrief(actor, {
      projectId: first.project.projectId,
      briefRevision: 1,
    }),
    oldBrief,
  );
  assert.deepEqual(
    await fixture.service.getConceptRevision(actor, {
      projectId: first.project.projectId,
      assetId: concept.asset.assetId,
      assetRevision: 1,
    }),
    oldConcept,
  );
  assert.equal(
    nextConcept.assetRevision.briefRevision,
    nextBrief.brief.briefRevision,
  );
  assert.equal(
    nextConcept.assetRevision.briefContentDigest,
    nextBrief.brief.contentDigest,
  );
  assert.notEqual(
    nextConcept.assetRevision.contentDigest,
    oldConcept.contentDigest,
  );
  assert.deepEqual(
    await fixture.service.listBriefs(actor, {
      projectId: first.project.projectId,
      afterBriefRevision: 0,
      limit: 50,
    }),
    [oldBrief, nextBrief.brief],
  );
  assert.deepEqual(
    await fixture.service.listConceptRevisions(actor, {
      projectId: first.project.projectId,
      assetId: concept.asset.assetId,
      afterAssetRevision: 0,
      limit: 50,
    }),
    [oldConcept, nextConcept.assetRevision],
  );
});

test("a supplied brief revision is read from owner storage rather than inferred from the latest brief", async () => {
  const fixture = createFixture();
  const first = await fixture.service.createProject(actor, createCommand());
  const second = await fixture.service.appendBrief(actor, {
    projectId: first.project.projectId,
    text: "第二版需求",
    expectedProjectRevision: first.project.revision,
    idempotencyKey: "brief-2",
  });
  fixture.store.resetCalls();
  const concept = await fixture.service.createConcept(actor, {
    projectId: first.project.projectId,
    briefRevision: 1,
    name: "旧版构图",
    prompt: "旧需求的概念图",
    expectedProjectRevision: second.project.revision,
    idempotencyKey: "concept-1",
  });
  const reads = fixture.store.calls.filter(
    (call) => call.method === "loadBrief",
  );
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].input, {
    owner: owner(),
    projectId: first.project.projectId,
    briefRevision: 1,
  });
  assert.equal(
    concept.assetRevision.briefContentDigest,
    first.brief.contentDigest,
  );
  await assert.rejects(
    fixture.service.createConcept(actor, {
      projectId: first.project.projectId,
      briefRevision: 99,
      name: "不存在",
      prompt: "无权伪造需求",
      expectedProjectRevision: concept.project.revision,
      idempotencyKey: "missing-brief",
    }),
    appError("notFound", "creative_project_brief_not_found"),
  );
});

test("competing metadata revisions use CAS and do not change the immutable brief", async () => {
  const fixture = createFixture();
  const first = await fixture.service.createProject(actor, createCommand());
  const attempts = await Promise.allSettled(
    ["标题甲", "标题乙"].map((title, index) =>
      fixture.service.renameProject(actor, {
        projectId: first.project.projectId,
        title,
        expectedProjectRevision: first.project.revision,
        idempotencyKey: `rename-${index}`,
      }),
    ),
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = attempts.find((result) => result.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" &&
      appError(
        "conflict",
        "creative_project_revision_conflict",
      )(rejected.reason),
  );
  assert.equal(fixture.store.commits.length, 2);
  assert.deepEqual(
    await fixture.service.getBrief(actor, {
      projectId: first.project.projectId,
      briefRevision: 1,
    }),
    first.brief,
  );
});

test("archiving retains history and permits metadata, while blocking new creative input until restore", async () => {
  const fixture = createFixture();
  const { first, concept } = await seedConcept(fixture);
  const archived = await fixture.service.setProjectState(actor, {
    projectId: first.project.projectId,
    state: "archived",
    expectedProjectRevision: concept.project.revision,
    idempotencyKey: "archive-1",
  });
  const renamed = await fixture.service.renameProject(actor, {
    projectId: first.project.projectId,
    title: "归档后修改名称",
    expectedProjectRevision: archived.project.revision,
    idempotencyKey: "rename-archived",
  });
  for (const action of [
    () =>
      fixture.service.appendBrief(actor, {
        projectId: first.project.projectId,
        text: "不允许新增",
        expectedProjectRevision: renamed.project.revision,
        idempotencyKey: "brief-blocked",
      }),
    () =>
      fixture.service.createConcept(actor, {
        projectId: first.project.projectId,
        briefRevision: 1,
        name: "不允许新增",
        prompt: "禁止新增",
        expectedProjectRevision: renamed.project.revision,
        idempotencyKey: "concept-blocked",
      }),
    () =>
      fixture.service.appendConceptRevision(actor, {
        projectId: first.project.projectId,
        assetId: concept.asset.assetId,
        briefRevision: 1,
        prompt: "禁止新增",
        expectedProjectRevision: renamed.project.revision,
        expectedAssetMetadataRevision: concept.asset.revision,
        idempotencyKey: "revision-blocked",
      }),
  ])
    await assert.rejects(
      action(),
      appError("conflict", "creative_project_archived"),
    );
  assert.deepEqual(
    await fixture.service.getBrief(actor, {
      projectId: first.project.projectId,
      briefRevision: 1,
    }),
    first.brief,
  );
  assert.deepEqual(
    await fixture.service.getConceptRevision(actor, {
      projectId: first.project.projectId,
      assetId: concept.asset.assetId,
      assetRevision: 1,
    }),
    concept.assetRevision,
  );
  assert.deepEqual(
    (
      await fixture.service.listProjects(actor, {
        ...listQuery(),
        state: "active",
      })
    ).projects,
    [],
  );
  assert.deepEqual(
    (
      await fixture.service.listProjects(actor, {
        ...listQuery(),
        state: "archived",
      })
    ).projects,
    [renamed.project],
  );
  const restored = await fixture.service.setProjectState(actor, {
    projectId: first.project.projectId,
    state: "active",
    expectedProjectRevision: renamed.project.revision,
    idempotencyKey: "restore-1",
  });
  const appended = await fixture.service.appendBrief(actor, {
    projectId: first.project.projectId,
    text: "恢复后新增",
    expectedProjectRevision: restored.project.revision,
    idempotencyKey: "brief-restored",
  });
  assert.equal(appended.brief.briefRevision, 2);
});

test("failed brief or concept recipes leave project and immutable revisions untouched", async () => {
  const fixture = createFixture();
  const { first, concept } = await seedConcept(fixture);
  const snapshot = snapshotStore(fixture);
  fixture.store.failCommit = true;
  await assert.rejects(
    fixture.service.appendBrief(actor, {
      projectId: first.project.projectId,
      text: "写入失败的新版",
      expectedProjectRevision: concept.project.revision,
      idempotencyKey: "brief-failed",
    }),
    appError("internal"),
  );
  await assert.rejects(
    fixture.service.appendConceptRevision(actor, {
      projectId: first.project.projectId,
      assetId: concept.asset.assetId,
      briefRevision: 1,
      prompt: "写入失败的新版",
      expectedProjectRevision: concept.project.revision,
      expectedAssetMetadataRevision: concept.asset.revision,
      idempotencyKey: "concept-failed",
    }),
    appError("internal"),
  );
  assert.deepEqual(snapshotStore(fixture), snapshot);
});

test("all commands and queries reject getters without invoking them", async () => {
  const fixture = createFixture();
  let getterCalls = 0;
  for (const invoke of allEntrypoints(fixture.service)) {
    const command = Object.defineProperty({}, "projectId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "project-1";
      },
    });
    await assert.rejects(invoke(command), appError("validation"));
  }
  const badActor = Object.defineProperty({ ...actor }, "principalId", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "principal-1";
    },
  });
  await assert.rejects(
    fixture.service.createProject(badActor, createCommand()),
    appError("validation"),
  );
  assert.equal(getterCalls, 0);
  assert.equal(fixture.store.calls.length, 0);
});

test("public inputs refuse caller-controlled ownership, URLs and persisted record fields", async () => {
  const fixture = createFixture();
  for (const extra of [
    { ownerPrincipalId: "other" },
    { principalId: "other" },
    { tenantId: "other" },
    { owner: owner() },
    { projectId: "caller-created" },
    { revision: 1 },
    { url: "https://example.invalid/image.png" },
  ])
    await assert.rejects(
      fixture.service.createProject(actor, { ...createCommand(), ...extra }),
      appError("validation"),
    );
  await assert.rejects(
    fixture.service.createConcept(actor, {
      projectId: "project-1",
      briefRevision: 1,
      name: "概念图",
      prompt: "写实概念图",
      expectedProjectRevision: 1,
      idempotencyKey: "concept-1",
      briefContentDigest: "forged",
      imageUrl: "https://example.invalid/image.png",
    } as never),
    appError("validation"),
  );
  assert.equal(fixture.store.calls.length, 0);
});

test("accepts exactly 8 KiB brief content and 2000 UTF-16 prompt units without trimming", async () => {
  const fixture = createFixture();
  const briefText = `\n${"界".repeat(2730)}x`;
  assert.equal(new TextEncoder().encode(briefText).length, 8192);
  const first = await fixture.service.createProject(actor, {
    ...createCommand(),
    briefText,
  });
  const prompt = "😀".repeat(1000);
  const concept = await fixture.service.createConcept(actor, {
    projectId: first.project.projectId,
    briefRevision: 1,
    name: "界".repeat(160),
    prompt,
    expectedProjectRevision: first.project.revision,
    idempotencyKey: "concept-boundary",
  });
  assert.equal(first.brief.text, briefText);
  assert.equal(concept.assetRevision.prompt, prompt);
  const commits = fixture.store.commits.length;
  await assert.rejects(
    fixture.service.appendBrief(actor, {
      projectId: first.project.projectId,
      text: `${briefText}x`,
      expectedProjectRevision: concept.project.revision,
      idempotencyKey: "brief-too-long",
    }),
    appError("validation"),
  );
  await assert.rejects(
    fixture.service.appendConceptRevision(actor, {
      projectId: first.project.projectId,
      assetId: concept.asset.assetId,
      briefRevision: 1,
      prompt: `${prompt}x`,
      expectedProjectRevision: concept.project.revision,
      expectedAssetMetadataRevision: concept.asset.revision,
      idempotencyKey: "prompt-too-long",
    }),
    appError("validation"),
  );
  await assert.rejects(
    fixture.service.createProject(actor, {
      ...createCommand("bad-unicode"),
      briefText: "\ud800",
    }),
    appError("validation"),
  );
  assert.equal(fixture.store.commits.length, commits);
});

test("bounded lists accept zero revision cursors and keep independent pages ordered", async () => {
  const fixture = createFixture();
  const { first, concept } = await seedConcept(fixture);
  const next = await fixture.service.appendBrief(actor, {
    projectId: first.project.projectId,
    text: "第二版",
    expectedProjectRevision: concept.project.revision,
    idempotencyKey: "brief-2",
  });
  const briefPage = await fixture.service.listBriefs(actor, {
    projectId: first.project.projectId,
    afterBriefRevision: 0,
    limit: 1,
  });
  assert.deepEqual(briefPage, [first.brief]);
  assert.deepEqual(
    await fixture.service.listBriefs(actor, {
      projectId: first.project.projectId,
      afterBriefRevision: 1,
      limit: 50,
    }),
    [next.brief],
  );
  assert.deepEqual(
    await fixture.service.listConceptAssets(actor, {
      projectId: first.project.projectId,
      afterAssetId: null,
      limit: 1,
    }),
    [concept.asset],
  );
  assert.deepEqual(
    await fixture.service.listConceptRevisions(actor, {
      projectId: first.project.projectId,
      assetId: concept.asset.assetId,
      afterAssetRevision: 0,
      limit: 1,
    }),
    [concept.assetRevision],
  );
  const unicodeIds = ["conceptAsset-\ue000", "conceptAsset-\u{10000}"];
  fixture.idValue = () => unicodeIds.shift()!;
  const highBmp = await fixture.service.createConcept(actor, {
    projectId: first.project.projectId,
    briefRevision: 1,
    name: "BMP 高位标识",
    prompt: "合法概念输入",
    expectedProjectRevision: next.project.revision,
    idempotencyKey: "concept-bmp",
  });
  const nonBmp = await fixture.service.createConcept(actor, {
    projectId: first.project.projectId,
    briefRevision: 1,
    name: "非 BMP 标识",
    prompt: "合法概念输入",
    expectedProjectRevision: highBmp.project.revision,
    idempotencyKey: "concept-non-bmp",
  });
  assert.deepEqual(
    await fixture.service.listConceptAssets(actor, {
      projectId: first.project.projectId,
      afterAssetId: null,
      limit: 50,
    }),
    [concept.asset, highBmp.asset, nonBmp.asset],
  );
  assert.deepEqual(
    await fixture.service.listConceptAssets(actor, {
      projectId: first.project.projectId,
      afterAssetId: highBmp.asset.assetId,
      limit: 1,
    }),
    [nonBmp.asset],
  );
  fixture.idValue = (kind, sequence) => `${kind}-${sequence}`;
  await fixture.service.createProject(actor, createCommand("create-2"));
  const page = await fixture.service.listProjects(actor, {
    ...listQuery(),
    limit: 1,
  });
  assert.equal(page.projects.length, 1);
  assert.notEqual(page.next, null);
  const after = await fixture.service.listProjects(actor, {
    ...listQuery(),
    after: page.next,
    limit: 1,
  });
  assert.equal(after.projects.length, 1);
  assert.notEqual(page.projects[0].projectId, after.projects[0].projectId);
});

test("rejects malformed cursors, limits and revision positions before touching Store", async () => {
  const fixture = createFixture();
  for (const limit of [0, 51, -1, 1.5, "1", Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      fixture.service.listProjects(actor, { ...listQuery(), limit } as never),
      appError("validation"),
    );
    await assert.rejects(
      fixture.service.listBriefs(actor, {
        projectId: "project-1",
        afterBriefRevision: 0,
        limit,
      } as never),
      appError("validation"),
    );
  }
  for (const after of [
    {},
    { updatedAt: "not-a-date", projectId: "project-1" },
    {
      updatedAt: "2026-10-02T00:00:00.000Z",
      projectId: "project-1",
      ownerPrincipalId: "other",
    },
  ])
    await assert.rejects(
      fixture.service.listProjects(actor, { ...listQuery(), after } as never),
      appError("validation"),
    );
  for (const revision of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      fixture.service.listBriefs(actor, {
        projectId: "project-1",
        afterBriefRevision: revision,
        limit: 1,
      } as never),
      appError("validation"),
    );
    await assert.rejects(
      fixture.service.listConceptRevisions(actor, {
        projectId: "project-1",
        assetId: "asset-1",
        afterAssetRevision: revision,
        limit: 1,
      } as never),
      appError("validation"),
    );
  }
  await assert.rejects(
    fixture.service.listConceptAssets(actor, {
      projectId: "project-1",
      afterAssetId: "",
      limit: 1,
    }),
    appError("validation"),
  );
  assert.equal(fixture.store.calls.length, 0);
});

test("current authorization precedes every Store access for all public entrypoints", async () => {
  const fixture = createFixture();
  fixture.authorization = () => ({
    outcome: "deny",
    reasonCode: "fixture_current_access_revoked",
  });
  for (const invoke of validEntrypoints(fixture.service)) {
    await assert.rejects(
      invoke(),
      appError("authorization", "authorization_denied"),
    );
  }
  assert.equal(fixture.authorizations.length, 14);
  assert.equal(fixture.store.calls.length, 0);
  assert.equal(fixture.idCalls.length, 0);
  assert.equal(fixture.clockCalls, 0);
});

test("revocation during an awaited receipt read prevents replay and new creation", async () => {
  for (const replay of [false, true]) {
    const fixture = createFixture();
    if (replay) await fixture.service.createProject(actor, createCommand());
    const entered = deferred();
    const release = deferred();
    let allowed = true;
    fixture.authorization = () =>
      allowed
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "fixture_revoked" };
    fixture.store.before = async (method) => {
      if (method === "loadMutationReceipt") {
        entered.resolve();
        await release.promise;
      }
    };
    const before = {
      commits: fixture.store.commits.length,
      ids: fixture.idCalls.length,
      clock: fixture.clockCalls,
    };
    const pending = fixture.service.createProject(actor, createCommand());
    await entered.promise;
    allowed = false;
    release.resolve();
    await assert.rejects(
      pending,
      appError("authorization", "authorization_denied"),
    );
    assert.equal(fixture.store.commits.length, before.commits);
    assert.equal(fixture.store.projects.size, replay ? 1 : 0);
    assert.equal(fixture.store.briefs.size, replay ? 1 : 0);
    assert.equal(fixture.store.receipts.size, replay ? 1 : 0);
    if (replay) {
      assert.equal(fixture.idCalls.length, before.ids);
      assert.equal(fixture.clockCalls, before.clock);
    }
  }
});

test("revocation during a project read neither exposes the record nor commits a mutation", async () => {
  for (const mutation of [false, true]) {
    const fixture = createFixture();
    const first = await fixture.service.createProject(actor, createCommand());
    const entered = deferred();
    const release = deferred();
    let allowed = true;
    fixture.authorization = () =>
      allowed
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "fixture_revoked" };
    fixture.store.before = async (method) => {
      if (method === "loadProject") {
        entered.resolve();
        await release.promise;
      }
    };
    const pending = mutation
      ? fixture.service.appendBrief(actor, {
          projectId: first.project.projectId,
          text: "不可写入",
          expectedProjectRevision: first.project.revision,
          idempotencyKey: "brief-revoked",
        })
      : fixture.service.getProject(actor, {
          projectId: first.project.projectId,
        });
    await entered.promise;
    allowed = false;
    release.resolve();
    await assert.rejects(
      pending,
      appError("authorization", "authorization_denied"),
    );
    assert.equal(fixture.store.commits.length, 1);
  }
});

test("revocation while loading a pinned brief prevents concept publication", async () => {
  const fixture = createFixture();
  const first = await fixture.service.createProject(actor, createCommand());
  const entered = deferred();
  const release = deferred();
  let allowed = true;
  fixture.authorization = () =>
    allowed
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "fixture_revoked" };
  fixture.store.before = async (method) => {
    if (method === "loadBrief") {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = fixture.service.createConcept(actor, {
    projectId: first.project.projectId,
    briefRevision: 1,
    name: "不可写入",
    prompt: "不可写入",
    expectedProjectRevision: first.project.revision,
    idempotencyKey: "concept-revoked",
  });
  await entered.promise;
  allowed = false;
  release.resolve();
  await assert.rejects(
    pending,
    appError("authorization", "authorization_denied"),
  );
  assert.equal(fixture.store.assets.size, 0);
  assert.equal(fixture.store.revisions.size, 0);
  assert.equal(fixture.store.commits.length, 1);
});

test("list authorization is checked again after awaited page loading", async () => {
  const fixture = createFixture();
  await fixture.service.createProject(actor, createCommand());
  let allowed = true;
  fixture.authorization = () =>
    allowed
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "fixture_revoked" };
  fixture.store.before = async (method) => {
    if (method === "listProjects") allowed = false;
  };
  await assert.rejects(
    fixture.service.listProjects(actor, listQuery()),
    appError("authorization", "authorization_denied"),
  );
});

test("a final authorization check blocks commit after records have been constructed", async () => {
  const fixture = createFixture();
  const first = await fixture.service.createProject(actor, createCommand());
  const beforeClock = fixture.clockCalls;
  fixture.authorization = () =>
    fixture.clockCalls === beforeClock
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "fixture_revoked_before_commit" };
  await assert.rejects(
    fixture.service.appendBrief(actor, {
      projectId: first.project.projectId,
      text: "禁止发布的输入",
      expectedProjectRevision: first.project.revision,
      idempotencyKey: "brief-final-revoked",
    }),
    appError("authorization", "authorization_denied"),
  );
  assert.equal(fixture.store.commits.length, 1);
  assert.equal(fixture.store.briefs.size, 1);
});

test("forged project owner, tenant, space or kind from Store is rejected", async () => {
  const fixture = createFixture();
  const first = await fixture.service.createProject(actor, createCommand());
  for (const drift of [
    { ownerPrincipalId: "foreign-principal" },
    { tenantId: "foreign-tenant" },
    { spaceId: "foreign-space" },
    { projectId: "foreign-project" },
    { kind: "video" },
  ]) {
    fixture.store.override = (method, result) =>
      method === "loadProject" ? { ...(result as object), ...drift } : result;
    await assert.rejects(
      fixture.service.getProject(actor, { projectId: first.project.projectId }),
      appError("internal", "creative_project_store_result_invalid"),
    );
  }
});

test("stored brief and concept revisions must match their scope, position and digest", async () => {
  const fixture = createFixture();
  const { first, concept } = await seedConcept(fixture);
  const cases = [
    {
      method: "loadBrief",
      drift: { text: "摘要未更新的篡改文本" },
      read: () =>
        fixture.service.getBrief(actor, {
          projectId: first.project.projectId,
          briefRevision: 1,
        }),
    },
    {
      method: "loadBrief",
      drift: { projectId: "foreign-project" },
      read: () =>
        fixture.service.getBrief(actor, {
          projectId: first.project.projectId,
          briefRevision: 1,
        }),
    },
    {
      method: "loadConceptAsset",
      drift: { assetId: "foreign-asset" },
      read: () =>
        fixture.service.getConceptAsset(actor, {
          projectId: first.project.projectId,
          assetId: concept.asset.assetId,
        }),
    },
    {
      method: "loadConceptRevision",
      drift: { prompt: "摘要未更新的篡改输入" },
      read: () =>
        fixture.service.getConceptRevision(actor, {
          projectId: first.project.projectId,
          assetId: concept.asset.assetId,
          assetRevision: 1,
        }),
    },
    {
      method: "loadConceptRevision",
      drift: { assetRevision: 2 },
      read: () =>
        fixture.service.getConceptRevision(actor, {
          projectId: first.project.projectId,
          assetId: concept.asset.assetId,
          assetRevision: 1,
        }),
    },
  ];
  for (const { method, drift, read } of cases) {
    fixture.store.override = (called, result) =>
      called === method ? { ...(result as object), ...drift } : result;
    await assert.rejects(
      read(),
      appError("internal", "creative_project_store_result_invalid"),
    );
  }
  const futureBrief = withContentDigest({ ...first.brief, briefRevision: 2 });
  const futureConcept = withContentDigest({
    ...concept.assetRevision,
    briefRevision: 2,
    briefContentDigest: futureBrief.contentDigest,
  });
  const futureCases = [
    {
      method: "loadBrief",
      result: futureBrief,
      read: () =>
        fixture.service.getBrief(actor, {
          projectId: first.project.projectId,
          briefRevision: 2,
        }),
    },
    {
      method: "listBriefs",
      result: [futureBrief],
      read: () =>
        fixture.service.listBriefs(actor, {
          projectId: first.project.projectId,
          afterBriefRevision: 0,
          limit: 50,
        }),
    },
    {
      method: "loadConceptRevision",
      result: futureConcept,
      read: () =>
        fixture.service.getConceptRevision(actor, {
          projectId: first.project.projectId,
          assetId: concept.asset.assetId,
          assetRevision: 1,
        }),
    },
    {
      method: "listConceptRevisions",
      result: [futureConcept],
      read: () =>
        fixture.service.listConceptRevisions(actor, {
          projectId: first.project.projectId,
          assetId: concept.asset.assetId,
          afterAssetRevision: 0,
          limit: 50,
        }),
    },
  ];
  for (const { method, result, read } of futureCases) {
    fixture.store.override = (called, original) =>
      called === method ? result : original;
    await assert.rejects(
      read(),
      appError("internal", "creative_project_store_result_invalid"),
    );
  }
});

test("mutation receipts and commit results cannot substitute a different kind or frozen input", async () => {
  const fixture = createFixture();
  const first = await fixture.service.createProject(actor, createCommand());
  for (const forge of [
    (result: Record<string, unknown>) => ({ ...result, kind: "append-brief" }),
    (result: Record<string, unknown>) => ({
      ...result,
      project: { ...(result.project as object), title: "旧键的另一个项目名" },
    }),
    (result: Record<string, unknown>) => ({
      ...result,
      brief: {
        ...(result.brief as object),
        contentDigest: `sha256:${"f".repeat(64)}`,
      },
    }),
  ]) {
    fixture.store.override = (method, result) =>
      method === "loadMutationReceipt"
        ? forge(result as Record<string, unknown>)
        : result;
    await assert.rejects(
      fixture.service.createProject(actor, createCommand()),
      appError("internal", "creative_project_store_result_invalid"),
    );
  }
  fixture.store.override = (method, result) =>
    method === "commitProjectMetadata"
      ? {
          ...(result as object),
          project: { ...first.project, ownerPrincipalId: "foreign-principal" },
        }
      : result;
  await assert.rejects(
    fixture.service.renameProject(actor, {
      projectId: first.project.projectId,
      title: "新名称",
      expectedProjectRevision: first.project.revision,
      idempotencyKey: "bad-commit",
    }),
    appError("internal", "creative_project_store_result_invalid"),
  );
  for (const drift of ["identity", "timestamp"] as const) {
    const fresh = createFixture();
    fresh.store.override = (method, result) => {
      if (method !== "commitProjectCreation") return result;
      const committed = result as CreateCreativeProjectResult;
      const changed =
        drift === "identity"
          ? { projectId: "substituted-project-id" }
          : { createdAt: "2026-10-03T00:00:00.000Z" };
      return {
        ...committed,
        project: {
          ...committed.project,
          ...changed,
          ...(drift === "timestamp" ? { updatedAt: changed.createdAt } : {}),
        },
        brief: withContentDigest({ ...committed.brief, ...changed }),
      };
    };
    await assert.rejects(
      fresh.service.createProject(actor, createCommand()),
      appError("internal", "creative_project_store_result_invalid"),
    );

    const assetFixture = createFixture();
    const project = await assetFixture.service.createProject(
      actor,
      createCommand(),
    );
    assetFixture.store.override = (method, result) => {
      if (method !== "commitConceptRevision") return result;
      const committed = result as ChangeConceptAssetResult;
      const changed =
        drift === "identity"
          ? { assetId: "substituted-asset-id" }
          : { createdAt: "2026-10-03T00:00:00.000Z" };
      return {
        ...committed,
        asset: {
          ...committed.asset,
          ...changed,
          ...(drift === "timestamp" ? { updatedAt: changed.createdAt } : {}),
        },
        assetRevision: withContentDigest({
          ...committed.assetRevision,
          ...changed,
        }),
      };
    };
    await assert.rejects(
      assetFixture.service.createConcept(actor, {
        projectId: project.project.projectId,
        briefRevision: 1,
        name: "概念图",
        prompt: "合法概念输入",
        expectedProjectRevision: project.project.revision,
        idempotencyKey: "substituted-concept",
      }),
      appError("internal", "creative_project_store_result_invalid"),
    );
  }
});

test("bounded Store pages cannot return too many records or records outside the cursor", async () => {
  const fixture = createFixture();
  const { first, concept } = await seedConcept(fixture);
  const projectId = first.project.projectId;
  const assetId = concept.asset.assetId;
  const cases = [
    {
      method: "listProjects",
      read: () =>
        fixture.service.listProjects(actor, { ...listQuery(), limit: 1 }),
      result: { projects: [concept.project, concept.project], next: null },
    },
    {
      method: "listBriefs",
      read: () =>
        fixture.service.listBriefs(actor, {
          projectId,
          afterBriefRevision: 0,
          limit: 1,
        }),
      result: [first.brief, first.brief],
    },
    {
      method: "listBriefs",
      read: () =>
        fixture.service.listBriefs(actor, {
          projectId,
          afterBriefRevision: 1,
          limit: 1,
        }),
      result: [first.brief],
    },
    {
      method: "listConceptAssets",
      read: () =>
        fixture.service.listConceptAssets(actor, {
          projectId,
          afterAssetId: null,
          limit: 1,
        }),
      result: [concept.asset, concept.asset],
    },
    {
      method: "listConceptRevisions",
      read: () =>
        fixture.service.listConceptRevisions(actor, {
          projectId,
          assetId,
          afterAssetRevision: 0,
          limit: 1,
        }),
      result: [concept.assetRevision, concept.assetRevision],
    },
    {
      method: "listConceptRevisions",
      read: () =>
        fixture.service.listConceptRevisions(actor, {
          projectId,
          assetId,
          afterAssetRevision: 1,
          limit: 1,
        }),
      result: [concept.assetRevision],
    },
  ];
  for (const { method, read, result } of cases) {
    fixture.store.override = (called, original) =>
      called === method ? result : original;
    await assert.rejects(
      read(),
      appError("internal", "creative_project_store_result_invalid"),
    );
  }
});

function appError(category: string, code?: string) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    (code === undefined || error.code === code);
}
function owner() {
  return {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    principalId: actor.principalId,
  };
}
function listQuery() {
  return { state: "all" as const, after: null, limit: 50 };
}
async function seedConcept(fixture: ReturnType<typeof createFixture>) {
  const first = await fixture.service.createProject(actor, createCommand());
  const concept = await fixture.service.createConcept(actor, {
    projectId: first.project.projectId,
    briefRevision: 1,
    name: "雨夜概念图",
    prompt: "雨夜街道，写实质感",
    expectedProjectRevision: first.project.revision,
    idempotencyKey: "concept-1",
  });
  return { first, concept };
}
function snapshotStore(fixture: ReturnType<typeof createFixture>) {
  return structuredClone({
    projects: [...fixture.store.projects],
    briefs: [...fixture.store.briefs],
    assets: [...fixture.store.assets],
    revisions: [...fixture.store.revisions],
    receipts: [...fixture.store.receipts],
  });
}
function allEntrypoints(service: CreativeProjectApplicationService) {
  return [
    (input: unknown) => service.createProject(actor, input as never),
    (input: unknown) => service.renameProject(actor, input as never),
    (input: unknown) => service.setProjectState(actor, input as never),
    (input: unknown) => service.appendBrief(actor, input as never),
    (input: unknown) => service.createConcept(actor, input as never),
    (input: unknown) => service.appendConceptRevision(actor, input as never),
    (input: unknown) => service.getProject(actor, input as never),
    (input: unknown) => service.listProjects(actor, input as never),
    (input: unknown) => service.getBrief(actor, input as never),
    (input: unknown) => service.listBriefs(actor, input as never),
    (input: unknown) => service.getConceptAsset(actor, input as never),
    (input: unknown) => service.listConceptAssets(actor, input as never),
    (input: unknown) => service.getConceptRevision(actor, input as never),
    (input: unknown) => service.listConceptRevisions(actor, input as never),
  ];
}
function validEntrypoints(service: CreativeProjectApplicationService) {
  return [
    () => service.createProject(actor, createCommand()),
    () =>
      service.renameProject(actor, {
        projectId: "project-1",
        title: "新名称",
        expectedProjectRevision: 1,
        idempotencyKey: "rename-1",
      }),
    () =>
      service.setProjectState(actor, {
        projectId: "project-1",
        state: "archived",
        expectedProjectRevision: 1,
        idempotencyKey: "archive-1",
      }),
    () =>
      service.appendBrief(actor, {
        projectId: "project-1",
        text: "新版需求",
        expectedProjectRevision: 1,
        idempotencyKey: "brief-2",
      }),
    () =>
      service.createConcept(actor, {
        projectId: "project-1",
        briefRevision: 1,
        name: "概念图",
        prompt: "写实概念图",
        expectedProjectRevision: 1,
        idempotencyKey: "concept-1",
      }),
    () =>
      service.appendConceptRevision(actor, {
        projectId: "project-1",
        assetId: "asset-1",
        briefRevision: 1,
        prompt: "新版概念图",
        expectedProjectRevision: 1,
        expectedAssetMetadataRevision: 1,
        idempotencyKey: "concept-2",
      }),
    () => service.getProject(actor, { projectId: "project-1" }),
    () => service.listProjects(actor, listQuery()),
    () => service.getBrief(actor, { projectId: "project-1", briefRevision: 1 }),
    () =>
      service.listBriefs(actor, {
        projectId: "project-1",
        afterBriefRevision: 0,
        limit: 1,
      }),
    () =>
      service.getConceptAsset(actor, {
        projectId: "project-1",
        assetId: "asset-1",
      }),
    () =>
      service.listConceptAssets(actor, {
        projectId: "project-1",
        afterAssetId: null,
        limit: 1,
      }),
    () =>
      service.getConceptRevision(actor, {
        projectId: "project-1",
        assetId: "asset-1",
        assetRevision: 1,
      }),
    () =>
      service.listConceptRevisions(actor, {
        projectId: "project-1",
        assetId: "asset-1",
        afterAssetRevision: 0,
        limit: 1,
      }),
  ];
}
