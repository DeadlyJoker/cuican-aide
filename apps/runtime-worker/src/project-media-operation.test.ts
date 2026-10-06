import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  PROJECT_MEDIA_OPERATION_VERSION,
  parseProjectMediaOperationLink,
  mediaInputDigest,
} from "@crewon/application";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import {
  mediaOperationFixture as fixture,
  observeMediaOperationInsert,
} from "./project-media-operation.test-support.ts";
import { initialExternalOperation } from "../../../packages/store/src/external-operation-record.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind} exact candidate has one original operation across different Tool keys`,
      assetTestOptions(backend),
      async (t) => {
        const f = await fixture(t, backend, { kind }),
          before = await f.counts(),
          io = [f.state.sourceGets, f.state.targetGets, f.state.uploads];
        assert.equal(
          await f.operations.loadProjectMediaOperation(f.scope),
          null,
        );
        const result = await f.operations.reserveExternalOperation(f.operation);
        assert.equal(result.disposition, "created");
        const replay = await f.operations.reserveExternalOperation({
          ...f.operation,
          operationId: randomUUID(),
          correlationId: randomUUID(),
        });
        assert.equal(replay.disposition, "existing");
        assert.deepEqual(replay.operation, result.operation);
        await assert.rejects(
          f.operations.reserveExternalOperation(f.second()),
          /project_media_operation_occupied/,
        );
        const state = await f.operations.loadProjectMediaOperation(f.scope);
        assert.ok(state);
        assert.equal(state.link.schemaVersion, PROJECT_MEDIA_OPERATION_VERSION);
        assert.equal(state.link.executionId, f.task.reference.executionId);
        assert.equal(
          state.link.reservation.executionId,
          f.operation.executionId,
        );
        assert.deepEqual(state.operation, result.operation);
        assert.deepEqual(await f.counts(), {
          slots: before.slots + 1,
          operations: before.operations + 1,
        });
        assert.deepEqual(
          [f.state.sourceGets, f.state.targetGets, f.state.uploads],
          io,
        );
        await assert.rejects(
          f.sql(
            `UPDATE ${f.prefix}project_media_operations SET execution_id='other'`,
          ),
          /immutable/,
        );
        await assert.rejects(
          f.sql(`DELETE FROM ${f.prefix}project_media_operations`),
          /immutable/,
        );
        await assert.rejects(
          f.operations.loadProjectMediaOperation({
            ...f.scope,
            bindingDigest: f.digester.sha256("other"),
          }),
          /history_invalid/,
        );
      },
    );
  test(
    `${backend} same-key races replay once and distinct-key races occupy once`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.counts();
      const races = await Promise.all([
        f.operations.reserveExternalOperation(f.operation),
        f.operations.reserveExternalOperation(f.operation),
      ]);
      assert.deepEqual(races.map((r) => r.disposition).sort(), [
        "created",
        "existing",
      ]);
      const alternative = f.operations;
      const next = await Promise.allSettled([
        alternative.reserveExternalOperation(f.second()),
        alternative.reserveExternalOperation(f.second()),
      ]);
      assert.ok(
        next.every(
          (r) => r.status === "rejected" && /occupied/.test(String(r.reason)),
        ),
      );
      assert.deepEqual(await f.counts(), {
        slots: before.slots + 1,
        operations: before.operations + 1,
      });
    },
  );
  test(
    `${backend} distinct first Tool reservations race to one candidate slot`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.counts(),
        other = f.second();
      const results = await Promise.allSettled([
        f.operations.reserveExternalOperation(f.operation),
        f.operations.reserveExternalOperation(other),
      ]);
      assert.equal(
        results.filter(
          (r) => r.status === "fulfilled" && r.value.disposition === "created",
        ).length,
        1,
      );
      assert.equal(
        results.filter(
          (r) => r.status === "rejected" && /occupied/.test(String(r.reason)),
        ).length,
        1,
      );
      assert.deepEqual(await f.counts(), {
        slots: before.slots + 1,
        operations: before.operations + 1,
      });
    },
  );
  test(
    `${backend} cold explicit owner reads original unknown outcome after source changes without bytes or dispatch`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        initial = await f.operations.reserveExternalOperation(f.operation);
      const updated = await f.operations.advanceExternalOperation({
        ...f.scope,
        operationId: initial.operation.operationId,
        expectedRevision: 1,
        status: "unknownOutcome",
        providerOperationId: null,
        resultJson: null,
        updatedAt: new Date(
          Date.parse(initial.operation.createdAt) + 1,
        ).toISOString(),
      });
      assert.equal(updated.disposition, "updated");
      await f.assets.setLocked(f.actor, {
        projectId: f.query.projectId,
        assetId: f.query.assetId,
        expectedAssetRevision: 4,
        locked: true,
        idempotencyKey: "changed-source-head",
      });
      const cold = await f.cold(),
        ops = cold.parent.externalOperationStore(),
        before = await f.counts(),
        io = [f.state.sourceGets, f.state.targetGets, f.state.uploads];
      assert.equal(ops.projectMediaOperationsVersion, undefined);
      await assert.rejects(
        ops.loadProjectMediaOperation(f.scope),
        /unavailable/,
      );
      await assert.rejects(
        ops.reserveExternalOperation(f.operation),
        /unavailable/,
      );
      await ops.migrateProjectMediaOperations();
      assert.equal(
        ops.projectMediaOperationsVersion,
        PROJECT_MEDIA_OPERATION_VERSION,
      );
      assert.deepEqual(
        (await ops.loadProjectMediaOperation(f.scope))?.operation,
        updated.operation,
      );
      assert.deepEqual(
        (await ops.reserveExternalOperation(f.operation)).operation,
        updated.operation,
      );
      await assert.rejects(
        ops.reserveExternalOperation(f.second()),
        /occupied/,
      );
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(
        [f.state.sourceGets, f.state.targetGets, f.state.uploads],
        io,
      );
    },
  );
  test(
    `${backend} paid candidate retains original hold and cancellation checks, then observes existing slot`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, { paid: true }),
        before = await f.counts();
      const held = await f.count("plugin_credit_reservations");
      assert.equal(
        (await f.operations.reserveExternalOperation(f.operation)).disposition,
        "created",
      );
      assert.equal(await f.count("plugin_credit_reservations"), held);
      await f.transition("run.cancel.requested", { actorId: f.actor.actorId });
      assert.equal(
        (await f.operations.reserveExternalOperation(f.operation)).disposition,
        "existing",
      );
      assert.ok(await f.operations.loadProjectMediaOperation(f.scope));
      await assert.rejects(
        f.operations.reserveExternalOperation(f.second()),
        /dispatch_denied/,
      );
      assert.deepEqual(await f.counts(), {
        slots: before.slots + 1,
        operations: before.operations + 1,
      });
    },
  );
  test(
    `${backend} queued candidate and unmetered cancellation cannot reserve a supplier operation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, { start: false }),
        before = await f.counts();
      await assert.rejects(
        f.operations.reserveExternalOperation(f.operation),
        /dispatch_denied/,
      );
      assert.deepEqual(await f.counts(), before);
      await f.transition("run.started", {});
      await f.transition("run.cancel.requested", { actorId: f.actor.actorId });
      await assert.rejects(
        f.operations.reserveExternalOperation(f.operation),
        /dispatch_denied/,
      );
      assert.deepEqual(await f.counts(), before);
    },
  );
  test(
    `${backend} last physical slot insertion then owner retirement rolls both original operation and slot back`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.counts();
      const restore = observeMediaOperationInsert(backend, () => f.retire());
      t.after(restore);
      await assert.rejects(
        f.operations.reserveExternalOperation(f.operation),
        /named_media_operation_owner_retired/,
      );
      restore();
      assert.deepEqual(await f.counts(), before);
      const cold = await f.cold(),
        ops = cold.parent.externalOperationStore();
      await ops.migrateProjectMediaOperations();
      assert.equal(await ops.loadProjectMediaOperation(f.scope), null);
      assert.equal(
        (await ops.reserveExternalOperation(f.operation)).disposition,
        "created",
      );
    },
  );
  test(
    `${backend} canceled unmetered media Run keeps the original operation observable and denies new claims`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        reserved = await f.operations.reserveExternalOperation(f.operation),
        before = await f.counts();
      await f.transition("run.cancel.requested", { actorId: f.actor.actorId });
      await f.transition("run.canceled", { reasonCode: "named-test-cancel" });
      assert.deepEqual(
        (await f.operations.reserveExternalOperation(f.operation)).operation,
        reserved.operation,
      );
      assert.deepEqual(
        (await f.operations.loadProjectMediaOperation(f.scope))?.operation,
        reserved.operation,
      );
      await assert.rejects(
        f.operations.reserveExternalOperation(f.second()),
        /dispatch_denied/,
      );
      assert.deepEqual(await f.counts(), before);
    },
  );
  test(
    `${backend} altered original immutable operation cannot be repaired into replay`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        reserved = await f.operations.reserveExternalOperation(f.operation),
        original = reserved.operation;
      const changed = { ...original, correlationId: randomUUID() };
      const literal = JSON.stringify(changed).replaceAll("'", "''");
      await f.sql(
        `UPDATE ${f.prefix}extension_external_operations SET record_json='${literal}' WHERE operation_id='${original.operationId}'`,
      );
      await assert.rejects(
        f.operations.loadProjectMediaOperation(f.scope),
        /history_invalid/,
      );
      await assert.rejects(
        f.operations.reserveExternalOperation(f.operation),
        /history_invalid/,
      );
    },
  );
  test(
    `${backend} missing candidate slot with an orphan original operation fails closed without a second reservation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        original = initialExternalOperation(f.operation);
      // Named corrupt historical fixture only; normal reservation must write both records atomically.
      const literal = JSON.stringify(original).replaceAll("'", "''");
      await f.sql(
        `INSERT INTO ${f.prefix}extension_external_operations (tenant_id,run_id,binding_digest,operation_id,idempotency_key,revision,record_json) VALUES ('${original.tenantId}','${original.runId}','${original.bindingDigest}','${original.operationId}','${original.idempotencyKey}',1,'${literal}')`,
      );
      const before = await f.counts();
      await assert.rejects(
        f.operations.loadProjectMediaOperation(f.scope),
        /history_invalid/,
      );
      await assert.rejects(
        f.operations.reserveExternalOperation(f.operation),
        /history_invalid/,
      );
      await assert.rejects(
        f.operations.reserveExternalOperation(f.second()),
        /history_invalid/,
      );
      assert.deepEqual(await f.counts(), before);
    },
  );
  test(
    `${backend} losing the owned schema cannot downgrade an enabled media owner to generic operation behavior`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.counts();
      await f.sql(
        `DROP TABLE ${f.prefix}project_media_operation_schema_version`,
      );
      await assert.rejects(
        f.operations.loadProjectMediaOperation(f.scope),
        /schema_invalid/,
      );
      await assert.rejects(
        f.operations.reserveExternalOperation(f.operation),
        /schema_invalid/,
      );
      const cold = await f.cold(),
        ops = cold.parent.externalOperationStore();
      await assert.rejects(
        ops.migrateProjectMediaOperations(),
        /schema_invalid/,
      );
      assert.equal(ops.projectMediaOperationsVersion, undefined);
      await assert.rejects(
        ops.reserveExternalOperation(f.operation),
        /unavailable/,
      );
      assert.deepEqual(await f.counts(), before);
    },
  );
  test(
    `${backend} media operation reads reject accessors and extra scope authority without invoking them`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      let called = 0;
      await assert.rejects(
        f.operations.loadProjectMediaOperation({
          ...f.scope,
          get bindingDigest() {
            called++;
            return f.scope.bindingDigest;
          },
        }),
      );
      assert.equal(called, 0);
      await assert.rejects(
        f.operations.loadProjectMediaOperation({
          ...f.scope,
          grant: true,
        } as never),
      );
      assert.equal(await f.count("project_media_operations"), 0);
    },
  );
  test(
    `${backend} slot parser rejects forged digest and candidate aliases`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.operations.reserveExternalOperation(f.operation);
      const state = await f.operations.loadProjectMediaOperation(f.scope);
      assert.ok(state);
      assert.throws(
        () =>
          parseProjectMediaOperationLink({
            ...state.link,
            executionId: "other",
          }),
        /record_invalid/,
      );
      const { contentDigest, ...body } = state.link;
      assert.throws(
        () =>
          parseProjectMediaOperationLink({
            ...body,
            reservation: { ...body.reservation, runId: "other" },
            contentDigest: mediaInputDigest({
              ...body,
              reservation: { ...body.reservation, runId: "other" },
            }),
          }),
        /record_invalid/,
      );
      assert.ok(contentDigest);
    },
  );
}
