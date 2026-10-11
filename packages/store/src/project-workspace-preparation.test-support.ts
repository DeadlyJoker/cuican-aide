import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { randomUUID, createHash } from "node:crypto";
import {
  PluginUiApplicationService,
  ProjectConversationApplicationService,
  ThreadApplicationService,
  capturePluginUiInvocationCommitAuthority,
  type ActorContext,
  type ProjectConversationCommitAuthority,
  type PluginProjectWorkspacePreparation,
  type PluginProjectWorkspaceNativeObservation,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  parsePluginTaskAdmissionPin,
  pluginProjectWorkspaceIdentityInput,
} from "@crewon/domain";
import {
  parsePluginPackageDescriptor,
  parsePluginUiJsonValue,
  type DesktopNativePluginPackageIdentity,
} from "@crewon/contracts/plugins";
import { preparePluginProjectWorkspace } from "../../application/src/plugin-project-workspace-preparation.ts";
import { committedTaskContext } from "../../application/src/plugin-ui-committed-task-support.ts";
import {
  uiTestDescriptor,
  uiTestBytes,
  uiTestAt,
} from "../../application/src/plugin-ui.test-support.ts";
import { migrateSqlitePluginProjectMetadataOwners } from "./plugin-project-metadata-owner-schema.ts";
import { pluginProjectMetadataOwnerColumns } from "./plugin-project-metadata-owner-records.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import { creationRecipe } from "./creative-project-store.test-support.ts";

/** Original SQLite and genuine UI. Identity/package discovery/Host policy and initial owner record are named fixtures. Host policy and owner record are fixtures; workspace registration uses the original Parent Store facade. */
export async function workspacePreparationUiFixture(
  input: Readonly<{
    actor: ActorContext;
    profileId: string;
    packageIdentity: DesktopNativePluginPackageIdentity;
  }>,
) {
  const { actor, profileId, packageIdentity: identity } = input;
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-native-workspace-registration-"),
  );
  const path = join(directory, "original.sqlite");
  const parent = new SqliteRunStore(path);
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys=ON");
    const projects = parent.creativeProjectStore();
    const installations = parent.pluginInstallationStore();
    await projects.migrate();
    await installations.migrate();
    await parent.migratePluginProjectWorkspaceNamespaces();
    const namespaces = parent.pluginProjectWorkspaceNamespaces();
    const registration = parent.pluginProjectWorkspaceNativeRegistrationStore();
    await parent.extensionStore().migrate();
    await parent.extensionStore().migratePluginAdmissions();
    const conversations = parent.projectConversationStore();
    await conversations.migrate();
    const scope = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      profileId,
    };
    const installed = await installations.recordInstalledPackage(
      installationRecipe("scoped-native-install", {
        actor,
        scope,
        ...identity,
      }),
    );
    await installations.commitSelection(
      selectionRecipe(installed.selection, "scoped-native-enable", { actor }),
    );
    const projectId = "scoped-native-project";
    await projects.commitProjectCreation(
      creationRecipe(projectId, "scoped-native-project", actor),
    );
    database.exec("BEGIN IMMEDIATE");
    migrateSqlitePluginProjectMetadataOwners(database);
    database.exec("COMMIT");
    const owner = {
      ...actor,
      profileId,
      pluginId: identity.pluginId,
      publisherId: identity.publisherId,
      projectId,
    };
    const record = {
      schemaVersion: "crewon.plugin-project-metadata-owner.v1",
      owner,
      createdAt: uiTestAt,
    };
    database
      .prepare(
        `INSERT INTO plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${pluginProjectMetadataOwnerColumns.map(() => "?").join(",")})`,
      )
      .run(
        owner.tenantId,
        owner.spaceId,
        owner.principalId,
        owner.actorId,
        owner.profileId,
        owner.pluginId,
        owner.publisherId,
        owner.projectId,
        uiTestAt,
        JSON.stringify(record),
      );
    const descriptor = parsePluginPackageDescriptor({
      ...uiTestDescriptor,
      pluginId: identity.pluginId,
      publisherId: identity.publisherId,
      version: identity.version,
      requires: [
        {
          service: "crewon.project-conversations",
          apiVersion: "1",
          optional: false,
        },
      ],
    });
    const state = {
      policyAllowed: true,
      afterHostTransaction: null as (() => void | Promise<void>) | null,
      callback: null as
        | ((source: PluginProjectWorkspacePreparation) => Promise<unknown>)
        | null,
    };
    let invocation: Readonly<{
      context: PluginUiActionContext;
      authority: ProjectConversationCommitAuthority;
    }> | null = null;
    const authorization = {
      async authorize() {
        return state.policyAllowed
          ? { outcome: "allow" as const }
          : {
              outcome: "deny" as const,
              reasonCode: "scoped-native-policy-withdrawn",
            };
      },
    };
    const threads = new ThreadApplicationService({
      store: parent,
      authorization: {
        async authorize() {
          return { outcome: "allow" };
        },
      },
      clock: { now: () => uiTestAt },
      ids: { nextId: () => randomUUID() },
      digester: {
        sha256: (value) =>
          `sha256:${createHash("sha256").update(value).digest("hex")}`,
      },
    });
    const conversationApp = new ProjectConversationApplicationService({
      conversations,
      threads,
      threadStore: parent,
      projects,
      texts: parent.projectTextStore(),
      tasks: {
        async createProjectConversationTurnFromHost() {
          throw new Error("no_run_in_native_registration_fixture");
        },
      },
      authorization,
      clock: { now: () => uiTestAt },
      ids: { nextId: () => randomUUID() },
      digester: {
        sha256: (value) =>
          `sha256:${createHash("sha256").update(value).digest("hex")}`,
      },
    });
    const service = new PluginUiApplicationService({
      store: installations,
      profiles: {
        async resolve() {
          return scope;
        },
      },
      authorization: {
        async authorize() {
          return { outcome: "allow", authorityEpoch: "scoped-native-ui-epoch" };
        },
      },
      packages: {
        async verify() {
          return { descriptor, publicAssets: ["ui.mjs"] };
        },
        async readAsset() {
          return {
            bytes: uiTestBytes,
            contentType: "text/javascript; charset=utf-8",
          };
        },
      },
      ids: { nextId: () => randomUUID().replaceAll("-", "").repeat(2) },
      clock: { now: () => uiTestAt },
      actions: {
        async invoke(context) {
          const live = capturePluginUiInvocationCommitAuthority(context),
            snapshot = committedTaskContext(context);
          const authority: ProjectConversationCommitAuthority = {
            version: "crewon.project-conversation-commit.v1",
            actor,
            installation: {
              ...scope,
              ...identity,
              selectionRevision: context.selection.revision,
            },
            selection: context.selection,
            package: context.package,
            pin: parsePluginTaskAdmissionPin({
              ...snapshot.pin,
              action: "project.execute",
            }),
            assertActive: () => live.assertActive(),
            assertCurrent: () => live.assertCurrent(),
            assertTransactionCurrent: async () => {
              await live.assertCurrent();
              await state.afterHostTransaction?.();
            },
          };
          const preparation = await preparePluginProjectWorkspace({
            context,
            authority,
            projects,
            authorization: {
              async authorize() {
                return state.policyAllowed
                  ? { outcome: "allow" }
                  : {
                      outcome: "deny",
                      reasonCode: "scoped-native-policy-withdrawn",
                    };
              },
            },
          });
          const previousInvocation = invocation;
          invocation = { context, authority };
          try {
            return parsePluginUiJsonValue(await state.callback!(preparation));
          } finally {
            invocation = previousInvocation;
          }
        },
      },
    });
    const lease = await service.openMount(actor, {
      pluginId: identity.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: 2,
      expectedPackageDigest: identity.packageDigest,
    });
    return {
      state,
      namespaces,
      createConversation: (
        reference: PluginProjectWorkspaceNativeObservation,
      ) => {
        if (invocation === null)
          throw new Error("fixture_invocation_unavailable");
        return conversationApp.createConversationFromNativeObservation({
          ...invocation,
          observation: reference,
          registration,
        });
      },
      async rejectOtherInvocation(
        reference: PluginProjectWorkspaceNativeObservation,
      ) {
        const previousCallback = state.callback;
        state.callback = async () => {
          if (invocation === null)
            throw new Error("fixture_invocation_unavailable");
          return conversationApp.createConversationFromNativeObservation({
            ...invocation,
            observation: reference,
            registration,
          });
        };
        try {
          await service.invoke(actor, {
            mountRef: lease.mountRef,
            action: "crewon.project-conversations.v1.createConversation",
            input: {
              projectId,
              workspaceId: `workspace-project-${createHash("sha256").update(pluginProjectWorkspaceIdentityInput(owner)).digest("hex")}`,
              title: "another invocation",
              idempotencyKey: "another-native-conversation",
            },
          });
          return false;
        } catch (error) {
          return (
            error instanceof Error &&
            error.message ===
              "project_conversation_native_workspace_source_mismatch"
          );
        } finally {
          state.callback = previousCallback;
        }
      },
      async rejectRegistrationGetter(
        reference: PluginProjectWorkspaceNativeObservation,
      ) {
        if (invocation === null)
          throw new Error("fixture_invocation_unavailable");
        let read = false;
        try {
          await conversationApp.createConversationFromNativeObservation({
            ...invocation,
            observation: reference,
            registration: {
              get recordFromNativeObservation(): typeof registration.recordFromNativeObservation {
                read = true;
                throw new Error("getter must not execute");
              },
            },
          });
          return false;
        } catch (error) {
          return (
            !read &&
            error instanceof Error &&
            error.message ===
              "project_conversation_native_workspace_registration_unavailable"
          );
        }
      },
      threadCount: () =>
        Number(database.prepare("SELECT COUNT(*) AS n FROM threads").get()!.n),
      projectState: () =>
        String(
          database
            .prepare("SELECT state FROM creative_projects WHERE project_id=?")
            .get(projectId)!.state,
        ),
      mutateRegistrationFixture(mode: string) {
        if (mode === "sqlArchive")
          database.exec(
            "CREATE TRIGGER fixture_namespace_archive AFTER INSERT ON plugin_project_workspace_namespaces BEGIN UPDATE creative_projects SET state='archived', record_json=json_set(record_json,'$.state','archived') WHERE project_id='scoped-native-project'; END",
          );
        if (mode === "archive")
          database
            .prepare(
              "UPDATE creative_projects SET state='archived', record_json=json_set(record_json,'$.state','archived') WHERE project_id=?",
            )
            .run(projectId);
        else if (mode === "schema")
          database.exec("DROP TABLE plugin_project_workspace_schema_version");
        else if (mode === "lastAwait")
          state.afterHostTransaction = () => {
            state.policyAllowed = false;
          };
        else if (mode === "policy") state.policyAllowed = false;
      },
      namespaceCount: () =>
        Number(
          database
            .prepare(
              "SELECT COUNT(*) AS n FROM plugin_project_workspace_namespaces",
            )
            .get()!.n,
        ),
      recordObservation: (
        reference: PluginProjectWorkspaceNativeObservation,
        createdAt = uiTestAt,
      ) => registration.recordFromNativeObservation(reference, { createdAt }),
      async invoke() {
        return service.invoke(actor, {
          mountRef: lease.mountRef,
          action: "crewon.project-conversations.v1.createConversation",
          input: {
            projectId,
            workspaceId: `workspace-project-${createHash("sha256").update(pluginProjectWorkspaceIdentityInput(owner)).digest("hex")}`,
            title: null,
            idempotencyKey: "scoped-native-preparation",
          },
        });
      },
      async close() {
        database.close();
        await parent.close();
        rmSync(directory, { recursive: true });
      },
    };
  } catch (error) {
    database.close();
    await parent.close();
    rmSync(directory, { recursive: true });
    throw error;
  }
}
