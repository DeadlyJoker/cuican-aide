import assert from "node:assert/strict";
import test from "node:test";
import { ownedProjectPostgresFixture } from "./plugin-project-owned-postgres.test-support.ts";
import { creativeCreateInput } from "../../application/src/plugin-creative-project-action.test-support.ts";
const skip = !process.env.CREWON_TEST_POSTGRES_URL;
type Result = {
  project: { projectId: string; revision: number; state: string };
  disposition: string;
  brief?: { briefRevision: number };
  asset?: { assetId: string; revision: number };
};
test(
  "postgres: owned UI rename/archive/restore/brief/concept writes share original CAS and receipts, including concurrent stale updates",
  { skip },
  async (t) => {
    const f = await ownedProjectPostgresFixture(t),
      a = await f.ui(),
      cold = await f.ui("example.story", true);
    let current = (await a.invoke(
      "createProject",
      creativeCreateInput(),
    )) as Result;
    const projectId = current.project.projectId;
    const rename = {
      projectId,
      idempotencyKey: "owned-rename",
      request: {
        title: "New title",
        expectedProjectRevision: current.project.revision,
      },
    };
    current = (await a.invoke("renameProject", rename)) as Result;
    assert.equal(
      ((await cold.invoke("renameProject", rename)) as Result).disposition,
      "replayed",
    );
    await assert.rejects(
      a.invoke("renameProject", {
        ...rename,
        request: { ...rename.request, title: "changed" },
      }),
      /idempotency_conflict/u,
    );
    for (const state of ["archived", "active"] as const)
      current = (await a.invoke("setProjectState", {
        projectId,
        idempotencyKey: state,
        request: { state, expectedProjectRevision: current.project.revision },
      })) as Result;
    current = (await a.invoke("appendBrief", {
      projectId,
      idempotencyKey: "new-brief",
      request: {
        text: "新需求",
        expectedProjectRevision: current.project.revision,
      },
    })) as Result;
    assert.ok(current.brief);
    current = (await a.invoke("createConcept", {
      projectId,
      idempotencyKey: "concept",
      request: {
        name: "hero",
        prompt: "第一版",
        briefRevision: current.brief.briefRevision,
        expectedProjectRevision: current.project.revision,
      },
    })) as Result;
    assert.ok(current.asset);
    const assetId = current.asset.assetId;
    current = (await a.invoke("appendConceptRevision", {
      projectId,
      assetId,
      idempotencyKey: "concept-version",
      request: {
        prompt: "第二版",
        briefRevision: 2,
        expectedProjectRevision: current.project.revision,
        expectedAssetMetadataRevision: current.asset.revision,
      },
    })) as Result;
    const race = await Promise.allSettled([
      a.invoke("renameProject", {
        projectId,
        idempotencyKey: "race-a",
        request: {
          title: "A",
          expectedProjectRevision: current.project.revision,
        },
      }),
      cold.invoke("renameProject", {
        projectId,
        idempotencyKey: "race-b",
        request: {
          title: "B",
          expectedProjectRevision: current.project.revision,
        },
      }),
    ]);
    assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(race.filter((x) => x.status === "rejected").length, 1);
    const failure = race.find((x) => x.status === "rejected");
    assert.ok(failure && failure.status === "rejected");
    assert.match(String(failure.reason), /revision_conflict/u);
    assert.deepEqual(await f.counts(), [1, 2, 1, 8]);
    const history = (await a.invoke("listConceptRevisions", {
      projectId,
      assetId,
      query: {},
    })) as { revisions: unknown[] };
    assert.equal(history.revisions.length, 2);
  },
);
test(
  "postgres: another plugin cannot mutate a real owned project and failed receipt insert rolls back its metadata CAS",
  { skip },
  async (t) => {
    const f = await ownedProjectPostgresFixture(t),
      a = await f.ui(),
      b = await f.ui("example.other");
    const made = (await a.invoke(
      "createProject",
      creativeCreateInput(),
    )) as Result;
    const command = {
      projectId: made.project.projectId,
      idempotencyKey: "owned-write",
      request: {
        title: "Should rollback",
        expectedProjectRevision: made.project.revision,
      },
    };
    await assert.rejects(b.invoke("renameProject", command), /not_found/u);
    await f.pool.query(
      `CREATE FUNCTION "${f.schema}".reject_metadata_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'named_owned_metadata_receipt_failure'; END $$`,
    );
    await f.pool.query(
      `CREATE TRIGGER reject_metadata_receipt BEFORE INSERT ON "${f.schema}".creative_project_mutation_receipts FOR EACH ROW EXECUTE FUNCTION "${f.schema}".reject_metadata_receipt()`,
    );
    await assert.rejects(
      a.invoke("renameProject", command),
      (error) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message === "named_owned_metadata_receipt_failure",
    );
    assert.deepEqual(
      (
        (await a.invoke("getProject", {
          projectId: made.project.projectId,
        })) as Result
      ).project,
      made.project,
    );
    assert.deepEqual(await f.counts(), [1, 1, 1, 1]);
    await f.pool.query(
      `DROP TRIGGER reject_metadata_receipt ON "${f.schema}".creative_project_mutation_receipts`,
    );
    await a.invoke("renameProject", command);
    assert.deepEqual(await f.counts(), [1, 1, 1, 2]);
  },
);

test(
  "postgres: owned metadata policy withdrawn after the real receipt INSERT rolls back the project and receipt",
  { skip },
  async (t) => {
    const f = await ownedProjectPostgresFixture(t),
      a = await f.ui();
    const made = (await a.invoke(
      "createProject",
      creativeCreateInput(),
    )) as Result;
    const { interceptOwnedPostgresQueries } = await import(
      "./plugin-project-owned-postgres.test-support.ts"
    );
    let writes = 0;
    interceptOwnedPostgresQueries(f.pool, (statement) => {
      if (
        typeof statement === "string" &&
        statement.includes("INSERT INTO") &&
        statement.includes("creative_project_mutation_receipts")
      ) {
        writes++;
        f.policy.allowed = false;
      }
    });
    await assert.rejects(
      a.invoke("renameProject", {
        projectId: made.project.projectId,
        idempotencyKey: "late-revocation",
        request: {
          title: "Must rollback",
          expectedProjectRevision: made.project.revision,
        },
      }),
      /authorization_denied/u,
    );
    assert.equal(writes, 1);
    f.policy.allowed = true;
    assert.deepEqual(
      (
        (await a.invoke("getProject", {
          projectId: made.project.projectId,
        })) as Result
      ).project,
      made.project,
    );
    assert.deepEqual(await f.counts(), [1, 1, 1, 1]);
  },
);
test(
  "postgres: owned metadata replays the original receipt when the successful COMMIT acknowledgement is lost",
  { skip },
  async (t) => {
    const f = await ownedProjectPostgresFixture(t),
      a = await f.ui();
    const made = (await a.invoke(
      "createProject",
      creativeCreateInput(),
    )) as Result;
    const { interceptOwnedPostgresQueries } = await import(
      "./plugin-project-owned-postgres.test-support.ts"
    );
    let written = false,
      lose = true;
    interceptOwnedPostgresQueries(f.pool, (statement) => {
      if (
        typeof statement === "string" &&
        statement.includes("INSERT INTO") &&
        statement.includes("creative_project_mutation_receipts")
      )
        written = true;
      if (statement === "COMMIT" && written && lose) {
        lose = false;
        throw new Error("named_owned_metadata_commit_acknowledgement_lost");
      }
    });
    const command = {
      projectId: made.project.projectId,
      idempotencyKey: "owned-lost-ack",
      request: {
        title: "Saved once",
        expectedProjectRevision: made.project.revision,
      },
    };
    await assert.rejects(
      a.invoke("renameProject", command),
      (error) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message ===
          "named_owned_metadata_commit_acknowledgement_lost",
    );
    assert.deepEqual(await f.counts(), [1, 1, 1, 2]);
    const cold = await f.ui("example.story", true),
      replay = (await cold.invoke("renameProject", command)) as Result;
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.project.revision, made.project.revision + 1);
    assert.deepEqual(await f.counts(), [1, 1, 1, 2]);
  },
);
