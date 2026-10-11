import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import {
  uiTestActor,
  uiTestAt,
} from "../../application/src/plugin-ui.test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { ownedProjectSqliteFixture as fixture } from "./plugin-project-owned-sqlite.test-support.ts";
import { creativeCreateInput } from "../../application/src/plugin-creative-project-action.test-support.ts";

type ProjectResult = {
  project: { projectId: string; revision: number };
  disposition: string;
};
type BriefResult = ProjectResult & {
  brief: { briefRevision: number; contentDigest: string };
};
type ConceptResult = ProjectResult & {
  asset: { assetId: string; revision: number };
  assetRevision: {
    assetRevision: number;
    briefContentDigest: string;
    contentDigest: string;
  };
};

test("owned UI content writes create immutable briefs and concept history through original recipes and replay without allocating IDs", async (t) => {
  const f = await fixture(t),
    a = await f.ui();
  const created = (await a.invoke(
    "createProject",
    creativeCreateInput(),
  )) as BriefResult;
  const projectId = created.project.projectId;
  const briefCommand = {
    projectId,
    idempotencyKey: "new-brief",
    request: {
      text: "第二版创作想法",
      expectedProjectRevision: created.project.revision,
    },
  };
  const brief = (await a.invoke("appendBrief", briefCommand)) as BriefResult;
  const conceptCommand = {
    projectId,
    idempotencyKey: "first-concept",
    request: {
      name: "夜航",
      prompt: "海上夜航",
      briefRevision: 1,
      expectedProjectRevision: brief.project.revision,
    },
  };
  const concept = (await a.invoke(
    "createConcept",
    conceptCommand,
  )) as ConceptResult;
  const revisionCommand = {
    projectId,
    assetId: concept.asset.assetId,
    idempotencyKey: "next-concept",
    request: {
      prompt: "晴日海航",
      briefRevision: 2,
      expectedProjectRevision: concept.project.revision,
      expectedAssetMetadataRevision: concept.asset.revision,
    },
  };
  const revision = (await a.invoke(
    "appendConceptRevision",
    revisionCommand,
  )) as ConceptResult;
  assert.equal(
    concept.assetRevision.briefContentDigest,
    created.brief.contentDigest,
  );
  assert.equal(
    revision.assetRevision.briefContentDigest,
    brief.brief.contentDigest,
  );
  const before = f.counts();
  f.ids.nextId = () => {
    throw new Error("replay_must_not_allocate_id");
  };
  for (const [method, command, expected] of [
    ["appendBrief", briefCommand, brief],
    ["createConcept", conceptCommand, concept],
    ["appendConceptRevision", revisionCommand, revision],
  ] as const) {
    const replay = (await a.invoke(method, command)) as typeof expected;
    assert.deepEqual({ ...replay, disposition: "committed" }, expected);
  }
  assert.deepEqual(f.counts(), before);
  const briefs = (await a.invoke("listBriefs", { projectId, query: {} })) as {
    briefs: unknown[];
  };
  assert.equal(briefs.briefs.length, 2);
  const history = (await a.invoke("listConceptRevisions", {
    projectId,
    assetId: concept.asset.assetId,
    query: {},
  })) as { revisions: { contentDigest: string }[] };
  assert.deepEqual(
    history.revisions.map((v) => v.contentDigest),
    [concept.assetRevision.contentDigest, revision.assetRevision.contentDigest],
  );
  const first = (await a.invoke("getConceptRevision", {
    projectId,
    assetId: concept.asset.assetId,
    assetRevision: 1,
  })) as { assetRevision: { contentDigest: string } };
  assert.equal(
    first.assetRevision.contentDigest,
    concept.assetRevision.contentDigest,
  );
});

for (const method of [
  "appendBrief",
  "createConcept",
  "appendConceptRevision",
] as const) {
  test(`${method} original receipt fault rolls back all project, content and asset writes, then the same external request can succeed`, async (t) => {
    const f = await fixture(t),
      a = await f.ui();
    let made = (await a.invoke(
      "createProject",
      creativeCreateInput(),
    )) as ProjectResult;
    let concept: ConceptResult | undefined;
    if (method === "appendConceptRevision") {
      concept = (await a.invoke("createConcept", {
        projectId: made.project.projectId,
        idempotencyKey: "seed-concept",
        request: {
          name: "fixture",
          prompt: "first",
          briefRevision: 1,
          expectedProjectRevision: made.project.revision,
        },
      })) as ConceptResult;
      made = concept;
    }
    const command = {
      projectId: made.project.projectId,
      ...(concept ? { assetId: concept.asset.assetId } : {}),
      idempotencyKey: "receipt-fault",
      request: {
        expectedProjectRevision: made.project.revision,
        ...(method === "appendBrief"
          ? { text: "new content" }
          : { prompt: "new prompt", briefRevision: 1 }),
        ...(method === "createConcept" ? { name: "new concept" } : {}),
        ...(concept
          ? { expectedAssetMetadataRevision: concept.asset.revision }
          : {}),
      },
    };
    const snapshot = () =>
      [
        "creative_projects",
        "creative_project_briefs",
        "creative_concept_assets",
        "creative_concept_revisions",
        "creative_project_mutation_receipts",
        "plugin_project_metadata_owners",
      ].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    f.db.exec(
      "CREATE TRIGGER fail_owned_content_receipt BEFORE INSERT ON creative_project_mutation_receipts BEGIN SELECT RAISE(ABORT,'named_content_receipt_failure'); END",
    );
    await assert.rejects(a.invoke(method, command));
    assert.deepEqual(snapshot(), before);
    f.db.exec("DROP TRIGGER fail_owned_content_receipt");
    const result = (await a.invoke(method, command)) as ProjectResult;
    assert.equal(result.disposition, "committed");
    assert.equal(result.project.revision, made.project.revision + 1);
    const replay = (await a.invoke(method, command)) as ProjectResult;
    assert.equal(replay.disposition, "replayed");
  });
}

test("other plugins cannot write briefs, concepts or versions, and a foreign asset cannot be used with an owned project", async (t) => {
  const f = await fixture(t),
    a = await f.ui(),
    b = await f.ui("example.other");
  const made = (await a.invoke(
    "createProject",
    creativeCreateInput(),
  )) as ProjectResult;
  const other = (await b.invoke(
    "createProject",
    creativeCreateInput(),
  )) as ProjectResult;
  const concept = (await a.invoke("createConcept", {
    projectId: made.project.projectId,
    idempotencyKey: "own-asset",
    request: {
      name: "own",
      prompt: "own",
      briefRevision: 1,
      expectedProjectRevision: made.project.revision,
    },
  })) as ConceptResult;
  const before = f.counts();
  for (const [method, command] of [
    [
      "appendBrief",
      {
        projectId: made.project.projectId,
        idempotencyKey: "foreign-brief",
        request: {
          text: "foreign",
          expectedProjectRevision: concept.project.revision,
        },
      },
    ],
    [
      "createConcept",
      {
        projectId: made.project.projectId,
        idempotencyKey: "foreign-concept",
        request: {
          name: "foreign",
          prompt: "foreign",
          briefRevision: 1,
          expectedProjectRevision: concept.project.revision,
        },
      },
    ],
    [
      "appendConceptRevision",
      {
        projectId: made.project.projectId,
        assetId: concept.asset.assetId,
        idempotencyKey: "foreign-revision",
        request: {
          prompt: "foreign",
          briefRevision: 1,
          expectedProjectRevision: concept.project.revision,
          expectedAssetMetadataRevision: concept.asset.revision,
        },
      },
    ],
  ] as const)
    await assert.rejects(
      b.invoke(method, command),
      /creative_project_not_found/,
    );
  await assert.rejects(
    b.invoke("appendConceptRevision", {
      projectId: other.project.projectId,
      assetId: concept.asset.assetId,
      idempotencyKey: "mixed-scope",
      request: {
        prompt: "foreign",
        briefRevision: 1,
        expectedProjectRevision: other.project.revision,
        expectedAssetMetadataRevision: concept.asset.revision,
      },
    }),
    /creative_project_asset_not_found/,
  );
  assert.deepEqual(f.counts(), before);
});

test("two actual UI calls racing on one project revision commit one brief and return a CAS conflict for the other", async (t) => {
  const f = await fixture(t),
    a = await f.ui();
  const made = (await a.invoke(
    "createProject",
    creativeCreateInput(),
  )) as ProjectResult;
  const command = (key: string) => ({
    projectId: made.project.projectId,
    idempotencyKey: key,
    request: { text: key, expectedProjectRevision: made.project.revision },
  });
  const outcomes = await Promise.allSettled([
    a.invoke("appendBrief", command("parallel-a")),
    a.invoke("appendBrief", command("parallel-b")),
  ]);
  assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1);
  const failed = outcomes.find(
    (v) => v.status === "rejected",
  ) as PromiseRejectedResult;
  assert.match(String(failed.reason), /revision_conflict/);
  assert.deepEqual(Object.values(f.counts()), [1, 2, 1, 2]);
});

for (const method of [
  "appendBrief",
  "createConcept",
  "appendConceptRevision",
] as const) {
  test(`${method} retains the independent write policy after its scoped preparation reads`, async (t) => {
    const f = await fixture(t),
      a = await f.ui();
    let made = (await a.invoke(
      "createProject",
      creativeCreateInput(),
    )) as ProjectResult;
    let concept: ConceptResult | undefined;
    if (method === "appendConceptRevision") {
      concept = (await a.invoke("createConcept", {
        projectId: made.project.projectId,
        idempotencyKey: "seed",
        request: {
          name: "seed",
          prompt: "seed",
          briefRevision: 1,
          expectedProjectRevision: made.project.revision,
        },
      })) as ConceptResult;
      made = concept;
    }
    const before = f.counts();
    const bind = f.store.bindProjectReads.bind(f.store);
    f.store.bindProjectReads = (scope) => {
      const view = bind(scope);
      return {
        ...view,
        loadProject: async (input) => {
          const project = await view.loadProject(input);
          a.state.beforeHost = async () => {
            f.policy.allowed = false;
          };
          return project;
        },
      };
    };
    await assert.rejects(
      a.invoke(method, {
        projectId: made.project.projectId,
        ...(concept ? { assetId: concept.asset.assetId } : {}),
        idempotencyKey: "deny-content",
        request: {
          expectedProjectRevision: made.project.revision,
          ...(method === "appendBrief"
            ? { text: "deny" }
            : { prompt: "deny", briefRevision: 1 }),
          ...(method === "createConcept" ? { name: "deny" } : {}),
          ...(concept
            ? { expectedAssetMetadataRevision: concept.asset.revision }
            : {}),
        },
      }),
      /authorization_denied/,
    );
    assert.deepEqual(f.counts(), before);
  });
}

test("actual installation revocation after concept preparation rejects the original SQL publication", async (t) => {
  const f = await fixture(t),
    a = await f.ui();
  const made = (await a.invoke(
    "createProject",
    creativeCreateInput(),
  )) as ProjectResult;
  const before = f.counts();
  const next = f.ids.nextId;
  f.ids.nextId = () => {
    let revoked = false;
    a.state.beforeHost = async () => {
      if (revoked) return;
      revoked = true;
      await f.installations.commitSelection(
        selectionRecipe(a.ui.state.selection!, "deny-prepared-concept", {
          actor: uiTestActor,
          state: "disabled",
          at: uiTestAt,
        }),
      );
    };
    return next();
  };
  await assert.rejects(
    a.invoke("createConcept", {
      projectId: made.project.projectId,
      idempotencyKey: "disabled-concept",
      request: {
        name: "denied",
        prompt: "denied",
        briefRevision: 1,
        expectedProjectRevision: made.project.revision,
      },
    }),
  );
  assert.deepEqual(f.counts(), before);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM creative_concept_assets").get()!.n,
    0,
  );
});
