import assert from "node:assert/strict";
import test from "node:test";
import { threadListSql } from "./thread-list-query.ts";
import { compositionFixture } from "./workflow-run-composition.test-support.ts";
import { postgresCompositionFixture } from "./postgres-workflow-composition.test-support.ts";
import { migrateSqliteWorkflowChildren } from "./sqlite-workflow-child-schema.ts";
import { readSqliteOrdinaryThreadList } from "./ordinary-thread-list-snapshot.ts";

const query = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  before: null,
  limit: 20,
};

test("SQLite catalog reuses a caller-owned transaction and never commits or repairs an unsupported ownership schema", async (t) => {
  const f = await compositionFixture(t);
  migrateSqliteWorkflowChildren(f.database);
  f.database.exec("BEGIN IMMEDIATE");
  try {
    assert.deepEqual(
      readSqliteOrdinaryThreadList(f.database, query).map(
        (row) => row.thread_id,
      ),
      ["thread-1"],
    );
    assert.equal(f.database.isTransaction, true);
    f.database.exec("UPDATE workflow_child_schema SET version=99");
    assert.throws(() => readSqliteOrdinaryThreadList(f.database, query), {
      code: "workflow_child_schema_unsupported",
    });
    assert.equal(f.database.isTransaction, true);
    assert.equal(
      f.database.prepare("SELECT version FROM workflow_child_schema").get()!
        .version,
      99,
    );
  } finally {
    f.database.exec("ROLLBACK");
  }
  assert.equal(f.database.isTransaction, false);
  assert.deepEqual(
    (await f.store.listThreads(query)).map((thread) => thread.threadId),
    ["thread-1"],
  );
});

test("SQLite ordinary catalog refuses partial Workflow ownership without migration or destructive repair", async (t) => {
  const f = await compositionFixture(t);
  migrateSqliteWorkflowChildren(f.database);
  f.database.exec("DROP TABLE workflow_child_schema");
  await assert.rejects(f.store.listThreads(query), {
    code: "workflow_child_schema_corrupt",
  });
  assert.equal(
    f.database
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name='workflow_child_schema'",
      )
      .get()!.n,
    0,
  );
});

const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
pgTest(
  "PostgreSQL ordinary catalog refuses a future ownership schema without repairing it and remains usable after explicit fixture restoration",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    await f.admin.query(
      `UPDATE ${f.sql}.workflow_composition_schema SET version=99`,
    );
    await assert.rejects(f.store.listThreads(query), {
      code: "workflow_composition_schema_unsupported",
    });
    assert.equal(
      (
        await f.admin.query(
          `SELECT version FROM ${f.sql}.workflow_composition_schema`,
        )
      ).rows[0].version,
      99,
    );
    await f.admin.query(
      `UPDATE ${f.sql}.workflow_composition_schema SET version=1`,
    );
    assert.deepEqual(
      (await f.store.listThreads(query)).map((thread) => thread.threadId),
      ["thread-1"],
    );
  },
);

test("SQLite Workflow ownership exclusion retains visible-page and child identity index seeks without temporary sorting", async (t) => {
  const f = await compositionFixture(t);
  migrateSqliteWorkflowChildren(f.database);
  const statement = threadListSql(
    {
      ...query,
      before: { updatedAt: "2026-09-15T00:00:00Z", threadId: "anchor" },
    },
    "threads",
    "sqlite",
    { workflowChildren: "workflow_node_children" },
  );
  const plan = f.database
    .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...statement.values)
    .map((row) => String(row.detail))
    .join("\n");
  assert.match(plan, /SEARCH threads USING INDEX/);
  assert.match(
    plan,
    /SEARCH workflow_child USING (?:COVERING )?INDEX.*child_thread_id=\?/,
  );
  assert.doesNotMatch(plan, /TEMP B-TREE|SCAN workflow_child/);
});

test("SQLite orphaned wake marker cannot silently reclassify children as ordinary when both identity tables are missing", async (t) => {
  const f = await compositionFixture(t);
  migrateSqliteWorkflowChildren(f.database);
  f.database.exec(
    "DROP TABLE workflow_node_children; DROP TABLE workflow_child_schema",
  );
  await assert.rejects(f.store.listThreads(query), {
    code: "workflow_child_schema_corrupt",
  });
});
pgTest(
  "PostgreSQL orphaned wake marker cannot silently reclassify children as ordinary when both identity tables are missing",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    await f.admin.query(
      `DROP TABLE ${f.sql}.workflow_node_children; DROP TABLE ${f.sql}.workflow_composition_schema`,
    );
    await assert.rejects(f.store.listThreads(query), {
      code: "workflow_composition_schema_corrupt",
    });
  },
);
