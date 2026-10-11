import { ownedProjectSqliteFixture as fixture } from "./plugin-project-owned-sqlite.test-support.ts";
import {
  createConceptAsset,
  parseInstalledPluginPackage,
  parsePluginSelection,
} from "@crewon/domain";
import {
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
  type PluginProjectMutationScope,
} from "@crewon/application";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import { creativeCreateInput } from "../../application/src/plugin-creative-project-action.test-support.ts";
import {
  uiTestActor,
  uiTestAt,
  uiTestMountCommand,
} from "../../application/src/plugin-ui.test-support.ts";

test("original UI creation commits project, brief, full owner and scoped receipt together and replays the same ID", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  const first = (await ui.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
    disposition: string;
  };
  const replay = (await ui.invoke(
    "createProject",
    creativeCreateInput(),
  )) as typeof first;
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.project.projectId, first.project.projectId);
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
  const owner = f.db
    .prepare("SELECT * FROM plugin_project_metadata_owners")
    .get()!;
  assert.equal(owner.actor_id, uiTestActor.actorId);
  assert.equal(owner.principal_id, uiTestActor.principalId);
  assert.equal(owner.plugin_id, ui.ui.state.package.pluginId);
  assert.equal(owner.publisher_id, ui.ui.state.package.publisherId);
  assert.equal(owner.profile_id, ui.ui.state.scope.profileId);
  assert.equal(owner.project_id, first.project.projectId);
  assert.equal(
    await f.store.loadProject({
      owner: {
        tenantId: uiTestActor.tenantId,
        spaceId: uiTestActor.spaceId,
        principalId: uiTestActor.principalId,
      },
      projectId: first.project.projectId,
    }),
    null,
  );
  await assert.rejects(
    ui.invoke("createProject", {
      ...creativeCreateInput(),
      request: { title: "changed", briefText: "changed" },
    }),
    /idempotency_conflict/,
  );
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("two installed plugins with one external creation key keep separate projects and receipts", async (t) => {
  const f = await fixture(t);
  const a = await f.ui(),
    b = await f.ui("example.other");
  const x = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  const y = (await b.invoke(
    "createProject",
    creativeCreateInput(),
  )) as typeof x;
  assert.notEqual(x.project.projectId, y.project.projectId);
  assert.deepEqual(Object.values(f.counts()), [2, 2, 2, 2]);
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(DISTINCT idempotency_key) AS n FROM creative_project_mutation_receipts",
      )
      .get()!.n,
    2,
  );
});

test("original SQL identity guard rejects changed creation facts and leaves the owned replay intact", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  const original = await ui.invoke("createProject", creativeCreateInput());
  assert.throws(
    () =>
      f.db.exec(
        "UPDATE creative_projects SET record_json=json_set(record_json,'$.createdByActorId','foreign-original-author')",
      ),
    /creative_project_identity_immutable/,
  );
  const replay = (await ui.invoke(
    "createProject",
    creativeCreateInput(),
  )) as Record<string, unknown>;
  assert.deepEqual({ ...replay, disposition: "committed" }, original);
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("receipt insertion failure rolls back the already written project, brief and sidecar", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  f.db.exec(
    "CREATE TRIGGER fail_owned_receipt BEFORE INSERT ON creative_project_mutation_receipts BEGIN SELECT RAISE(ABORT,'named_owned_receipt_failure'); END",
  );
  await assert.rejects(ui.invoke("createProject", creativeCreateInput()));
  assert.deepEqual(Object.values(f.counts()), [0, 0, 0, 0]);
  f.db.exec("DROP TRIGGER fail_owned_receipt");
  await ui.invoke("createProject", creativeCreateInput());
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("a confirmed owned SQL commit remains acknowledged when the Host closes before Service return", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  const commit = f.store.commitOwnedProjectCreation.bind(f.store);
  f.store.commitOwnedProjectCreation = async (input, options) => {
    const result = await commit(input, options);
    // close withdraws synchronously and joins this invocation asynchronously.
    void ui.owner.close();
    return result;
  };
  const result = (await ui.invoke("createProject", creativeCreateInput())) as {
    disposition: string;
  };
  assert.equal(result.disposition, "committed");
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("creation refuses an occupied legacy project ID rather than adopting it", async (t) => {
  const f = await fixture(t);
  f.ids.nextId = () => "occupied-legacy";
  await f.service.createProject(uiTestActor, {
    title: "legacy",
    briefText: "legacy",
    idempotencyKey: "legacy-create",
  });
  const ui = await f.ui();
  await assert.rejects(ui.invoke("createProject", creativeCreateInput()));
  assert.deepEqual(Object.values(f.counts()), [1, 1, 0, 1]);
});

test("an approved UI invocation does not replace independent creativeProject:create policy", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  f.policy.allowed = false;
  await assert.rejects(
    ui.invoke("createProject", creativeCreateInput()),
    /authorization_denied/,
  );
  assert.deepEqual(Object.values(f.counts()), [0, 0, 0, 0]);
});

test("project policy withdrawn during final Host approval prevents all owned creation writes", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  f.ids.nextId = () => {
    ui.state.beforeHost = async () => {
      f.policy.allowed = false;
    };
    return "named-final-host-revocation";
  };
  await assert.rejects(
    ui.invoke("createProject", creativeCreateInput()),
    /authorization_denied/,
  );
  assert.deepEqual(Object.values(f.counts()), [0, 0, 0, 0]);
});

test("actual installation withdrawal rejects creation even while the UI discovery fixture still reports approval", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  await f.installations.commitSelection(
    selectionRecipe(ui.ui.state.selection!, "disable-actual-source", {
      actor: uiTestActor,
      state: "disabled",
      at: uiTestAt,
    }),
  );
  await assert.rejects(ui.invoke("createProject", creativeCreateInput()));
  assert.deepEqual(Object.values(f.counts()), [0, 0, 0, 0]);
});

for (const schema of ["absent", "partial"] as const) {
  test(`qualified creation refuses ${schema} ownership schema instead of creating a legacy project`, async (t) => {
    const f = await fixture(t, schema === "absent" ? "absent" : "complete");
    const ui = await f.ui();
    if (schema === "partial")
      f.db.exec("DROP TABLE plugin_project_metadata_owner_schema_version");
    await assert.rejects(ui.invoke("createProject", creativeCreateInput()));
    assert.deepEqual(Object.values(f.counts()), [0, 0, 0, 0]);
  });
}

test("owned UI project reads reuse original detail, brief and list recipes and refuse another plugin", async (t) => {
  const f = await fixture(t);
  const a = await f.ui(),
    b = await f.ui("example.other");
  const first = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  const second = (await b.invoke(
    "createProject",
    creativeCreateInput(),
  )) as typeof first;
  const projectId = first.project.projectId;
  const detail = (await a.invoke("getProject", { projectId })) as typeof first;
  assert.equal(detail.project.projectId, projectId);
  const brief = (await a.invoke("getBrief", {
    projectId,
    briefRevision: 1,
  })) as { brief: { projectId: string } };
  assert.equal(brief.brief.projectId, projectId);
  const briefs = (await a.invoke("listBriefs", { projectId, query: {} })) as {
    briefs: unknown[];
  };
  assert.equal(briefs.briefs.length, 1);
  assert.deepEqual(
    await a.invoke("listConceptAssets", { projectId, query: {} }),
    { assets: [], nextAfterAssetId: null },
  );
  const page = (await a.invoke("listProjects", { query: {} })) as {
    projects: { projectId: string }[];
  };
  assert.deepEqual(
    page.projects.map((p) => p.projectId),
    [projectId],
  );
  for (const method of [
    "getProject",
    "getBrief",
    "listBriefs",
    "getConceptAsset",
    "listConceptAssets",
    "getConceptRevision",
    "listConceptRevisions",
  ]) {
    const query = method.startsWith("list") ? { query: {} } : {};
    const input = {
      projectId: second.project.projectId,
      ...query,
      ...(method === "getBrief" ? { briefRevision: 1 } : {}),
      ...(method.includes("Concept") && method !== "listConceptAssets"
        ? { assetId: "foreign-asset" }
        : {}),
      ...(method === "getConceptRevision" ? { assetRevision: 1 } : {}),
    };
    await assert.rejects(a.invoke(method, input), /creative_project_not_found/);
  }
});

test("owned project SQL filters before pagination so another plugin does not consume page slots", async (t) => {
  const f = await fixture(t);
  const a = await f.ui(),
    b = await f.ui("example.other");
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const made = (await (i % 2 ? b : a).invoke("createProject", {
      ...creativeCreateInput(),
      idempotencyKey: `page-${i}`,
    })) as { project: { projectId: string } };
    if (i % 2 === 0) ids.unshift(made.project.projectId);
  }
  const page = (await a.invoke("listProjects", { query: { limit: 1 } })) as {
    projects: { projectId: string }[];
    nextCursor: string | null;
  };
  assert.deepEqual(
    page.projects.map((p) => p.projectId),
    ids.slice(0, 1),
  );
  assert.ok(page.nextCursor);
  const next = (await a.invoke("listProjects", {
    query: { limit: 1, cursor: page.nextCursor },
  })) as typeof page;
  assert.deepEqual(
    next.projects.map((p) => p.projectId),
    ids.slice(1),
  );
  assert.equal(next.nextCursor, null);
  const legacy = await f.store.listProjects({
    owner: {
      tenantId: uiTestActor.tenantId,
      spaceId: uiTestActor.spaceId,
      principalId: uiTestActor.principalId,
    },
    state: "all",
    after: null,
    limit: 20,
  });
  assert.deepEqual(legacy.projects, []);
});

test("owned detail reads retain independent project policy and actual installation checks", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  f.policy.allowed = false;
  await assert.rejects(
    a.invoke("getProject", { projectId: made.project.projectId }),
    /authorization_denied/,
  );
  f.policy.allowed = true;
  await f.installations.commitSelection(
    selectionRecipe(a.ui.state.selection!, "deny-owned-read", {
      actor: uiTestActor,
      state: "disabled",
      at: uiTestAt,
    }),
  );
  await assert.rejects(
    a.invoke("getProject", { projectId: made.project.projectId }),
  );
});

test("owned read references resist copies, other actors, other methods and target changes, and expire after the UI call", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  let ref: PluginProjectReadScope | PluginProjectMutationScope | undefined;
  const bind = f.store.bindProjectReads.bind(f.store);
  f.store.bindProjectReads = (scope) => {
    ref = scope;
    const view = bind(scope);
    return {
      ...view,
      loadProject: async (input) => {
        assert.throws(() => bind({ ...scope }), /scope_unavailable/);
        const owner = {
          tenantId: uiTestActor.tenantId,
          spaceId: uiTestActor.spaceId,
          principalId: uiTestActor.principalId,
        };
        await assert.rejects(
          view.loadBrief({
            owner,
            projectId: made.project.projectId,
            briefRevision: 1,
          }),
          /method_mismatch/,
        );
        await assert.rejects(
          view.loadProject({ owner, projectId: "other-project" }),
          /target_mismatch/,
        );
        for (const key of [
          "tenantId",
          "spaceId",
          "principalId",
          "actorId",
        ] as const) {
          await assert.rejects(
            f.service.getProject(
              { ...uiTestActor, [key]: "another-identity" },
              { projectId: made.project.projectId },
              { readScope: scope },
            ),
            /actor_mismatch/,
          );
        }
        return view.loadProject(input);
      },
    };
  };
  await a.invoke("getProject", { projectId: made.project.projectId });
  assert.ok(ref);
  assert.throws(() => qualifyPluginProjectReadScope(ref!), /unavailable/);
});

test("project policy withdrawn during a scoped read's final source check prevents publication", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  const bind = f.store.bindProjectReads.bind(f.store);
  f.store.bindProjectReads = (scope) => {
    const view = bind(scope);
    return {
      ...view,
      loadProject: async (input) => {
        const result = await view.loadProject(input);
        f.policy.allowed = false;
        return result;
      },
    };
  };
  await assert.rejects(
    a.invoke("getProject", { projectId: made.project.projectId }),
    /authorization_denied/,
  );
});

test("owned concept readers preserve the original asset, revision and history validation", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  // Named persisted-data fixture: Domain creates records, original schema constraints stay installed.
  // This proves protected reads, not a protected concept-write invocation.
  const concept = createConceptAsset(
    {
      project: JSON.parse(
        String(
          f.db
            .prepare(
              "SELECT record_json FROM creative_projects WHERE project_id=?",
            )
            .get(made.project.projectId)!.record_json,
        ),
      ),
      brief: JSON.parse(
        String(
          f.db
            .prepare(
              "SELECT record_json FROM creative_project_briefs WHERE project_id=? AND brief_revision=1",
            )
            .get(made.project.projectId)!.record_json,
        ),
      ),
      actor: uiTestActor,
      expectedProjectRevision: Number(
        f.db
          .prepare("SELECT revision FROM creative_projects WHERE project_id=?")
          .get(made.project.projectId)!.revision,
      ),
      at: uiTestAt,
      assetId: "named-concept",
      name: "test concept",
      prompt: "test prompt",
    },
    {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
  );
  f.db.exec("BEGIN IMMEDIATE");
  f.db
    .prepare(
      "UPDATE creative_projects SET revision=?,record_json=? WHERE project_id=?",
    )
    .run(
      concept.project.revision,
      JSON.stringify(concept.project),
      made.project.projectId,
    );
  f.db
    .prepare(
      "INSERT INTO creative_concept_assets(tenant_id,space_id,project_id,asset_id,revision,latest_asset_revision,record_json) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      concept.asset.tenantId,
      concept.asset.spaceId,
      concept.asset.projectId,
      concept.asset.assetId,
      concept.asset.revision,
      concept.asset.latestAssetRevision,
      JSON.stringify(concept.asset),
    );
  f.db
    .prepare(
      "INSERT INTO creative_concept_revisions(tenant_id,space_id,project_id,asset_id,asset_revision,brief_revision,brief_content_digest,content_digest,record_json) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      concept.assetRevision.tenantId,
      concept.assetRevision.spaceId,
      concept.assetRevision.projectId,
      concept.assetRevision.assetId,
      concept.assetRevision.assetRevision,
      concept.assetRevision.briefRevision,
      concept.assetRevision.briefContentDigest,
      concept.assetRevision.contentDigest,
      JSON.stringify(concept.assetRevision),
    );
  f.db.exec("COMMIT");
  const target = {
    projectId: made.project.projectId,
    assetId: concept.asset.assetId,
  };
  const asset = (await a.invoke("getConceptAsset", target)) as {
    asset: { assetId: string };
  };
  assert.equal(asset.asset.assetId, concept.asset.assetId);
  const revision = (await a.invoke("getConceptRevision", {
    ...target,
    assetRevision: 1,
  })) as { assetRevision: { contentDigest: string } };
  assert.equal(
    revision.assetRevision.contentDigest,
    concept.assetRevision.contentDigest,
  );
  const history = (await a.invoke("listConceptRevisions", {
    ...target,
    query: {},
  })) as { revisions: unknown[] };
  assert.equal(history.revisions.length, 1);
  const assets = (await a.invoke("listConceptAssets", {
    projectId: target.projectId,
    query: {},
  })) as { assets: unknown[] };
  assert.equal(assets.assets.length, 1);
});

test("a genuine UI read by another actor sharing the principal cannot list or load the original owned project", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  const actor = { ...uiTestActor, actorId: "another-actual-ui-actor" };
  const lease = await a.service.openMount(actor, {
    ...uiTestMountCommand,
    pluginId: a.ui.state.package.pluginId,
    expectedPackageDigest: a.ui.state.package.packageDigest,
  });
  const invoke = (method: string, input: unknown) =>
    a.service.invoke(actor, {
      mountRef: lease.mountRef,
      action: `crewon.creative-projects.v1.${method}`,
      input: input as never,
    });
  assert.deepEqual(await invoke("listProjects", { query: {} }), {
    projects: [],
    nextCursor: null,
  });
  await assert.rejects(
    invoke("getProject", { projectId: made.project.projectId }),
    /creative_project_not_found/,
  );
});

test("an actually installed same plugin on another profile cannot use the original project's owner", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  a.ui.state.scope = { ...a.ui.state.scope, profileId: "another-profile" };
  a.ui.state.package = parseInstalledPluginPackage({
    ...a.ui.state.package,
    ...a.ui.state.scope,
  });
  a.ui.state.selection = parsePluginSelection({
    ...a.ui.state.selection!,
    ...a.ui.state.scope,
  });
  const receipt = (key: string) => ({
    idempotencyKey: key,
    requestDigest: `sha256:${createHash("sha256").update(key).digest("hex")}`,
  });
  const installed = await f.installations.recordInstalledPackage({
    actor: uiTestActor,
    scope: a.ui.state.scope,
    package: a.ui.state.package,
    receipt: receipt("other-profile-install"),
    expectedSelectionRevision: null,
  });
  await f.installations.commitSelection({
    actor: uiTestActor,
    scope: a.ui.state.scope,
    selection: a.ui.state.selection!,
    receipt: receipt("other-profile-enable"),
    expectedSelectionRevision: installed.selection.revision,
  });
  assert.deepEqual(await a.invoke("listProjects", { query: {} }), {
    projects: [],
    nextCursor: null,
  });
  await assert.rejects(
    a.invoke("getProject", { projectId: made.project.projectId }),
    /creative_project_not_found/,
  );
});

test("partial owner schema rejects protected reads without falling back to the legacy reader", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  f.db.exec("DROP TABLE plugin_project_metadata_owner_schema_version");
  await assert.rejects(
    a.invoke("getProject", { projectId: made.project.projectId }),
  );
  await assert.rejects(a.invoke("listProjects", { query: {} }));
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("Host closure withdraws the bound read view before its original query", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  const bind = f.store.bindProjectReads.bind(f.store);
  f.store.bindProjectReads = (scope) => {
    const view = bind(scope);
    void a.owner.close();
    return view;
  };
  await assert.rejects(
    a.invoke("getProject", { projectId: made.project.projectId }),
  );
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("owned metadata rename, archive and restore use original CAS and scoped replay", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string; revision: number };
  };
  const projectId = made.project.projectId;
  const command = {
    projectId,
    idempotencyKey: "owned-rename",
    request: {
      title: "owned new title",
      expectedProjectRevision: made.project.revision,
    },
  };
  const renamed = (await a.invoke("renameProject", command)) as typeof made & {
    disposition: string;
  };
  const replay = (await a.invoke("renameProject", command)) as typeof renamed;
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.project, renamed.project);
  await assert.rejects(
    a.invoke("renameProject", {
      ...command,
      request: { ...command.request, title: "changed content" },
    }),
    /idempotency_conflict/,
  );
  await assert.rejects(
    a.invoke("renameProject", { ...command, idempotencyKey: "stale-revision" }),
    /revision_conflict/,
  );
  const archived = (await a.invoke("setProjectState", {
    projectId,
    idempotencyKey: "owned-archive",
    request: {
      state: "archived",
      expectedProjectRevision: renamed.project.revision,
    },
  })) as typeof made;
  const page = (await a.invoke("listProjects", {
    query: { state: "archived" },
  })) as { projects: unknown[] };
  assert.equal(page.projects.length, 1);
  await a.invoke("setProjectState", {
    projectId,
    idempotencyKey: "owned-restore",
    request: {
      state: "active",
      expectedProjectRevision: archived.project.revision,
    },
  });
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 4]);
});

test("metadata write rejects another plugin and rolls back an original receipt failure", async (t) => {
  const f = await fixture(t);
  const a = await f.ui(),
    b = await f.ui("example.other");
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string; revision: number };
  };
  const command = {
    projectId: made.project.projectId,
    idempotencyKey: "owned-write",
    request: {
      title: "should roll back",
      expectedProjectRevision: made.project.revision,
    },
  };
  await assert.rejects(
    b.invoke("renameProject", command),
    /creative_project_not_found/,
  );
  f.db.exec(
    "CREATE TRIGGER fail_owned_metadata_receipt BEFORE INSERT ON creative_project_mutation_receipts BEGIN SELECT RAISE(ABORT,'named_metadata_failure'); END",
  );
  await assert.rejects(a.invoke("renameProject", command));
  const current = (await a.invoke("getProject", {
    projectId: made.project.projectId,
  })) as typeof made;
  assert.deepEqual(current.project, made.project);
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
  f.db.exec("DROP TRIGGER fail_owned_metadata_receipt");
  await a.invoke("renameProject", command);
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 2]);
});

test("write policy withdrawn after owned project preparation prevents metadata COMMIT", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string; revision: number };
  };
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
    a.invoke("renameProject", {
      projectId: made.project.projectId,
      idempotencyKey: "late-write-deny",
      request: {
        title: "denied",
        expectedProjectRevision: made.project.revision,
      },
    }),
    /authorization_denied/,
  );
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("confirmed owned metadata COMMIT is delivered after Host close without turning it into a retry", async (t) => {
  const f = await fixture(t);
  const a = await f.ui();
  const made = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string; revision: number };
  };
  const commit = f.store.commitProjectMetadata.bind(f.store);
  f.store.commitProjectMetadata = async (input, options) => {
    const result = await commit(input, options);
    void a.owner.close();
    return result;
  };
  const result = (await a.invoke("renameProject", {
    projectId: made.project.projectId,
    idempotencyKey: "acknowledged-rename",
    request: {
      title: "confirmed title",
      expectedProjectRevision: made.project.revision,
    },
  })) as { disposition: string };
  assert.equal(result.disposition, "committed");
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 2]);
});
