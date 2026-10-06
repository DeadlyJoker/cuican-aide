import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import { assetTestOptions } from "./project-asset.test-support.ts";
import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";
import {
  materialPreparationFixture,
  materialPreparationAt as at,
  observeMaterialPreparationSql,
} from "./project-material-preparation.test-support.ts";
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} forged source Run, result proof and origin cannot reserve a preparation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend);
      for (const change of [
        { sourceRunId: "invented-run" },
        { resultLinkDigest: digester.sha256("invented-result") },
        { packageDigest: digester.sha256("invented-source-package") },
        { origin: "https://invented-origin.example/" },
      ]) {
        const r = f.reservation();
        await assert.rejects(
          f.journal.reserve(
            {
              ...r,
              source: {
                ...r.source,
                source: { ...r.source.source, ...change },
              },
            },
            f.authority(),
          ),
          /source_changed/u,
        );
      }
      assert.equal((await f.journalCounts()).project_material_preparations, 0);
    },
  );
  test(
    `${backend} a new default configuration cannot rebind an existing preparation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend),
        first = await f.journal.reserve(f.reservation(), f.authority());
      const { contentDigest: _digest, ...old } = f.target.configuration;
      const next = createExtensionConfiguration(
        {
          ...old,
          revision: 2,
          parameters: {
            ...old.parameters,
            baseUrl: "https://new-default.example/",
          },
        },
        digester,
      );
      await f.first.store.saveExtensionConfiguration({
        configuration: next,
        expectedRevision: 1,
        receipt: {
          actorId: f.actor.actorId,
          idempotencyKey: "new-material-default",
          requestDigest: digester.sha256("new-material-default"),
        },
      });
      assert.deepEqual(
        await f.journal.load(f.request, f.authority()),
        first.state,
      );
      const claimed = await f.journal.claimDispatch(
        { request: f.request, expectedRevision: 1, at },
        f.authority(),
      );
      assert.equal(claimed.disposition, "claimed");
      assert.deepEqual(
        claimed.state.initial.target.configuration,
        f.target.configuration,
      );
      assert.equal(
        claimed.state.initial.transfer.origin,
        "https://target.provider.example:8443/",
      );
    },
  );
  test(
    `${backend} preparation migration is explicit, independent and repeatable`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend, {
          migrate: false,
        }),
        before = await f.rows();
      await assert.rejects(
        f.journal.load(f.request, f.authority()),
        /schema_invalid/u,
      );
      await f.journal.migrate();
      await f.journal.migrate();
      assert.equal(await f.journal.load(f.request, f.authority()), null);
      assert.deepEqual(await f.rows(), before);
      assert.deepEqual(await f.journalCounts(), {
        project_material_preparations: 0,
        project_material_preparation_events: 0,
        project_material_preparation_heads: 0,
      });
    },
  );
  test(
    `${backend} original preparation fixes source, package, config and path without a Run or funds`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend),
        before = await f.rows(),
        first = await f.journal.reserve(f.reservation(), f.authority());
      assert.equal(first.disposition, "created");
      assert.equal(first.state.event.phase, "reserved");
      assert.deepEqual(first.state.initial.source, f.frozen);
      assert.deepEqual(first.state.initial.target, f.target);
      assert.equal(
        first.state.initial.transfer.origin,
        "https://target.provider.example:8443/",
      );
      assert.equal(
        first.state.initial.transfer.output.subfolder,
        `crewon-materials/${first.state.initial.transfer.preparationId}`,
      );
      const replay = await f.journal.reserve(f.reservation(), f.authority());
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.state, first.state);
      assert.deepEqual(await f.rows(), before);
      assert.deepEqual(await f.journalCounts(), {
        project_material_preparations: 1,
        project_material_preparation_events: 1,
        project_material_preparation_heads: 1,
      });
    },
  );
  test(
    `${backend} two instances reserve one path and claim dispatch exactly once`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend),
        other = await f.openJournal();
      const reservations = await Promise.all([
        f.journal.reserve(f.reservation(), f.authority()),
        other.journal.reserve(f.reservation(), f.authority()),
      ]);
      assert.equal(
        reservations.filter((r) => r.disposition === "created").length,
        1,
      );
      assert.deepEqual(reservations[0]!.state, reservations[1]!.state);
      const claims = await Promise.all([
        f.journal.claimDispatch(
          { request: f.request, expectedRevision: 1, at },
          f.authority(),
        ),
        other.journal.claimDispatch(
          { request: f.request, expectedRevision: 1, at },
          f.authority(),
        ),
      ]);
      assert.equal(claims.filter((r) => r.disposition === "claimed").length, 1);
      assert.deepEqual(claims[0]!.state, claims[1]!.state);
      assert.equal(claims[0]!.state.event.phase, "dispatching");
      assert.equal(claims[0]!.state.event.revision, 2);
    },
  );
  test(
    `${backend} lost dispatch receipt remains query-only after all parent handles close`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend);
      await f.journal.reserve(f.reservation(), f.authority());
      const claim = await f.journal.claimDispatch(
        { request: f.request, expectedRevision: 1, at },
        f.authority(),
      );
      await f.first.parent.close();
      await f.second.parent.close();
      const cold = await f.openJournal(),
        recovered = await cold.journal.claimDispatch(
          { request: f.request, expectedRevision: 1, at },
          f.authority(),
        );
      assert.equal(recovered.disposition, "existing");
      assert.deepEqual(recovered.state, claim.state);
      const unknown = await cold.journal.advance(
        {
          request: f.request,
          expectedRevision: 2,
          phase: "unknownOutcome",
          observation: null,
          failureCode: "upload_reply_missing",
          at,
        },
        f.authority(),
      );
      assert.equal(unknown.event.revision, 3);
      await cold.parent.close();
      const again = await f.openJournal(),
        retry = await again.journal.claimDispatch(
          { request: f.request, expectedRevision: 1, at },
          f.authority(),
        );
      assert.equal(retry.disposition, "existing");
      assert.deepEqual(retry.state, unknown);
      assert.equal(
        (await again.journal.reserve(f.reservation(), f.authority()))
          .disposition,
        "replayed",
      );
      assert.deepEqual(await f.journalCounts(), {
        project_material_preparations: 1,
        project_material_preparation_events: 3,
        project_material_preparation_heads: 1,
      });
    },
  );
  test(
    `${backend} only matching target byte observation can resolve an unknown original request`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend);
      await f.journal.reserve(f.reservation(), f.authority());
      await f.journal.claimDispatch(
        { request: f.request, expectedRevision: 1, at },
        f.authority(),
      );
      await f.journal.advance(
        {
          request: f.request,
          expectedRevision: 2,
          phase: "unknownOutcome",
          observation: null,
          failureCode: "network_timeout",
          at,
        },
        f.authority(),
      );
      const source = f.frozen.source,
        observation = {
          byteDigest: source.byteDigest,
          byteLength: source.byteLength,
          width: source.width,
          height: source.height,
          checkedAt: at,
        };
      for (const wrong of [
        { ...observation, byteDigest: digester.sha256("wrong") },
        { ...observation, byteLength: 513 },
        { ...observation, width: 3 },
        { ...observation, checkedAt: "2026-10-07T08:00:00.000Z" },
        null,
      ])
        await assert.rejects(
          f.journal.advance(
            {
              request: f.request,
              expectedRevision: 3,
              phase: "verified",
              observation: wrong,
              failureCode: null,
              at,
            },
            f.authority(),
          ),
        );
      const verified = await f.journal.advance(
        {
          request: f.request,
          expectedRevision: 3,
          phase: "verified",
          observation,
          failureCode: null,
          at,
        },
        f.authority(),
      );
      assert.equal(verified.event.phase, "verified");
      assert.equal(verified.event.revision, 4);
      assert.deepEqual(
        await f.journal.load(f.request, f.authority()),
        verified,
      );
      assert.equal(
        (
          await f.journal.claimDispatch(
            { request: f.request, expectedRevision: 1, at },
            f.authority(),
          )
        ).disposition,
        "existing",
      );
      await assert.rejects(
        f.journal.advance(
          {
            request: f.request,
            expectedRevision: 4,
            phase: "rejected",
            observation: null,
            failureCode: "retry",
            at,
          },
          f.authority(),
        ),
        /transition_invalid/u,
      );
    },
  );
  test(
    `${backend} state, revision and time guards reject unclaimed or stale updates`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend);
      await f.journal.reserve(f.reservation(), f.authority());
      await assert.rejects(
        f.journal.advance(
          {
            request: f.request,
            expectedRevision: 1,
            phase: "unknownOutcome",
            observation: null,
            failureCode: "not_sent",
            at,
          },
          f.authority(),
        ),
        /transition_invalid/u,
      );
      await assert.rejects(
        f.journal.claimDispatch(
          { request: f.request, expectedRevision: 2, at },
          f.authority(),
        ),
        /revision_conflict/u,
      );
      await assert.rejects(
        f.journal.claimDispatch(
          {
            request: f.request,
            expectedRevision: 1,
            at: "2026-10-05T08:00:00.000Z",
          },
          f.authority(),
        ),
        /transition_invalid/u,
      );
      await f.journal.claimDispatch(
        { request: f.request, expectedRevision: 1, at },
        f.authority(),
      );
      await assert.rejects(
        f.journal.advance(
          {
            request: f.request,
            expectedRevision: 1,
            phase: "rejected",
            observation: null,
            failureCode: "wrong_revision",
            at,
          },
          f.authority(),
        ),
        /revision_conflict/u,
      );
      const rejected = await f.journal.advance(
        {
          request: f.request,
          expectedRevision: 2,
          phase: "rejected",
          observation: null,
          failureCode: "target_identity_changed",
          at,
        },
        f.authority(),
      );
      assert.equal(
        (
          await f.journal.claimDispatch(
            { request: f.request, expectedRevision: 1, at },
            f.authority(),
          )
        ).disposition,
        "existing",
      );
      await assert.rejects(
        f.journal.advance(
          {
            request: f.request,
            expectedRevision: rejected.event.revision,
            phase: "unknownOutcome",
            observation: null,
            failureCode: "retry",
            at,
          },
          f.authority(),
        ),
        /transition_invalid/u,
      );
    },
  );
  test(
    `${backend} changed request under the original key and changed source bytes cannot replace it`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend),
        first = await f.journal.reserve(f.reservation(), f.authority());
      const changed = {
        ...f.request,
        target: { ...f.request.target, configurationRevision: 2 },
      };
      await assert.rejects(
        f.journal.load(changed, f.authority(changed)),
        /idempotency_conflict/u,
      );
      await assert.rejects(
        f.journal.reserve(
          {
            ...f.reservation(),
            source: {
              ...f.frozen,
              source: {
                ...f.frozen.source,
                byteDigest: digester.sha256("replacement"),
              },
            },
          },
          f.authority(),
        ),
        /idempotency_conflict/u,
      );
      assert.deepEqual(
        await f.journal.load(f.request, f.authority()),
        first.state,
      );
    },
  );
  test(
    `${backend} the supplier preparation ID cannot be reused by a different business request`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend),
        first = await f.journal.reserve(f.reservation(), f.authority());
      const request = { ...f.request, idempotencyKey: "prepare-other" };
      await assert.rejects(
        f.journal.reserve(
          {
            ...f.reservation(request),
            proposedTransfer: {
              preparationId: first.state.initial.transfer.preparationId,
              requestDigest: first.state.initial.transfer.requestDigest,
            },
          },
          f.authority(request),
        ),
        /transfer_identity_conflict/u,
      );
      assert.equal((await f.journalCounts()).project_material_preparations, 1);
    },
  );
  test(
    `${backend} actual owner, active project and adopted source are required even for cold reads`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend);
      await f.journal.reserve(f.reservation(), f.authority());
      const stranger = {
        ...f.request,
        source: {
          ...f.request.source,
          actor: { ...f.actor, principalId: "different-principal" },
        },
      };
      await assert.rejects(f.journal.load(stranger, f.authority(stranger)));
      await f.assets.setLocked(f.actor, {
        projectId: f.query.projectId,
        assetId: f.query.assetId,
        expectedAssetRevision: 4,
        locked: true,
        idempotencyKey: "changed-adopted-head",
      });
      await assert.rejects(
        f.journal.load(f.request, f.authority()),
        /reference_image_changed/u,
      );
      await assert.rejects(
        f.journal.claimDispatch(
          { request: f.request, expectedRevision: 1, at },
          f.authority(),
        ),
        /reference_image_changed/u,
      );
      assert.equal(
        (await f.journalCounts()).project_material_preparation_events,
        1,
      );
      const other = await materialPreparationFixture(t, backend),
        created = await other.journal.reserve(
          other.reservation(),
          other.authority(),
        );
      const project = await other.projects.getProject(other.actor, {
        projectId: other.query.projectId,
      });
      assert.ok(project);
      await other.projects.setProjectState(other.actor, {
        projectId: project.projectId,
        expectedProjectRevision: project.revision,
        state: "archived",
        idempotencyKey: "archive-prepared-project",
      });
      await assert.rejects(
        other.journal.load(other.request, other.authority()),
        /project_archived/u,
      );
      assert.equal(created.state.event.phase, "reserved");
    },
  );
  test(
    `${backend} disabled installation, changed actual config and missing source verifier refuse dispatch`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend);
      await f.journal.reserve(f.reservation(), f.authority());
      const noVerifier = f.first.parent
        .projectAssetStore()
        .projectMaterialPreparationStore();
      await assert.rejects(
        noVerifier.load(f.request, f.authority()),
        /verifier/u,
      );
      await f.installs.commitSelection({ ...selectionForDisabled(f) });
      await assert.rejects(
        f.journal.claimDispatch(
          { request: f.request, expectedRevision: 1, at },
          f.authority(),
        ),
      );
      assert.equal(
        (await f.journalCounts()).project_material_preparation_events,
        1,
      );
      const c = await materialPreparationFixture(t, backend);
      await c.journal.reserve(c.reservation(), c.authority());
      await c.sql(
        `UPDATE ${c.prefix}extension_configurations SET configuration_json=${quote(JSON.stringify({ ...c.target.configuration, parameters: { baseUrl: "https://different.example/" } }))} WHERE plugin_id='crewon.short-drama'`,
      );
      await assert.rejects(
        c.journal.load(c.request, c.authority()),
        /configuration/u,
      );
    },
  );
  test(
    `${backend} independent preparation permission and actor binding are mandatory`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend);
      for (const old of [
        undefined,
        {
          assertCurrent: async () => {},
          assertTransactionCurrent: async () => {},
          assertActive() {},
        },
        { ...f.authority(), version: "crewon.project-asset-plugin-commit.v1" },
        {
          ...f.authority(),
          request: { ...f.request, idempotencyKey: "wrong" },
        },
      ])
        await assert.rejects(f.journal.reserve(f.reservation(), old as never));
      f.state.allow = false;
      await assert.rejects(
        f.journal.reserve(f.reservation(), f.authority()),
        /pdp_denied/u,
      );
      assert.equal((await f.journalCounts()).project_material_preparations, 0);
      f.state.allow = true;
      f.state.transaction = async () => {
        f.state.allow = false;
      };
      await assert.rejects(
        f.journal.reserve(f.reservation(), f.authority()),
        /pdp_denied/u,
      );
      assert.equal((await f.journalCounts()).project_material_preparations, 0);
    },
  );
  test(
    `${backend} retiring the owner after actual SQL insertion rolls back the complete preparation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend),
        before = await f.rows();
      const restore = observeMaterialPreparationSql(
        backend,
        /INSERT INTO .*project_material_preparations\(/u,
        () => {
          f.state.active = false;
        },
      );
      try {
        await assert.rejects(
          f.journal.reserve(f.reservation(), f.authority()),
          /owner_retired/u,
        );
      } finally {
        restore();
      }
      assert.deepEqual(await f.journalCounts(), {
        project_material_preparations: 0,
        project_material_preparation_events: 0,
        project_material_preparation_heads: 0,
      });
      assert.deepEqual(await f.rows(), before);
    },
  );
  test(
    `${backend} initial snapshots and state history are immutable in the physical database`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend),
        first = await f.journal.reserve(f.reservation(), f.authority());
      for (const sql of [
        `UPDATE ${f.prefix}project_material_preparations SET request_digest='fake'`,
        `DELETE FROM ${f.prefix}project_material_preparations`,
        `UPDATE ${f.prefix}project_material_preparation_events SET phase='verified'`,
        `DELETE FROM ${f.prefix}project_material_preparation_events`,
        `DELETE FROM ${f.prefix}project_material_preparation_heads`,
        `UPDATE ${f.prefix}project_material_preparation_heads SET revision=2,phase='verified'`,
        `DELETE FROM ${f.prefix}project_material_preparation_schema_version`,
      ])
        await assert.rejects(f.sql(sql));
      assert.deepEqual(
        await f.journal.load(f.request, f.authority()),
        first.state,
      );
      const missing = await materialPreparationFixture(t, backend);
      await missing.sql(
        `DROP TABLE ${missing.prefix}project_material_preparation_schema_version`,
      );
      await assert.rejects(missing.journal.migrate(), /schema_invalid/u);
      await assert.rejects(
        missing.journal.load(missing.request, missing.authority()),
        /schema_invalid/u,
      );
    },
  );
  test(
    `${backend} accessors/proxies and mutable recipes cannot change the captured request`,
    assetTestOptions(backend),
    async (t) => {
      const f = await materialPreparationFixture(t, backend);
      let evaluated = 0;
      const r = f.reservation(),
        getter = {
          ...r,
          get at() {
            evaluated++;
            return at;
          },
        };
      await assert.rejects(f.journal.reserve(getter, f.authority()));
      await assert.rejects(
        f.journal.reserve(
          new Proxy(r, {
            ownKeys() {
              evaluated++;
              return [];
            },
          }),
          f.authority(),
        ),
      );
      await assert.rejects(
        f.journal.reserve(r, {
          ...f.authority(),
          get assertCurrent() {
            evaluated++;
            return async () => {};
          },
        }),
      );
      await assert.rejects(
        f.journal.reserve(
          {
            ...r,
            source: new Proxy(r.source, {
              getPrototypeOf() {
                evaluated++;
                throw new Error("must_not_execute");
              },
            }),
          },
          f.authority(),
        ),
      );
      await assert.rejects(
        f.journal.reserve(
          {
            ...r,
            target: {
              ...r.target,
              installation: new Proxy(r.target.installation, {
                ownKeys() {
                  evaluated++;
                  return [];
                },
              }),
            },
          },
          f.authority(),
        ),
      );
      await assert.rejects(
        f.journal.reserve(
          {
            ...r,
            target: {
              ...r.target,
              configuration: {
                ...r.target.configuration,
                parameters: {
                  get baseUrl() {
                    evaluated++;
                    return "https://fake.example/";
                  },
                },
              },
            },
          },
          f.authority(),
        ),
      );
      assert.equal(evaluated, 0);
      const mutable = f.reservation();
      f.state.before = async () => {
        (mutable as { at: string }).at = "2027-01-01T00:00:00.000Z";
        (mutable.proposedTransfer as { preparationId: string }).preparationId =
          "invalid";
      };
      const saved = await f.journal.reserve(mutable, f.authority());
      assert.equal(saved.state.initial.createdAt, at);
      assert.notEqual(saved.state.initial.transfer.preparationId, "invalid");
    },
  );
}
function selectionForDisabled(
  f: Awaited<ReturnType<typeof materialPreparationFixture>>,
) {
  return {
    scope: {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      profileId: f.target.installation.profileId,
    },
    actor: f.actor,
    receipt: {
      idempotencyKey: "disable-target",
      requestDigest: digester.sha256("disable-target"),
    },
    expectedSelectionRevision: f.enabled.selection.revision,
    selection: {
      ...f.enabled.selection,
      revision: f.enabled.selection.revision + 1,
      state: "disabled" as const,
      updatedAt: at,
      updatedByPrincipalId: f.actor.principalId,
      updatedByActorId: f.actor.actorId,
    },
  };
}
