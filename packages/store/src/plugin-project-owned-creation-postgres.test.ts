import assert from "node:assert/strict";
import test from "node:test";
import { ownedProjectPostgresFixture } from "./plugin-project-owned-postgres.test-support.ts";
import { creativeCreateInput } from "../../application/src/plugin-creative-project-action.test-support.ts";
import { uiTestActor } from "../../application/src/plugin-ui.test-support.ts";
const skip = !process.env.CREWON_TEST_POSTGRES_URL;
test(
  "postgres: original UI creation atomically writes owner, project, brief and scoped receipt; cold service and concurrent retry preserve one ID",
  { skip },
  async (t) => {
    const f = await ownedProjectPostgresFixture(t),
      a = await f.ui();
    const first = (await a.invoke("createProject", creativeCreateInput())) as {
      project: { projectId: string };
      disposition: string;
    };
    const cold = await f.ui("example.story", true);
    const replay = (await cold.invoke(
      "createProject",
      creativeCreateInput(),
    )) as typeof first;
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.project.projectId, first.project.projectId);
    const pair = (await Promise.all([
      a.invoke("createProject", {
        ...creativeCreateInput(),
        idempotencyKey: "concurrent",
      }),
      cold.invoke("createProject", {
        ...creativeCreateInput(),
        idempotencyKey: "concurrent",
      }),
    ])) as (typeof first)[];
    assert.equal(pair[0]!.project.projectId, pair[1]!.project.projectId);
    assert.deepEqual(await f.counts(), [2, 2, 2, 2]);
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
    const row = (
      await f.pool.query(
        `SELECT * FROM "${f.schema}".plugin_project_metadata_owners WHERE project_id=$1`,
        [first.project.projectId],
      )
    ).rows[0];
    assert.equal(row.plugin_id, a.ui.state.package.pluginId);
    assert.equal(row.publisher_id, a.ui.state.package.publisherId);
    assert.equal(row.profile_id, a.ui.state.scope.profileId);
    assert.equal(row.actor_id, uiTestActor.actorId);
    assert.equal(row.principal_id, uiTestActor.principalId);
    await assert.rejects(
      a.invoke("createProject", {
        ...creativeCreateInput(),
        request: { title: "changed", briefText: "changed" },
      }),
      /idempotency_conflict/u,
    );
    const b = await f.ui("example.other");
    const other = (await b.invoke(
      "createProject",
      creativeCreateInput(),
    )) as typeof first;
    assert.notEqual(other.project.projectId, first.project.projectId);
    assert.deepEqual(await f.counts(), [3, 3, 3, 3]);
  },
);
test(
  "postgres: original creation denies withdrawn independent policy, occupied legacy identity and rolls back failure after writing project, brief and owner",
  { skip },
  async (t) => {
    const f = await ownedProjectPostgresFixture(t),
      ui = await f.ui();
    f.policy.allowed = false;
    await assert.rejects(
      ui.invoke("createProject", creativeCreateInput()),
      /authorization_denied/u,
    );
    assert.deepEqual(await f.counts(), [0, 0, 0, 0]);
    f.policy.allowed = true;
    await f.pool.query(
      `CREATE FUNCTION "${f.schema}".reject_owned_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'named_owned_receipt_failure'; END $$`,
    );
    await f.pool.query(
      `CREATE TRIGGER reject_owned_receipt BEFORE INSERT ON "${f.schema}".creative_project_mutation_receipts FOR EACH ROW EXECUTE FUNCTION "${f.schema}".reject_owned_receipt()`,
    );
    await assert.rejects(ui.invoke("createProject", creativeCreateInput()));
    assert.deepEqual(await f.counts(), [0, 0, 0, 0]);
    await f.pool.query(
      `DROP TRIGGER reject_owned_receipt ON "${f.schema}".creative_project_mutation_receipts`,
    );
    f.ids.nextId = () => "occupied-legacy";
    await f.service.createProject(uiTestActor, {
      title: "legacy",
      briefText: "legacy",
      idempotencyKey: "legacy-create",
    });
    await assert.rejects(
      ui.invoke("createProject", creativeCreateInput()),
      (error) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message ===
          "plugin_project_owned_creation_project_conflict",
    );
    assert.deepEqual(await f.counts(), [1, 1, 0, 1]);
  },
);

test(
  "postgres: losing the actual COMMIT acknowledgement replays the durable owned creation instead of duplicating it",
  { skip },
  async (t) => {
    const f = await ownedProjectPostgresFixture(t),
      ui = await f.ui();
    let lose = true,
      receiptWritten = false;
    const connect = f.pool.connect;
    f.pool.connect = new Proxy(connect, {
      apply(target, thisArg, args) {
        if (args.length !== 0) return Reflect.apply(target, thisArg, args);
        return (
          Reflect.apply(target, thisArg, args) as Promise<
            import("pg").PoolClient
          >
        ).then(
          (client) =>
            new Proxy(client, {
              get(source, key) {
                const value = Reflect.get(source, key, source);
                if (typeof value !== "function") return value;
                if (key !== "query") return value.bind(source);
                return new Proxy(value, {
                  apply(fn, _owner, parameters) {
                    return (async () => {
                      const result = await Reflect.apply(
                        fn,
                        source,
                        parameters,
                      );
                      if (
                        typeof parameters[0] === "string" &&
                        parameters[0].includes("INSERT INTO") &&
                        parameters[0].includes(
                          "creative_project_mutation_receipts",
                        )
                      )
                        receiptWritten = true;
                      if (
                        parameters[0] === "COMMIT" &&
                        receiptWritten &&
                        lose
                      ) {
                        lose = false;
                        throw new Error(
                          "named_actual_commit_acknowledgement_lost",
                        );
                      }
                      return result;
                    })();
                  },
                });
              },
            }),
        );
      },
    });
    await assert.rejects(
      ui.invoke("createProject", creativeCreateInput()),
      (error) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message === "named_actual_commit_acknowledgement_lost",
    );
    assert.deepEqual(await f.counts(), [1, 1, 1, 1]);
    const cold = await f.ui("example.story", true);
    const replay = (await cold.invoke(
      "createProject",
      creativeCreateInput(),
    )) as { disposition: string };
    assert.equal(replay.disposition, "replayed");
    assert.deepEqual(await f.counts(), [1, 1, 1, 1]);
  },
);
