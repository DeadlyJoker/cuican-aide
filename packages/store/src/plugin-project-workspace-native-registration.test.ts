import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import {
  qualifyPluginProjectWorkspacePreparation,
  type PluginProjectWorkspaceNativeObservation,
} from "@crewon/application";
import { issuePluginProjectWorkspaceNativeObservation } from "@crewon/application/host-project-workspaces";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import { ownedConversationUiFixture } from "./project-conversation-ui-owned.test-support.ts";

// Genuine live UI and original SQL parent. Native response, package discovery and Host policy
// are explicit fixtures; this is SQL transaction coverage, not a Main/filesystem acceptance.
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: original Parent records scoped Native evidence and replays the first timestamp without another Thread`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await ownedConversationUiFixture(
        t,
        "matching",
        "available",
        "nativeIdentity",
        {
          backend,
          namespace: "deferred",
        },
      );
      const registration =
        f.parent.pluginProjectWorkspaceNativeRegistrationStore();
      assert.ok(Object.isFrozen(registration));
      assert.deepEqual(Object.keys(registration), [
        "recordFromNativeObservation",
      ]);
      let retained: PluginProjectWorkspaceNativeObservation | undefined;
      f.state.prepareWorkspace = true;
      f.state.onWorkspacePrepared = async (preparation) => {
        const q = qualifyPluginProjectWorkspacePreparation(preparation);
        await q.assertCurrent();
        const scope = f.scopes.at(-1)!;
        const projects = f.parent
          .creativeProjectStore()
          .bindProjectReads(scope);
        await assert.rejects(
          projects.loadProject({
            owner: {
              tenantId: f.actor.tenantId,
              spaceId: f.actor.spaceId,
              principalId: "foreign-principal",
            },
            projectId: f.reference.projectId,
          }),
          /read_actor_mismatch/,
        );
        await assert.rejects(
          projects.loadProject({
            owner: {
              tenantId: f.actor.tenantId,
              spaceId: f.actor.spaceId,
              principalId: f.actor.principalId,
            },
            projectId: "foreign-project",
          }),
          /read_target_mismatch/,
        );
        const observation = issuePluginProjectWorkspaceNativeObservation(
          preparation,
          {
            schemaVersion:
              "crewon.desktop-native-project-workspace-response.v1",
            requestId: "named-native-sql-observation",
            outcome: "observed",
            allocation: {
              schemaVersion:
                "crewon.desktop-plugin-project-workspace-allocation-status.v1",
              workspaceId: q.expectedWorkspaceId,
              phase: "registered",
              observation: "registered",
              failureCode: null,
            },
          },
          () => q.assertActive(),
        );
        retained = observation;
        await assert.rejects(
          registration.recordFromNativeObservation(
            { ...observation },
            {
              createdAt: f.namespaceRecipe().createdAt,
            },
          ),
          /native_observation_unavailable/,
        );
        const first = await registration.recordFromNativeObservation(
          observation,
          {
            createdAt: f.namespaceRecipe().createdAt,
          },
        );
        assert.equal(first.disposition, "committed");
        assert.deepEqual(first.namespace.owner, f.namespaceOwner());
        assert.equal(first.namespace.workspaceId, q.expectedWorkspaceId);
        const replay = await registration.recordFromNativeObservation(
          observation,
          {
            createdAt: "2026-10-12T00:00:00.000Z",
          },
        );
        assert.equal(replay.disposition, "replayed");
        assert.deepEqual(replay.namespace, first.namespace);
      };
      const result = (await f.invoke(
        actions.createConversation,
        f.createInput,
      )) as {
        disposition: string;
        binding: { threadId: string; workspaceId: string };
      };
      assert.equal(result.disposition, "committed");
      assert.equal(result.binding.workspaceId, f.createInput.workspaceId);
      assert.equal(f.state.threadPreparations, 1);
      assert.equal(f.state.taskCount, 0);
      assert.ok(retained);
      await assert.rejects(
        registration.recordFromNativeObservation(retained, {
          createdAt: f.namespaceRecipe().createdAt,
        }),
        /unavailable/,
      );
      assert.equal(
        (
          await f.parent.pluginProjectWorkspaceNamespaces().listNamespaces({
            owner: f.namespaceScope,
            afterProjectId: null,
            limit: 16,
          })
        ).namespaces.length,
        1,
      );
    },
  );

for (const mismatch of [
  "actorId",
  "profileId",
  "pluginId",
  "publisherId",
] as const)
  test(
    `postgres: genuine project preparation refuses stored ${mismatch} mismatch before Native observation or Thread creation`,
    {
      skip: !process.env.CREWON_TEST_POSTGRES_URL,
    },
    async (t) => {
      const f = await ownedConversationUiFixture(
        t,
        mismatch,
        "available",
        "nativeIdentity",
        {
          backend: "postgres",
          namespace: "deferred",
        },
      );
      f.state.prepareWorkspace = true;
      let observed = false;
      f.state.onWorkspacePrepared = () => {
        observed = true;
      };
      await assert.rejects(
        f.invoke(actions.createConversation, f.createInput),
        /creative_project_not_found/,
      );
      assert.equal(observed, false);
      assert.equal(f.state.idCount, 0);
      assert.equal(f.state.threadPreparations, 0);
      assert.equal(f.state.taskCount, 0);
    },
  );

test(
  "postgres: independent project policy withdrawn after Host await rejects scoped Native registration before namespace or Thread commit",
  {
    skip: !process.env.CREWON_TEST_POSTGRES_URL,
  },
  async (t) => {
    const f = await ownedConversationUiFixture(
      t,
      "matching",
      "available",
      "nativeIdentity",
      {
        backend: "postgres",
        namespace: "deferred",
      },
    );
    let observed = false;
    f.state.prepareWorkspace = true;
    f.state.onWorkspacePrepared = async (preparation) => {
      const q = qualifyPluginProjectWorkspacePreparation(preparation);
      const observation = issuePluginProjectWorkspaceNativeObservation(
        preparation,
        {
          schemaVersion: "crewon.desktop-native-project-workspace-response.v1",
          requestId: "named-native-last-await-withdrawal",
          outcome: "observed",
          allocation: {
            schemaVersion:
              "crewon.desktop-plugin-project-workspace-allocation-status.v1",
            workspaceId: q.expectedWorkspaceId,
            phase: "registered",
            observation: "registered",
            failureCode: null,
          },
        },
        () => q.assertActive(),
      );
      observed = true;
      f.state.afterHostTransactionCurrent = () => {
        f.state.policyAllowed = false;
      };
      await f.parent
        .pluginProjectWorkspaceNativeRegistrationStore()
        .recordFromNativeObservation(observation, {
          createdAt: f.namespaceRecipe().createdAt,
        });
    };
    await assert.rejects(
      f.invoke(actions.createConversation, f.createInput),
      /creative_project_access_denied/,
    );
    assert.equal(observed, true);
    assert.equal(f.state.threadPreparations, 0);
    assert.equal(f.state.taskCount, 0);
    assert.equal(
      (
        await f.parent.pluginProjectWorkspaceNamespaces().listNamespaces({
          owner: f.namespaceScope,
          afterProjectId: null,
          limit: 16,
        })
      ).namespaces.length,
      0,
    );
  },
);

test(
  "postgres: project state changed by the namespace insert rolls back registration and the trigger write",
  {
    skip: !process.env.CREWON_TEST_POSTGRES_URL,
  },
  async (t) => {
    const f = await ownedConversationUiFixture(
      t,
      "matching",
      "available",
      "nativeIdentity",
      {
        backend: "postgres",
        namespace: "deferred",
      },
    );
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    t.after(() => pool.end());
    await pool.query(`CREATE FUNCTION ${f.prefix}named_native_archive() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN UPDATE ${f.prefix}creative_projects SET state='archived', record_json=jsonb_set(record_json,'{state}','"archived"'::jsonb) WHERE tenant_id=NEW.tenant_id AND space_id=NEW.space_id AND project_id=NEW.project_id; RETURN NEW; END; $$;
    CREATE TRIGGER named_native_archive AFTER INSERT ON ${f.prefix}plugin_project_workspace_namespaces FOR EACH ROW EXECUTE FUNCTION ${f.prefix}named_native_archive();`);
    const registration =
      f.parent.pluginProjectWorkspaceNativeRegistrationStore();
    f.state.prepareWorkspace = true;
    f.state.onWorkspacePrepared = async (preparation) => {
      const q = qualifyPluginProjectWorkspacePreparation(preparation);
      const observation = issuePluginProjectWorkspaceNativeObservation(
        preparation,
        {
          schemaVersion: "crewon.desktop-native-project-workspace-response.v1",
          requestId: "named-native-sql-trigger",
          outcome: "observed",
          allocation: {
            schemaVersion:
              "crewon.desktop-plugin-project-workspace-allocation-status.v1",
            workspaceId: q.expectedWorkspaceId,
            phase: "registered",
            observation: "registered",
            failureCode: null,
          },
        },
        () => q.assertActive(),
      );
      await registration.recordFromNativeObservation(observation, {
        createdAt: f.namespaceRecipe().createdAt,
      });
    };
    await assert.rejects(
      f.invoke(actions.createConversation, f.createInput),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message === "plugin_project_workspace_project_inactive",
    );
    assert.equal(
      (
        await pool.query(
          `SELECT count(*) n FROM ${f.prefix}plugin_project_workspace_namespaces`,
        )
      ).rows[0].n,
      "0",
    );
    assert.equal(
      (
        await pool.query(
          `SELECT state FROM ${f.prefix}creative_projects WHERE project_id=$1`,
          [f.reference.projectId],
        )
      ).rows[0].state,
      "active",
    );
    assert.equal(f.state.threadPreparations, 0);
    assert.equal(f.state.taskCount, 0);
  },
);

for (const withdrawal of ["policy", "host"] as const)
  test(
    `postgres: ${withdrawal} withdrawal after actual Native namespace INSERT rolls back before COMMIT`,
    {
      skip: !process.env.CREWON_TEST_POSTGRES_URL,
    },
    async (t) => {
      const f = await ownedConversationUiFixture(
        t,
        "matching",
        "available",
        "nativeIdentity",
        {
          backend: "postgres",
          namespace: "deferred",
        },
      );
      const descriptor = Object.getOwnPropertyDescriptor(
        Client.prototype,
        "query",
      )!;
      let inserted = 0;
      Object.defineProperty(Client.prototype, "query", {
        ...descriptor,
        value: function (this: Client, ...args: unknown[]) {
          const result = Reflect.apply(descriptor.value, this, args);
          if (
            typeof args[0] !== "string" ||
            !args[0].startsWith(
              `INSERT INTO ${f.prefix}plugin_project_workspace_namespaces(`,
            )
          )
            return result;
          return Promise.resolve(result).then((value) => {
            inserted++;
            if (withdrawal === "policy") f.state.policyAllowed = false;
            else f.state.hostActive = false;
            return value;
          });
        },
      });
      t.after(() =>
        Object.defineProperty(Client.prototype, "query", descriptor),
      );
      f.state.prepareWorkspace = true;
      f.state.onWorkspacePrepared = async (preparation) => {
        const q = qualifyPluginProjectWorkspacePreparation(preparation);
        const observation = issuePluginProjectWorkspaceNativeObservation(
          preparation,
          {
            schemaVersion:
              "crewon.desktop-native-project-workspace-response.v1",
            requestId: "named-native-insert-withdrawal",
            outcome: "observed",
            allocation: {
              schemaVersion:
                "crewon.desktop-plugin-project-workspace-allocation-status.v1",
              workspaceId: q.expectedWorkspaceId,
              phase: "registered",
              observation: "registered",
              failureCode: null,
            },
          },
          () => q.assertActive(),
        );
        await f.parent
          .pluginProjectWorkspaceNativeRegistrationStore()
          .recordFromNativeObservation(observation, {
            createdAt: f.namespaceRecipe().createdAt,
          });
      };
      await assert.rejects(
        f.invoke(actions.createConversation, f.createInput),
        withdrawal === "policy"
          ? /creative_project_access_denied/
          : (error: unknown) =>
              error instanceof Error &&
              error.cause instanceof Error &&
              error.cause.message === "named_host_closed",
      );
      assert.equal(inserted, 1);
      assert.equal(
        (
          await f.parent
            .pluginProjectWorkspaceNamespaces()
            .listNamespaces({
              owner: f.namespaceScope,
              afterProjectId: null,
              limit: 16,
            })
        ).namespaces.length,
        0,
      );
      assert.equal(f.state.threadPreparations, 0);
      assert.equal(f.state.taskCount, 0);
    },
  );
