import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import type {
  DomainStore,
  OfficeThreadBinding,
  CommitThreadInput,
} from "@crewon/application";
import type { OfficeDefinition } from "@crewon/domain";
import {
  appendMessageCommit,
  createThreadCommitFixture,
  emptyForkCommit,
} from "./thread-store-conformance.test-support.ts";

export const officeDefinition: OfficeDefinition = {
  schemaVersion: "crewon.office-definition.v0",
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  revision: 1,
  title: "Delivery",
  members: [
    {
      memberId: "member-1",
      displayName: "Delivery agent",
      agentVersionId: "agent-version-1",
    },
  ],
  executionTargets: [
    { targetId: "primary", agentVersionId: "agent-version-1" },
  ],
  createdByActorId: "actor-1",
  createdAt: "2026-08-08T00:00:00Z",
};
export const officeBinding: OfficeThreadBinding = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  threadId: "thread-1",
  boundByActorId: "actor-1",
  boundAt: "2026-08-08T00:00:00Z",
};
export async function seedOffice(
  store: Pick<DomainStore, "commitOfficeDefinition">,
  definition = officeDefinition,
): Promise<void> {
  await store.commitOfficeDefinition({
    definition,
    expectedRevision: definition.revision - 1,
    receipt: {
      actorId: definition.createdByActorId,
      idempotencyKey: `create:${definition.officeVersionId}`,
      requestDigest: `digest:${definition.officeVersionId}`,
    },
  });
}
export function createOfficeThread(binding = officeBinding): CommitThreadInput {
  return {
    ...createThreadCommitFixture({
      tenantId: binding.tenantId,
      spaceId: binding.spaceId,
      threadId: binding.threadId,
      actorId: binding.boundByActorId,
      occurredAt: binding.boundAt,
    }),
    officeBinding: binding,
  };
}

export function registerOfficeThreadConformance(
  name: string,
  factory: (context: TestContext) => DomainStore | Promise<DomainStore>,
): void {
  describe(name, () => {
    test("commits the unique Office association with a Thread and replays even with a regenerated candidate ID", async (t) => {
      const store = await factory(t);
      await seedOffice(store);
      const input = createOfficeThread();
      const committed = await store.commitThread(input);
      assert.deepEqual(
        await store.loadOfficeThreadBinding(officeBinding),
        officeBinding,
      );
      const retry = createOfficeThread({
        ...officeBinding,
        threadId: "thread-retry",
      });
      assert.deepEqual(
        await store.commitThread({ ...retry, idempotency: input.idempotency }),
        { ...committed, disposition: "replayed" },
      );
      assert.equal(
        await store.loadThread({
          tenantId: "tenant-1",
          threadId: "thread-retry",
        }),
        null,
      );
    });

    test("racing candidates leave one binding and one Thread, with no losing events or history", async (t) => {
      const store = await factory(t);
      await seedOffice(store);
      const results = await Promise.allSettled([
        store.commitThread(createOfficeThread()),
        store.commitThread(
          createOfficeThread({ ...officeBinding, threadId: "thread-2" }),
        ),
      ]);
      assert.equal(
        results.filter((value) => value.status === "fulfilled").length,
        1,
      );
      const loser = results.find((value) => value.status === "rejected");
      assert.equal(
        loser?.status === "rejected" && loser.reason.code,
        "office_thread_already_bound",
      );
      const binding = (await store.loadOfficeThreadBinding(officeBinding))!;
      const losingId =
        binding.threadId === "thread-1" ? "thread-2" : "thread-1";
      assert.equal(
        await store.loadThread({ tenantId: "tenant-1", threadId: losingId }),
        null,
      );
      assert.deepEqual(
        await store.listThreadEvents(
          { tenantId: "tenant-1", threadId: losingId },
          0,
          10,
        ),
        [],
      );
      assert.deepEqual(
        await store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: losingId },
          0,
          10,
        ),
        [],
      );
    });

    test("adopts existing history with revision CAS without changing any Thread events or model history", async (t) => {
      const store = await factory(t);
      await seedOffice(store);
      await store.commitThread(createThreadCommitFixture());
      const appended = await store.commitThread(appendMessageCommit(1, 2));
      const events = await store.listThreadEvents(
        { tenantId: "tenant-1", threadId: "thread-1" },
        0,
        100,
      );
      const input = { binding: officeBinding, expectedThreadRevision: 2 };
      await assert.rejects(
        store.bindOfficeThread({ ...input, expectedThreadRevision: 1 }),
        { code: "revision_conflict" },
      );
      assert.equal(await store.loadOfficeThreadBinding(officeBinding), null);
      assert.deepEqual(await store.bindOfficeThread(input), {
        disposition: "bound",
        binding: officeBinding,
      });
      assert.deepEqual(
        await store.bindOfficeThread({
          ...input,
          expectedThreadRevision: 99,
          binding: { ...officeBinding, boundByActorId: "actor-2" },
        }),
        { disposition: "existing", binding: officeBinding },
      );
      assert.deepEqual(
        await store.loadThread({ tenantId: "tenant-1", threadId: "thread-1" }),
        appended.state,
      );
      assert.deepEqual(
        await store.listThreadEvents(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          100,
        ),
        events,
      );
      assert.deepEqual(
        await store.listModelHistoryItems(
          { tenantId: "tenant-1", threadId: "thread-1" },
          0,
          100,
        ),
        appended.historyItems,
      );
    });

    test("cannot claim one Thread for two Offices or replace an existing Office binding", async (t) => {
      const store = await factory(t);
      await seedOffice(store);
      await seedOffice(store, {
        ...officeDefinition,
        officeId: "office-2",
        officeVersionId: "office-version-2",
      });
      await store.commitThread(createOfficeThread());
      await store.commitThread(
        createThreadCommitFixture({ threadId: "thread-2" }),
      );
      await assert.rejects(
        store.bindOfficeThread({
          binding: {
            ...officeBinding,
            officeId: "office-2",
            officeVersionId: "office-version-2",
          },
          expectedThreadRevision: 1,
        }),
        { code: "office_thread_already_claimed" },
      );
      await assert.rejects(
        store.bindOfficeThread({
          binding: { ...officeBinding, threadId: "thread-2" },
          expectedThreadRevision: 1,
        }),
        { code: "office_thread_already_bound" },
      );
      assert.deepEqual(
        await store.loadOfficeThreadBinding(officeBinding),
        officeBinding,
      );
    });

    test("keeps the stable association across Office revisions and rejects creating a replacement", async (t) => {
      const store = await factory(t);
      await seedOffice(store);
      await store.commitThread(createOfficeThread());
      await seedOffice(store, {
        ...officeDefinition,
        officeVersionId: "office-version-next",
        revision: 2,
        title: "Renamed Office",
      });
      const next = { ...officeBinding, officeVersionId: "office-version-next" };
      assert.deepEqual(
        await store.bindOfficeThread({
          binding: next,
          expectedThreadRevision: 1,
        }),
        { disposition: "existing", binding: officeBinding },
      );
      await assert.rejects(
        store.commitThread(
          createOfficeThread({ ...next, threadId: "thread-new" }),
        ),
        { code: "office_thread_already_bound" },
      );
      assert.equal(
        await store.loadThread({
          tenantId: "tenant-1",
          threadId: "thread-new",
        }),
        null,
      );
    });

    test("scopes lookups and creation to the matching tenant, space and Office version", async (t) => {
      const store = await factory(t);
      await seedOffice(store);
      for (const change of [
        { tenantId: "tenant-2" },
        { spaceId: "space-2" },
        { officeVersionId: "missing" },
      ]) {
        const binding = { ...officeBinding, ...change };
        assert.equal(await store.loadOfficeThreadBinding(binding), null);
        await assert.rejects(store.commitThread(createOfficeThread(binding)), {
          code: "office_thread_office_not_found",
        });
        assert.equal(
          await store.loadThread({
            tenantId: binding.tenantId,
            threadId: binding.threadId,
          }),
          null,
        );
      }
      await assert.rejects(
        store.commitThread(
          createOfficeThread({ ...officeBinding, officeId: "wrong-office" }),
        ),
        { code: "office_thread_office_mismatch" },
      );
      assert.equal(await store.loadOfficeThreadBinding(officeBinding), null);
    });

    test("rejects cross-space adoption without recording an association", async (t) => {
      const store = await factory(t);
      await seedOffice(store);
      await store.commitThread(
        createThreadCommitFixture({ spaceId: "space-2" }),
      );
      await assert.rejects(
        store.bindOfficeThread({
          binding: officeBinding,
          expectedThreadRevision: 1,
        }),
        { code: "office_thread_not_found" },
      );
      assert.equal(await store.loadOfficeThreadBinding(officeBinding), null);
    });

    for (const status of ["archived", "deleted", "fork"] as const) {
      test(`does not adopt a ${status} Thread`, async (t) => {
        const store = await factory(t);
        await seedOffice(store);
        await store.commitThread(createThreadCommitFixture());
        const occurredAt = "2026-08-08T00:00:01Z";
        let binding = officeBinding;
        if (status === "fork") {
          await store.commitThread(emptyForkCommit());
          binding = { ...officeBinding, threadId: "thread-2" };
        } else {
          await store.commitThread({
            tenantId: "tenant-1",
            idempotency: {
              scope: "office-thread-test",
              key: status,
              requestFingerprint: status,
            },
            expectedRevision: 1,
            messages: [],
            history: { expectedLastSequence: 0, items: [] },
            ...(status === "deleted"
              ? {
                  tombstone: {
                    expectedActiveRunId: null,
                    expectedGoalRevision: null,
                    occurredAt,
                  },
                }
              : {}),
            events: [
              {
                schemaVersion: "crewon.thread-event.v0",
                identity: { threadId: "thread-1" },
                eventId: `event-${status}`,
                sequence: 2,
                occurredAt,
                type:
                  status === "archived" ? "thread.archived" : "thread.deleted",
                data: { actorId: "actor-1" },
              },
            ],
          });
        }
        await assert.rejects(
          store.bindOfficeThread({ binding, expectedThreadRevision: 2 }),
          { code: "office_thread_not_eligible" },
        );
        assert.equal(await store.loadOfficeThreadBinding(binding), null);
      });
    }

    test("rejects forged creation metadata and an unrelated receipt without binding it", async (t) => {
      const store = await factory(t);
      await seedOffice(store);
      const input = createOfficeThread();
      await assert.rejects(
        store.commitThread({
          ...input,
          officeBinding: { ...officeBinding, boundByActorId: "other" },
        }),
        { code: "office_thread_creation_invalid" },
      );
      await store.commitThread(createThreadCommitFixture());
      await assert.rejects(store.commitThread(input), {
        code: "office_thread_receipt_mismatch",
      });
      assert.equal(await store.loadOfficeThreadBinding(officeBinding), null);
    });
  });
}
