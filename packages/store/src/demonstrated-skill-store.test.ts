import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  DemonstratedSkillRecord,
  SkillExecutionRecord,
  SkillTrialReview,
} from "@crewon/application";
import {
  createSkillVersion,
  renderSkillInvocationContext,
  type SkillVersion,
} from "@crewon/domain";
import { SqliteDemonstratedSkillStore } from "./demonstrated-skill-store.ts";

// Host/storage contract fixtures: these are not real model or browser acceptance evidence.
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const scope = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  ownerActorId: "actor-1",
};
const locator = { ...scope, skillId: "skill-1" };
const at = "2026-09-14T00:00:00.000Z";
const review: SkillTrialReview = {
  confirmedAt: at,
  criteria: ["Rows match the requested date"],
  coverage: ["new-input"],
  resultNote: "Fixture reviewer checked the output rows",
};
function record(skillId = "skill-1"): DemonstratedSkillRecord {
  return {
    ...scope,
    skillId,
    revision: 1,
    draft: {
      name: "Date export",
      purpose: "Export rows for a chosen date",
      steps: ["Select date, then export rows"],
      parameters: [
        { name: "date", label: "Date", type: "string", required: true },
      ],
      requiredToolRefs: ["browser.export"],
      completionCriteria: ["Rows match the requested date"],
      knownExceptions: ["Ask for sign-in when the session expires"],
      runtimeRequirements: [],
    },
    source: {
      recordingId: "fixture-recording",
      revision: 1,
      contentDigest: `sha256:${"a".repeat(64)}`,
      provenance: "contract-fixture",
    },
    disabled: false,
    deleted: false,
    activatedVersionIds: [],
    createdAt: at,
    updatedAt: at,
  };
}
function version(versionId = "version-1", skill = record()): SkillVersion {
  return createSkillVersion(
    {
      skillId: skill.skillId,
      versionId,
      method: skill.draft,
      source: skill.source,
      createdAt: at,
    },
    digester,
  );
}
function execution(
  executionId = "execution-1",
  createdAt = at,
): SkillExecutionRecord {
  return {
    ...locator,
    executionId,
    invocation: {
      schemaVersion: "crewon.skill-invocation.v1",
      skill: version().ref,
      parameters: { date: "2026-09-15" },
      requiredToolRefs: ["browser.export"],
    },
    purpose: "trial",
    command: {
      kind: "turn.start",
      idempotencyKey: executionId,
      threadId: "thread-1",
      expectedThreadRevision: 1,
      content: renderSkillInvocationContext(version(), {
        schemaVersion: "crewon.skill-invocation.v1",
        skill: version().ref,
        parameters: { date: "2026-09-15" },
        requiredToolRefs: ["browser.export"],
      }),
      requestedAgentVersionId: "agent-1",
      executionIntent: "none",
      route: {
        authorityId: "authority-1",
        runtimeGeneration: "runtime-1",
        agentVersionId: "agent-1",
        policySnapshotId: "policy-1",
        workspaceBindingId: null,
      },
    },
    runId: null,
    review: null,
    createdAt,
  };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "crewon-skill-store-"));
  const path = join(dir, "host.sqlite");
  const stores: SqliteDemonstratedSkillStore[] = [];
  const open = () => {
    const store = new SqliteDemonstratedSkillStore(path, digester);
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { open, path };
}

test("F03-R03/R07 persists scoped drafts and atomically rejects stale writers across connections", async (t) => {
  const f = await fixture(t);
  const first = f.open();
  const second = f.open();
  await first.saveSkill(record(), 0);
  await assert.rejects(second.saveSkill(record(), 0), {
    code: "skill_revision_conflict",
    category: "conflict",
  });
  assert.deepEqual(await second.getSkill(locator), record());
  const changed = {
    ...record(),
    revision: 2,
    draft: { ...record().draft, purpose: "Updated purpose" },
    updatedAt: "2026-09-14T01:00:00.000Z",
  };
  await second.saveSkill(changed, 1);
  await assert.rejects(first.saveSkill({ ...record(), revision: 2 }, 1), {
    code: "skill_revision_conflict",
  });
  await first.close();
  await first.close();
  assert.deepEqual(await f.open().getSkill(locator), changed);
  for (const other of [
    { tenantId: "tenant-2" },
    { spaceId: "space-2" },
    { ownerActorId: "actor-2" },
  ]) {
    assert.equal(await second.getSkill({ ...locator, ...other }), null);
    assert.deepEqual(
      await second.listSkills(
        { ...scope, ...other },
        { after: null, limit: 10 },
      ),
      [],
    );
    await second.saveSkill({ ...record(), ...other }, 0);
    assert.equal(
      (await second.getSkill({ ...locator, ...other }))?.revision,
      1,
    );
  }
  await assert.rejects(second.saveSkill({ ...changed, revision: 4 }, 2), {
    category: "validation",
  });
});

test("F03-R03 keeps versions immutable, digest verified and available after draft edits and disable", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const v = version();
  await store.saveSkill(record(), 0);
  await store.putVersion(locator, v);
  await store.putVersion(locator, v);
  await assert.rejects(
    store.putVersion(locator, { ...v, markdown: "tampered" }),
    { code: "skill_digest_mismatch" },
  );
  await assert.rejects(
    store.putVersion(
      locator,
      version("version-1", {
        ...record(),
        draft: { ...record().draft, purpose: "Different method" },
      }),
    ),
    { code: "skill_version_conflict" },
  );
  await assert.rejects(
    store.getVersion(locator, {
      ...v.ref,
      contentDigest: `sha256:${"0".repeat(64)}`,
    }),
    { code: "skill_digest_mismatch" },
  );
  assert.equal(
    await store.getVersion(locator, { ...v.ref, versionId: "missing" }),
    null,
  );
  await store.saveSkill(
    {
      ...record(),
      revision: 2,
      disabled: true,
      activatedVersionIds: [v.ref.versionId],
      draft: { ...record().draft, purpose: "Changed draft" },
    },
    1,
  );
  await store.close();
  const reopened = f.open();
  assert.deepEqual(await reopened.getVersion(locator, v.ref), v);
  assert.deepEqual(await reopened.listVersions(locator), [v]);
  assert.deepEqual((await reopened.getSkill(locator))?.activatedVersionIds, [
    v.ref.versionId,
  ]);
  for (const other of [
    { tenantId: "tenant-2" },
    { spaceId: "space-2" },
    { ownerActorId: "actor-2" },
  ]) {
    assert.equal(
      await reopened.getVersion({ ...locator, ...other }, v.ref),
      null,
    );
    assert.deepEqual(await reopened.listVersions({ ...locator, ...other }), []);
    await assert.rejects(reopened.putVersion({ ...locator, ...other }, v), {
      code: "skill_not_found",
    });
  }
  await assert.rejects(
    reopened.putVersion(locator, version("version-2", record("other-skill"))),
    { code: "skill_ref_mismatch" },
  );
});

test("F03-R04/R05 recovers immutable execution commands, run binding and reviews across two connections", async (t) => {
  const f = await fixture(t);
  const first = f.open();
  const second = f.open();
  await first.saveSkill(record(), 0);
  await first.putVersion(locator, version());
  const pending = execution();
  assert.deepEqual(await first.putExecution(pending), pending);
  assert.deepEqual(await second.putExecution(pending), pending);
  await assert.rejects(
    second.putExecution({
      ...pending,
      command: { ...pending.command, content: "different instruction" },
    }),
    { code: "skill_execution_context_mismatch" },
  );
  await first.bindExecutionRun(locator, pending.executionId, "run-actual-id");
  await second.bindExecutionRun(locator, pending.executionId, "run-actual-id");
  await assert.rejects(
    first.bindExecutionRun(locator, pending.executionId, "run-other"),
    { code: "skill_execution_run_conflict" },
  );
  assert.equal((await second.putExecution(pending)).runId, "run-actual-id");
  await first.reviewExecution(locator, pending.executionId, review);
  await second.reviewExecution(locator, pending.executionId, review);
  await assert.rejects(
    second.reviewExecution(locator, pending.executionId, {
      ...review,
      criteria: ["different review"],
    }),
    { code: "skill_execution_review_conflict" },
  );
  await first.close();
  await second.close();
  const restored = f.open();
  const saved = { ...pending, runId: "run-actual-id", review };
  assert.deepEqual(
    await restored.getExecution(locator, pending.executionId),
    saved,
  );
  assert.deepEqual(await restored.putExecution(pending), saved);
  for (const other of [
    { tenantId: "tenant-2" },
    { spaceId: "space-2" },
    { ownerActorId: "actor-2" },
  ]) {
    assert.equal(
      await restored.getExecution(
        { ...locator, ...other },
        pending.executionId,
      ),
      null,
    );
    assert.deepEqual(
      await restored.listExecutions({ ...locator, ...other }),
      [],
    );
    await assert.rejects(
      restored.bindExecutionRun(
        { ...locator, ...other },
        pending.executionId,
        "run-other",
      ),
      { code: "skill_execution_not_found" },
    );
    await assert.rejects(
      restored.reviewExecution(
        { ...locator, ...other },
        pending.executionId,
        review,
      ),
      { code: "skill_execution_not_found" },
    );
  }
});

test("F03-R03/R04 bounded pages and latest execution list preserve historical lookup", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  for (const id of ["skill-Z", "skill-a", "skill-b"])
    await store.saveSkill(record(id), 0);
  assert.deepEqual(
    (await store.listSkills(scope, { after: null, limit: 2 })).map(
      (s) => s.skillId,
    ),
    ["skill-Z", "skill-a"],
  );
  assert.deepEqual(
    (await store.listSkills(scope, { after: "skill-a", limit: 1 })).map(
      (s) => s.skillId,
    ),
    ["skill-b"],
  );
  for (const limit of [0, 101, 1.5, NaN])
    await assert.rejects(store.listSkills(scope, { after: null, limit }), {
      category: "validation",
    });
  await store.saveSkill(record(), 0);
  for (let i = 0; i < 100; i++)
    await store.putVersion(locator, version(`version-${i}`));
  await store.putVersion(locator, version("version-1"));
  await assert.rejects(store.putVersion(locator, version("version-100")), {
    code: "skill_version_limit",
  });
  assert.equal((await store.listVersions(locator)).length, 100);
  for (let i = 0; i < 102; i++)
    await store.putExecution(
      execution(
        `execution-${String(i).padStart(3, "0")}`,
        new Date(Date.parse(at) + i * 1000).toISOString(),
      ),
    );
  const latest = await store.listExecutions(locator);
  assert.equal(latest.length, 100);
  assert.equal(latest[0]?.executionId, "execution-101");
  assert.equal(latest[99]?.executionId, "execution-002");
  assert.equal(
    (await store.getExecution(locator, "execution-000"))?.executionId,
    "execution-000",
  );
});

test("F03-R03/R04 rejects invalid persistence and reads fail closed on stored version corruption", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const v = version();
  await assert.rejects(store.putVersion(locator, v), {
    code: "skill_not_found",
  });
  await store.saveSkill(record(), 0);
  await assert.rejects(
    store.saveSkill(
      { ...record(), revision: 2, activatedVersionIds: ["missing"] },
      1,
    ),
    { code: "skill_version_not_found" },
  );
  await assert.rejects(store.putExecution(execution()), {
    code: "skill_version_not_found",
  });
  await store.putVersion(locator, v);
  await assert.rejects(
    store.putExecution({ ...execution(), runId: "invented" }),
    { category: "validation" },
  );
  await store.putExecution(execution());
  await assert.rejects(store.reviewExecution(locator, "execution-1", review), {
    code: "skill_execution_review_not_ready",
  });
  await store.close();
  const database = new DatabaseSync(f.path);
  database
    .prepare("UPDATE demonstrated_skill_versions SET version_json = ?")
    .run(JSON.stringify({ ...v, markdown: "tampered at rest" }));
  database.close();
  await assert.rejects(f.open().getVersion(locator, v.ref), {
    code: "skill_digest_mismatch",
  });
});
