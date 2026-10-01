import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  RunStoreError,
  type QueueClaimInput,
  type WorkItemExecutionScope,
} from "@crewon/application";
import {
  extensionFixture,
  configuration,
  receipt,
  runInput,
  target,
} from "./extension-store.test-support.ts";
import type { ExtensionExecutionTarget } from "@crewon/domain";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";

const current = `sha256:${"a".repeat(64)}`;
const historic = `sha256:${"b".repeat(64)}`;
const executionScope = (
  digest = current,
  unboundRuns: "include" | "exclude" = "exclude",
): WorkItemExecutionScope => ({
  tenantId: "tenant-1",
  extensionImplementationDigest: digest,
  unboundRuns,
});
const claim = (
  ownerId: string,
  scope?: WorkItemExecutionScope,
): QueueClaimInput => ({
  ownerId,
  leaseId: `lease-${ownerId}`,
  leaseDurationMs: 30000,
  ...(scope === undefined ? {} : { executionScope: scope }),
});
const code = (expected: string) => (error: unknown) =>
  error instanceof RunStoreError && error.code === expected;
const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

async function fixture(t: TestContext, backend: "sqlite" | "postgres") {
  const f = await extensionFixture(t, backend);
  await f.seed();
  const old = configuration({ revision: 2, implementationDigest: historic });
  await f.first.store.saveExtensionConfiguration({
    configuration: old,
    expectedRevision: 1,
    receipt: receipt("historic-config"),
  });
  const other = configuration({ tenantId: "tenant-2" });
  await f.first.store.saveExtensionConfiguration({
    configuration: other,
    expectedRevision: 0,
    receipt: receipt("other-config"),
  });
  const seed = async (
    id: string,
    kind: "current" | "historic" | "plain" | "other" | "otherPlain",
    readiness = 0,
    preparedTarget: ExtensionExecutionTarget = target,
  ) => {
    const config =
      kind === "historic"
        ? old
        : kind === "other" || kind === "otherPlain"
          ? other
          : configuration();
    const input = runInput(id, {
      tenantId: config.tenantId,
      configurationRevision: config.revision,
      configurationDigest: config.contentDigest,
      target: preparedTarget,
    });
    await f.prepare(input);
    await f.first.parent.commitRun(input.commit);
    if (kind !== "plain" && kind !== "otherPlain") {
      const b = input.binding;
      await f.sql(
        `INSERT INTO ${f.prefix}extension_run_bindings VALUES (${[b.tenantId, b.spaceId, b.pluginId, b.runId].map(quoted).join(",")}, ${b.configurationRevision}, ${quoted(JSON.stringify(b))})`,
      );
    }
    const ready =
      backend === "sqlite"
        ? readiness
        : quoted(new Date(readiness).toISOString());
    await f.sql(
      `UPDATE ${f.prefix}work_items SET ${backend === "sqlite" ? "available_at_ms" : "available_at"}=${ready} WHERE work_item_id=${quoted(`work-${id}`)}`,
    );
    return input;
  };
  const expire = async (id: string, at: number) => {
    const value =
      backend === "sqlite" ? at : quoted(new Date(at).toISOString());
    await f.sql(
      `UPDATE ${f.prefix}work_items SET ${backend === "sqlite" ? "lease_expires_at_ms" : "lease_expires_at"}=${value} WHERE work_item_id=${quoted(`work-${id}`)}`,
    );
  };
  return { ...f, seed, expire };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  const targetScope = (
    targets: readonly ExtensionExecutionTarget[],
    unboundRuns: "include" | "exclude" = "exclude",
  ): WorkItemExecutionScope => ({
    ...executionScope(current, unboundRuns),
    extensionTargets: targets,
  });
  test(
    `${backend}: same implementation workers claim only their exact prepared Agent and materialization before LIMIT`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const anotherAgent = { ...target, agentVersionId: "agent-2" };
      const anotherMaterialization = {
        ...target,
        materializationDigest: `sha256:${"3".repeat(64)}`,
      };
      await f.seed("first-agent", "current", 0, target);
      await f.seed(
        "same-agent-other-materialization",
        "current",
        1,
        anotherMaterialization,
      );
      await f.seed("second-agent", "current", 2, anotherAgent);
      const second = await f.second.parent.claimNextWorkItem(
        claim("second-agent", targetScope([anotherAgent])),
      );
      assert.equal(second?.workItem.runId, "second-agent");
      assert.equal(
        await f.second.parent.claimNextWorkItem(
          claim("second-empty", targetScope([anotherAgent])),
        ),
        null,
      );
      const different = await f.first.parent.claimNextWorkItem(
        claim(
          "different-materialization",
          targetScope([anotherMaterialization]),
        ),
      );
      assert.equal(
        different?.workItem.runId,
        "same-agent-other-materialization",
      );
      assert.equal(
        await f.first.parent.claimNextWorkItem(
          claim("materialization-empty", targetScope([anotherMaterialization])),
        ),
        null,
      );
      const first = await f.second.parent.claimNextWorkItem(
        claim("first-agent", targetScope([target])),
      );
      assert.equal(first?.workItem.runId, "first-agent");
      assert.ok(
        [first, second, different].every((item) => item?.lease.epoch === 1),
      );
    },
  );
  test(
    `${backend}: empty target set excludes bound work but keeps current ordinary tasks and tenant/implementation filters`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.seed("bound", "current");
      await f.seed("historical-implementation", "historic");
      await f.seed("other-tenant", "otherPlain");
      await f.seed("ordinary", "plain");
      assert.equal(
        await f.first.parent.claimNextWorkItem(
          claim("empty-history", targetScope([])),
        ),
        null,
      );
      assert.equal(
        (
          await f.first.parent.claimNextWorkItem(
            claim("empty-current", targetScope([], "include")),
          )
        )?.workItem.runId,
        "ordinary",
      );
      assert.equal(
        await f.first.parent.claimNextWorkItem(
          claim("empty-current-again", targetScope([], "include")),
        ),
        null,
      );
      assert.equal(
        (
          await f.first.parent.claimNextWorkItem(
            claim("exact", targetScope([target])),
          )
        )?.workItem.runId,
        "bound",
      );
      assert.equal(
        await f.first.parent.claimNextWorkItem(
          claim("exact-again", targetScope([target], "include")),
        ),
        null,
      );
    },
  );
  test(
    `${backend}: expired work remains owned by its original prepared target and cannot be stolen by a new materialization`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const next = {
        ...target,
        materializationDigest: `sha256:${"4".repeat(64)}`,
      };
      await f.seed("old-expired-target", "current", 0, target);
      const original = await f.first.parent.claimNextWorkItem(
        claim("old-owner", targetScope([target])),
      );
      assert.ok(original);
      await f.expire("old-expired-target", 0);
      await f.seed("new-pending-target", "current", 1, next);
      assert.equal(
        (
          await f.second.parent.claimNextWorkItem(
            claim("new-owner", targetScope([next])),
          )
        )?.workItem.runId,
        "new-pending-target",
      );
      assert.equal(
        await f.second.parent.claimNextWorkItem(
          claim("new-empty", targetScope([next])),
        ),
        null,
      );
      const restored = await f.first.parent.claimNextWorkItem(
        claim("restored-old", targetScope([target])),
      );
      assert.equal(restored?.workItem.runId, "old-expired-target");
      assert.equal(restored?.lease.epoch, 2);
    },
  );
  test(
    `${backend}: target match covers all fields, SQL-bound strings and JSON-null workspace identically`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const prepared = {
        ...target,
        authorityId: "authority-'quoted",
        workspaceBindingId: "workspace-'quoted",
      };
      await f.seed("prepared", "current", 0, prepared);
      for (const mismatch of [
        { agentVersionContentDigest: `sha256:${"5".repeat(64)}` },
        { authorityId: "other-authority" },
        { runtimeGeneration: "other-runtime" },
        { policySnapshotId: "other-policy" },
        { workspaceBindingId: null },
      ])
        assert.equal(
          await f.first.parent.claimNextWorkItem(
            claim("mismatched", targetScope([{ ...prepared, ...mismatch }])),
          ),
          null,
        );
      assert.equal(
        (
          await f.first.parent.claimNextWorkItem(
            claim("quoted", targetScope([prepared])),
          )
        )?.workItem.runId,
        "prepared",
      );
      const badNull = await f.seed("missing-workspace", "current");
      const corruptTarget = { ...badNull.binding.target } as Record<
        string,
        unknown
      >;
      delete corruptTarget.workspaceBindingId;
      await f.sql(
        `UPDATE ${f.prefix}extension_run_bindings SET binding_json=${quoted(JSON.stringify({ ...badNull.binding, target: corruptTarget }))} WHERE run_id='missing-workspace'`,
      );
      const extra = await f.seed("extra-field", "current");
      await f.sql(
        `UPDATE ${f.prefix}extension_run_bindings SET binding_json=${quoted(JSON.stringify({ ...extra.binding, target: { ...extra.binding.target, extra: true } }))} WHERE run_id='extra-field'`,
      );
      await f.seed("null-workspace", "current");
      assert.equal(
        (
          await f.first.parent.claimNextWorkItem(
            claim("null-exact", targetScope([target])),
          )
        )?.workItem.runId,
        "null-workspace",
      );
      assert.equal(
        await f.first.parent.claimNextWorkItem(
          claim("corrupt-excluded", targetScope([target])),
        ),
        null,
      );
    },
  );
  test(
    `${backend}: prepared target inputs are copied before storage await and malformed sets never consume a lease`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.seed("prepared", "current");
      for (const extensionTargets of [
        undefined,
        null,
        [target, target],
        new Array(1),
        [{ ...target, workspaceBindingId: undefined }],
      ])
        await assert.rejects(
          f.first.parent.claimNextWorkItem({
            ...claim("bad"),
            executionScope: { ...executionScope(), extensionTargets },
          } as QueueClaimInput),
          code("queue_execution_scope_invalid"),
        );
      const mutableTarget = { ...target };
      const input = {
        ...claim("actual"),
        executionScope: {
          ...executionScope(),
          extensionTargets: [mutableTarget],
        },
      };
      const pending = f.first.parent.claimNextWorkItem(input);
      mutableTarget.materializationDigest = `sha256:${"6".repeat(64)}`;
      input.executionScope.extensionTargets.length = 0;
      const claimed = await pending;
      assert.equal(claimed?.workItem.runId, "prepared");
      assert.equal(claimed?.lease.epoch, 1);
    },
  );
  test(
    `${backend}: historical and current workers isolate implementations and tenant before LIMIT`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.seed("old", "historic");
      await f.seed("foreign", "other");
      await f.seed("foreign-plain", "otherPlain");
      await f.seed("plain", "plain");
      await f.seed("new", "current");
      const before = await f.first.parent.loadRun({
        tenantId: "tenant-1",
        runId: "old",
      });
      const fresh = await f.first.parent.claimNextWorkItem(
        claim("current-worker", executionScope()),
      );
      assert.equal(fresh?.workItem.runId, "new");
      assert.equal(
        await f.first.parent.claimNextWorkItem(
          claim("current-empty", executionScope()),
        ),
        null,
      );
      assert.deepEqual(
        await f.first.parent.loadRun({ tenantId: "tenant-1", runId: "old" }),
        before,
        "missing historical implementation must not settle or rewrite its Run",
      );
      const ordinary = await f.first.parent.claimNextWorkItem(
        claim("ordinary-worker", executionScope(current, "include")),
      );
      assert.equal(ordinary?.workItem.runId, "plain");
      assert.equal(
        await f.first.parent.claimNextWorkItem(
          claim("ordinary-empty", executionScope(current, "include")),
        ),
        null,
      );
      const old = await f.second.parent.claimNextWorkItem(
        claim("historical-worker", executionScope(historic)),
      );
      assert.equal(old?.workItem.runId, "old");
      assert.equal(old?.lease.epoch, 1);
    },
  );

  test(
    `${backend}: selector preserves oldest-ready ordering across expired leases and retries`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.seed("old-expired", "historic");
      await f.first.parent.claimNextWorkItem(
        claim("historic", executionScope(historic)),
      );
      await f.expire("old-expired", 0);
      await f.seed("expired", "current", 2000);
      await f.first.parent.claimNextWorkItem(
        claim("previous", executionScope()),
      );
      await f.expire("expired", 1000);
      await f.seed("pending", "current", 1500);
      const expired = await f.second.parent.claimNextWorkItem(
        claim("recovered", executionScope()),
      );
      assert.equal(expired?.workItem.runId, "expired");
      assert.equal(expired?.lease.epoch, 2);
      await f.second.parent.retryWorkItem({
        workItemId: expired!.workItem.workItemId,
        ownerId: expired!.lease.ownerId,
        leaseId: expired!.lease.leaseId,
        leaseEpoch: expired!.lease.epoch,
        retryAfterMs: 0,
        reasonCode: "retry",
      });
      const pending = await f.first.parent.claimNextWorkItem(
        claim("pending", executionScope()),
      );
      assert.equal(pending?.workItem.runId, "pending");
      const retried = await f.second.parent.claimNextWorkItem(
        claim("retry", executionScope()),
      );
      assert.equal(retried?.workItem.runId, "expired");
      assert.equal(retried?.lease.epoch, 3);
      assert.equal(
        (
          await f.first.parent.claimNextWorkItem(
            claim("old-recovered", executionScope(historic)),
          )
        )?.lease.epoch,
        2,
      );
    },
  );

  test(
    `${backend}: concurrent claims are atomic within one implementation and across workers`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.seed("old", "historic");
      await f.seed("new-a", "current");
      await f.seed("new-b", "current");
      const results = await Promise.all([
        f.first.parent.claimNextWorkItem(claim("new-a", executionScope())),
        f.second.parent.claimNextWorkItem(claim("new-b", executionScope())),
        f.first.parent.claimNextWorkItem(
          claim("old", executionScope(historic)),
        ),
      ]);
      assert.deepEqual(
        results
          .slice(0, 2)
          .map((result) => result?.workItem.runId)
          .sort(),
        ["new-a", "new-b"],
      );
      assert.equal(results[2]?.workItem.runId, "old");
      assert.ok(results.every((result) => result?.lease.epoch === 1));
    },
  );

  test(
    `${backend}: malformed scopes and outbox selectors fail without consuming leases or invoking getters`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.seed("new", "current");
      let reads = 0;
      const accessor = Object.defineProperty(
        { ...executionScope() },
        "tenantId",
        {
          enumerable: true,
          get() {
            reads += 1;
            return "tenant-1";
          },
        },
      );
      const parentAccessor = Object.defineProperty(
        claim("bad"),
        "executionScope",
        {
          enumerable: true,
          get() {
            reads += 1;
            return executionScope();
          },
        },
      );
      for (const scope of [
        null,
        { ...executionScope(), extra: true },
        { ...executionScope(), tenantId: " " },
        { ...executionScope(), extensionImplementationDigest: "bad" },
        { ...executionScope(), unboundRuns: "any" },
        accessor,
      ]) {
        await assert.rejects(
          f.first.parent.claimNextWorkItem({
            ...claim("bad"),
            executionScope: scope,
          } as QueueClaimInput),
          code("queue_execution_scope_invalid"),
        );
      }
      await assert.rejects(
        f.first.parent.claimNextWorkItem(parentAccessor),
        code("queue_execution_scope_invalid"),
      );
      await assert.rejects(
        f.first.parent.claimNextOutbox(claim("bad-outbox", executionScope())),
        code("queue_execution_scope_forbidden"),
      );
      assert.equal(reads, 0);
      assert.equal(
        (
          await f.first.parent.claimNextWorkItem(
            claim("valid", executionScope()),
          )
        )?.lease.epoch,
        1,
      );
      assert.equal(
        (await f.first.parent.claimNextOutbox(claim("valid-outbox")))?.lease
          .epoch,
        1,
      );
    },
  );

  test(
    `${backend}: claim captures selector and lease identity before storage await`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.seed("old", "historic");
      await f.seed("new", "current");
      const input = {
        ownerId: "actual",
        leaseId: "actual-lease",
        leaseDurationMs: 30000,
        executionScope: { ...executionScope() },
      };
      const pending = f.first.parent.claimNextWorkItem(input);
      input.executionScope.extensionImplementationDigest = historic;
      input.executionScope.tenantId = "tenant-2";
      input.ownerId = "mutated";
      const actual = await pending;
      assert.equal(actual?.workItem.runId, "new");
      assert.equal(actual?.lease.ownerId, "actual");
    },
  );
}

test("InMemoryRunStore rejects unsupported selectors and leaves both queues unclaimed", async () => {
  const store = new InMemoryRunStore();
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  await assert.rejects(
    store.claimNextWorkItem(claim("scoped", executionScope())),
    code("queue_execution_scope_unsupported"),
  );
  await assert.rejects(
    store.claimNextOutbox(claim("scoped", executionScope())),
    code("queue_execution_scope_forbidden"),
  );
  assert.equal(
    (await store.claimNextWorkItem(claim("legacy")))?.lease.epoch,
    1,
  );
  assert.equal((await store.claimNextOutbox(claim("legacy")))?.lease.epoch, 1);
});
