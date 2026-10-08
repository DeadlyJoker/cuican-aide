import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";
import {
  PROJECT_FOUNDATION_MUTATION_ACTIONS,
  type ProjectFoundationCommitAuthority,
  type ProjectFoundationMutationKind,
} from "@crewon/application";
import { setProjectFoundationCreativeStartMode } from "@crewon/domain";
import {
  optionsFor,
  pluginCommitFixture,
  selectionRecipe,
  type Backend,
} from "./creative-project-plugin-commit.test-support.ts";
import { installationRecipe } from "./plugin-installation-store.test-support.ts";
import {
  actor,
  confirmationRecipe,
  foundationCreationRecipe,
  foundationTables,
  parameterChangeRecipe,
  proposalRecipe,
  receipt,
  sourceChangeRecipe,
  time,
} from "./project-foundation-store.test-support.ts";

type Fixture = Awaited<ReturnType<typeof pluginCommitFixture>>;
type SourceChange = "disabled" | "uninstalled" | "changed-package";
function grant(
  f: Fixture,
  kind: ProjectFoundationMutationKind = "create-project",
) {
  const original = f.grant(PROJECT_FOUNDATION_MUTATION_ACTIONS[kind]);
  // Only this installation-backed test fixture reuses its policy callbacks. Product grants
  // cannot be converted from the old protocol; its authority boundary explicitly rejects it.
  const authority: ProjectFoundationCommitAuthority = {
    assertCurrent: original.authority.assertCurrent,
    assertActive: original.authority.assertActive,
    transaction: {
      ...original.authority.transaction!,
      version: "crewon.project-foundation-plugin-commit.v1",
    },
  };
  return { state: original.state, authority };
}
async function prepare(
  t: Parameters<typeof pluginCommitFixture>[0],
  backend: Backend,
) {
  const f = await pluginCommitFixture(t, backend);
  // This suite qualifies installation commits for trusted internal recipes. Actual upload
  // adoption has a separate real-ledger suite; neither authority substitutes for the other.
  const foundation = f.parent.projectFoundationStore({
    sourceAdmission: "trusted-internal-recipe",
  });
  await foundation.migrate();
  return { ...f, foundation };
}
async function counts(f: Fixture) {
  const result: Record<string, number> = {};
  for (const table of foundationTables) {
    result[table] = Number(
      (await f.query(`SELECT COUNT(*) AS n FROM ${f.prefix}${table}`))[0]!.n,
    );
  }
  return result;
}
function emptyCounts() {
  return Object.fromEntries(foundationTables.map((table) => [table, 0]));
}
async function changeSource(f: Fixture, state: SourceChange) {
  let selection = f.source.selection;
  if (state === "changed-package") {
    const next = await f.otherInstallations.recordInstalledPackage(
      installationRecipe("source-next-install", {
        scope: f.scope,
        actor,
        pluginId: f.source.package.pluginId,
        version: "6.0.0",
        expectedSelectionRevision: selection.revision,
      }),
    );
    selection = next.selection;
  }
  return f.otherInstallations.commitSelection(
    selectionRecipe(selection, `source-${state}`, {
      actor,
      state: state === "changed-package" ? "enabled" : state,
    }),
  );
}
/** Observe the server's lock dependency, rather than assuming a writer is pending after delay. */
async function waitBlocked(
  client: PoolClient,
  blockerPid: number,
  pattern: string,
) {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    await client.query("SELECT pg_stat_clear_snapshot()");
    const rows = (
      await client.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE $2 AND wait_event_type='Lock'",
        [blockerPid, pattern],
      )
    ).rows;
    if (rows.length === 1) return Number(rows[0]!.pid);
    assert.ok(rows.length <= 1);
    await delay(5);
  }
  assert.fail(`SQL did not wait on backend ${blockerPid}: ${pattern}`);
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: qualified foundation uses its new actions and actual enabled installation without paid migrations`,
    optionsFor(backend),
    async (t) => {
      const f = await prepare(t, backend);
      const create = grant(f);
      const input = foundationCreationRecipe(
        "qualified-novel",
        "qualified-novel-create",
        "novel",
      );
      const created = await f.foundation.commitCreation(input, {
        authority: create.authority,
      });
      assert.ok(create.state.fullCalls >= 1);
      assert.ok(create.state.transactionCalls >= 1);
      assert.deepEqual(
        await f.foundation.commitCreation(input, {
          authority: create.authority,
        }),
        { ...created, disposition: "replayed" },
      );
      const candidate = proposalRecipe(
        created.project,
        created.foundation,
        "qualified-proposal",
      );
      const save = grant(f, "save-proposal");
      const saved = await f.foundation.commitProposal(candidate, {
        authority: save.authority,
      });
      assert.deepEqual(saved.foundation, created.foundation);
      assert.deepEqual(
        await f.foundation.commitProposal(candidate, {
          authority: save.authority,
        }),
        { ...saved, disposition: "replayed" },
      );
      const confirmed = await f.foundation.commitFoundationChange(
        confirmationRecipe(
          created.project,
          created.foundation,
          candidate.proposal,
          "qualified-confirm",
        ),
        { authority: grant(f, "confirm-proposal").authority },
      );
      const changed = await f.foundation.commitFoundationChange(
        parameterChangeRecipe(
          created.project,
          confirmed.foundation,
          "qualified-parameters",
          3,
        ),
        { authority: grant(f, "update-parameters").authority },
      );
      const appended = await f.foundation.commitFoundationChange(
        sourceChangeRecipe(
          created.project,
          changed.foundation,
          "qualified-source",
          2,
          4,
        ),
        { authority: grant(f, "append-source").authority },
      );
      assert.equal(appended.foundation.revision, 4);
      assert.equal(appended.foundation.confirmedProposal, null);
      const creative = await f.foundation.commitCreation(
        foundationCreationRecipe("qualified-creative"),
        { authority: grant(f).authority },
      );
      const direct = setProjectFoundationCreativeStartMode({
        project: creative.project,
        foundation: creative.foundation,
        actor,
        expectedFoundationRevision: 1,
        creativeStartMode: "direct-script",
        at: time(1),
      });
      await f.foundation.commitFoundationChange(
        {
          actor,
          receipt: receipt("qualified-direct"),
          kind: "choose-direct-script",
          expectedFoundationRevision: 1,
          foundation: direct,
          source: null,
          chunks: [],
          chapters: [],
          proposal: null,
        },
        { authority: grant(f, "choose-direct-script").authority },
      );
      assert.deepEqual(
        await f.foundation.loadMutationReceipt(
          { actor, kind: "create-project", receipt: input.receipt },
          { authority: create.authority },
        ),
        { ...created, disposition: "replayed" },
      );
      assert.deepEqual(await counts(f), {
        creative_projects: 2,
        creative_project_briefs: 2,
        creative_project_mutation_receipts: 0,
        project_foundations: 2,
        project_sources: 2,
        project_source_chunks: 4,
        project_source_chapters: 4,
        project_proposals: 1,
        project_foundation_mutation_receipts: 7,
      });
      for (const name of [
        "plugin_task_admission_schema_version",
        "plugin_credit_schema_version",
        "extension_credit_schema_version",
        "plugin_query_task_admission_schema_version",
        "project_generation_schema_version",
      ])
        assert.equal((await f.tableNames()).includes(name), false, name);
      if (backend === "postgres") {
        assert.equal(f.pool!.options.max, 1);
        assert.ok(
          f.commands.filter((sql) => sql.includes("FOR SHARE OF s,p")).length >=
            7,
        );
      }
    },
  );

  test(
    `${backend}: foundation refuses old versions/actions and mismatched mutation actors before preflight`,
    optionsFor(backend),
    async (t) => {
      const f = await prepare(t, backend);
      for (const change of [
        { principalId: "other-principal" },
        { actorId: "other-actor" },
        { action: PROJECT_FOUNDATION_MUTATION_ACTIONS["save-proposal"] },
        { action: "crewon.creative-projects.v1.createProject" },
      ]) {
        const g = grant(f);
        const authority: ProjectFoundationCommitAuthority = {
          ...g.authority,
          transaction: {
            ...g.authority.transaction!,
            pin: { ...g.authority.transaction!.pin, ...change },
          },
        };
        await assert.rejects(
          f.foundation.commitCreation(
            foundationCreationRecipe("bad-pin", JSON.stringify(change)),
            { authority },
          ),
        );
        assert.equal(g.state.fullCalls, 0);
      }
      const old = f.grant(
        PROJECT_FOUNDATION_MUTATION_ACTIONS["create-project"],
      );
      await assert.rejects(
        f.foundation.commitCreation(foundationCreationRecipe("old-version"), {
          authority: old.authority as never,
        }),
        /project_foundation_commit_authority_invalid/,
      );
      assert.equal(old.state.fullCalls, 0);
      const originalAction = f.grant();
      const actionOnly = {
        ...originalAction.authority,
        transaction: {
          ...originalAction.authority.transaction!,
          version: "crewon.project-foundation-plugin-commit.v1" as const,
        },
      };
      await assert.rejects(
        f.foundation.commitCreation(foundationCreationRecipe("old-action"), {
          authority: actionOnly,
        }),
        /project_foundation_commit_authority_invalid/,
      );
      assert.equal(originalAction.state.fullCalls, 0);
      const g = grant(f);
      const otherActor = { ...actor, actorId: "new-device-actor" };
      await assert.rejects(
        f.foundation.commitCreation(
          foundationCreationRecipe(
            "other-actor",
            "other-actor-create",
            "creative",
            otherActor,
          ),
          { authority: g.authority },
        ),
        /project_foundation_plugin_commit_pin_mismatch/,
      );
      assert.equal(g.state.fullCalls, 0);
      assert.deepEqual(await counts(f), emptyCounts());
    },
  );

  for (const state of ["disabled", "uninstalled", "changed-package"] as const) {
    test(
      `${backend}: actual installation ${state} after preflight rejects foundation atomically`,
      optionsFor(backend),
      async (t) => {
        const f = await prepare(t, backend);
        const g = grant(f);
        g.state.preflightHook = async () => {
          await changeSource(f, state);
        };
        await assert.rejects(
          f.foundation.commitCreation(
            foundationCreationRecipe(
              `withdrawn-${state}`,
              `withdrawn-${state}`,
              "novel",
            ),
            { authority: g.authority },
          ),
          /plugin_installation_pin_conflict/,
        );
        assert.equal(g.state.fullCalls, 1);
        assert.deepEqual(await counts(f), emptyCounts());
      },
    );
  }

  test(
    `${backend}: captured complete selection audit rejects same-revision installation tampering`,
    optionsFor(backend),
    async (t) => {
      const f = await prepare(t, backend);
      const g = grant(f);
      g.state.preflightHook = async () =>
        f.execute(
          backend === "sqlite"
            ? "UPDATE plugin_profile_selections SET record_json=json_set(record_json,'$.updatedByActorId','actor-audit-replaced')"
            : `UPDATE ${f.prefix}plugin_profile_selections SET record_json=jsonb_set(record_json,'{updatedByActorId}','"actor-audit-replaced"'::jsonb)`,
        );
      await assert.rejects(
        f.foundation.commitCreation(
          foundationCreationRecipe("audit-tamper", "audit-tamper", "novel"),
          { authority: g.authority },
        ),
      );
      assert.equal(g.state.fullCalls, 1);
      assert.deepEqual(await counts(f), emptyCounts());
    },
  );

  test(
    `${backend}: unavailable installation cannot publish an existing foundation receipt`,
    optionsFor(backend),
    async (t) => {
      const f = await prepare(t, backend);
      const g = grant(f);
      const input = foundationCreationRecipe(
        "replay",
        "replay-create",
        "novel",
      );
      await f.foundation.commitCreation(input, { authority: g.authority });
      const before = await counts(f);
      g.state.preflightHook = async () => {
        await changeSource(f, "uninstalled");
      };
      await assert.rejects(
        f.foundation.commitCreation(input, { authority: g.authority }),
        /plugin_installation_pin_conflict/,
      );
      g.state.preflightHook = null;
      await assert.rejects(
        f.foundation.loadMutationReceipt(
          { actor, kind: "create-project", receipt: input.receipt },
          { authority: g.authority },
        ),
        /metadata_source_changed/,
      );
      assert.deepEqual(await counts(f), before);
    },
  );

  test(
    `${backend}: future installation schema introduced after preflight rejects foundation without repair`,
    optionsFor(backend),
    async (t) => {
      const f = await prepare(t, backend);
      const g = grant(f);
      g.state.preflightHook = async () =>
        f.execute(
          `UPDATE ${f.prefix}plugin_installation_schema_version SET version=99 WHERE id=1`,
        );
      await assert.rejects(
        f.foundation.commitCreation(foundationCreationRecipe("future-schema"), {
          authority: g.authority,
        }),
        /plugin_installation_schema_version_unsupported/,
      );
      assert.deepEqual(await counts(f), emptyCounts());
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT version FROM ${f.prefix}plugin_installation_schema_version`,
            )
          )[0]!.version,
        ),
        99,
      );
    },
  );
}

test(
  "PostgreSQL foundation holds actual installation SHARE through COMMIT with one application connection",
  optionsFor("postgres"),
  async (t) => {
    const f = await prepare(t, "postgres");
    const g = grant(f);
    const gate = f.arm("source");
    const saving = f.track(
      f.foundation.commitCreation(
        foundationCreationRecipe("held-source", "held-source-create", "novel"),
        { authority: g.authority },
      ),
    );
    void saving.catch(() => {});
    await gate.entered.promise;
    assert.ok(f.metadataPid !== null);
    const changing = f.track(changeSource(f, "disabled"));
    void changing.catch(() => {});
    const observer = await f.observerPool!.connect();
    try {
      const writerPid = await waitBlocked(
        observer,
        f.metadataPid,
        `UPDATE ${f.prefix}plugin_profile_selections%`,
      );
      assert.notEqual(writerPid, f.metadataPid);
      gate.resume.resolve();
      const [result, changed] = await Promise.all([saving, changing]);
      assert.equal(result.disposition, "committed");
      assert.equal(changed.selection.state, "disabled");
      assert.equal(g.state.fullCalls, 1);
      assert.ok(g.state.transactionCalls >= 1);
      assert.equal((await counts(f)).project_foundation_mutation_receipts, 1);
    } finally {
      gate.resume.resolve();
      observer.release();
    }
  },
);

test(
  "PostgreSQL earlier uninstallation owns the actual row and stale foundation waits then writes nothing",
  optionsFor("postgres"),
  async (t) => {
    const f = await prepare(t, "postgres");
    const g = grant(f);
    const gate = await f.observerPool!.connect();
    await f.execute(
      `CREATE FUNCTION ${f.prefix}foundation_source_gate() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || ':foundation-source-change')); RETURN NEW; END $body$; CREATE TRIGGER foundation_source_gate AFTER UPDATE ON ${f.prefix}plugin_profile_selections FOR EACH ROW EXECUTE FUNCTION ${f.prefix}foundation_source_gate();`,
    );
    let changing: ReturnType<typeof changeSource> | undefined;
    let saving: ReturnType<typeof f.foundation.commitCreation> | undefined;
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${f.schema}:foundation-source-change`,
      ]);
      const gatePid = Number(
        (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid,
      );
      changing = f.track(changeSource(f, "uninstalled"));
      void changing.catch(() => {});
      const writerPid = await waitBlocked(
        gate,
        gatePid,
        `UPDATE ${f.prefix}plugin_profile_selections%`,
      );
      saving = f.track(
        f.foundation.commitCreation(
          foundationCreationRecipe(
            "source-writer-first",
            "source-writer-first-create",
            "novel",
          ),
          { authority: g.authority },
        ),
      );
      void saving.catch(() => {});
      const committingPid = await waitBlocked(
        gate,
        writerPid,
        `%${f.prefix}plugin_profile_selections%FOR SHARE OF s,p`,
      );
      assert.notEqual(committingPid, writerPid);
      await gate.query("COMMIT");
      await changing;
      await assert.rejects(saving, /plugin_installation_pin_conflict/);
      assert.deepEqual(await counts(f), emptyCounts());
    } finally {
      await gate.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([changing, saving]);
      gate.release();
    }
  },
);

test(
  "PostgreSQL confirmed qualified foundation COMMIT survives permission/source/owner withdrawal during its reply",
  optionsFor("postgres"),
  async (t) => {
    const f = await prepare(t, "postgres");
    const g = grant(f);
    const gate = f.arm("commit");
    const saving = f.track(
      f.foundation.commitCreation(
        foundationCreationRecipe(
          "committed-reply",
          "committed-reply-create",
          "novel",
        ),
        { authority: g.authority },
      ),
    );
    void saving.catch(() => {});
    await gate.entered.promise;
    assert.equal((await counts(f)).project_foundation_mutation_receipts, 1);
    g.state.active = false;
    g.state.current = false;
    f.closeOwner();
    await changeSource(f, "uninstalled");
    await f.parent.close();
    gate.resume.resolve();
    const result = await saving;
    assert.equal(result.disposition, "committed");
    assert.equal(result.project.projectId, "committed-reply");
    assert.equal(result.foundation.origin, "novel");
    assert.equal((await counts(f)).project_foundation_mutation_receipts, 1);
  },
);
