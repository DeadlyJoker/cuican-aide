import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ControlApiClient } from "../../../packages/control-client/src/index.ts";
import {
  restoreDesktopNativePluginBusinessActivations,
  setDesktopPluginSelectionWithNativeBusinessActivation,
} from "../../crewon-ui/electron/desktopNativePluginBusinessActivation.ts";
import {
  parseGetPluginSelectionResponse,
  parsePluginSelectionResponse,
} from "@crewon/contracts";
import {
  INSTALLED_PLUGIN_PEER_PRIVATE_PATH,
  INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  parseInstalledPluginPeerRequest,
} from "@crewon/contracts/plugins";
import { startDesktopInstalledPluginRuntimeChildren } from "../../crewon-ui/electron/desktopInstalledPluginRuntimeChildren.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "../../crewon-ui/electron/desktopExtensionRuntime.ts";
import { nativeLocalProcessFixture } from "./installed-plugin-native-process.integration.test-support.ts";
import { candidateSideEffectCounts } from "./installed-plugin-candidate.test-support.ts";

for (const variant of [
  { label: "source", runtimeDirectory: undefined, skip: false, cold: false },
  {
    label: "packaged",
    runtimeDirectory: process.env.CREWON_TEST_NATIVE_PACKAGED_RUNTIME_DIR,
    skip: process.env.CREWON_TEST_NATIVE_PACKAGED_RUNTIME_DIR === undefined,
    cold: false,
  },
  ...(process.env.CREWON_TEST_NATIVE_COLD_RECOVERY === "1"
    ? [
        {
          label: "source-cold",
          runtimeDirectory: undefined,
          skip: false,
          cold: true,
        },
        {
          label: "packaged-cold",
          runtimeDirectory: process.env.CREWON_TEST_NATIVE_PACKAGED_RUNTIME_DIR,
          skip:
            process.env.CREWON_TEST_NATIVE_PACKAGED_RUNTIME_DIR === undefined,
          cold: true,
        },
      ]
    : []),
])
  test(
    `${variant.label}: genuine Main Native policy prepares and publishes a real installed Krea package then challenges its actual Worker and reads actual Control without remote policy, credits or inference`,
    { timeout: 60000, skip: variant.skip },
    async (t) => {
      const f = await nativeLocalProcessFixture(t, {
        packagedRuntimeDirectory: variant.runtimeDirectory,
        projectSourceDirectory:
          process.env.CREWON_TEST_NATIVE_PROJECT_READINESS === "1"
            ? process.env.CREWON_TEST_SHORT_DRAMA_PLUGIN_DIR
            : undefined,
      });
      const prepared = await f.runRelease(f.owner.preparationEnvironment);
      assert.equal(JSON.parse(prepared.trim()).pluginCount, 1);
      let completed = f.owner.complete();
      assert.equal(completed.kind, "installed");
      if (completed.kind !== "installed") return;
      assert.equal(completed.statuses[0]!.state, "prepared");
      const released = await f.runRelease(completed.runtime.release);
      assert.ok(released.includes("activated"), released);
      if (f.projectSource !== null) {
        const projectOwner = await f.prepareProjectBridge(
          completed.runtime.expectedCatalogEntries[0]!,
        );
        await f.runRelease(projectOwner.preparationEnvironment);
        completed = projectOwner.complete();
        assert.equal(completed.kind, "installed");
        if (completed.kind !== "installed") return;
        await f.runRelease(completed.runtime.release);
      }
      assert.deepEqual(
        await f.store.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId: f.environment.CREWON_AGENT_VERSION_ID!,
        }),
        f.originalDefaultVersion,
        "publishing plugin capability must retain the original default Agent version",
      );
      const current = await startDesktopInstalledPluginRuntimeChildren({
        runtime: completed.runtime,
        signal: new AbortController().signal,
        spawnWorker: (environment) => f.start("worker", environment),
        spawnControl: (environment) => f.start("control", environment),
        trackChild: () => {},
        deadlineMs: 20000,
      });
      assert.equal(current.worker.exitCode, null);
      assert.ok(
        f
          .logs(current.worker)
          .stdout.includes("CrewON Installed Plugin Peer origin"),
      );
      await f.waitForControl(current.control);
      const clientConfig = {
        baseUrl: `http://127.0.0.1:${f.port}/`,
        accessToken: f.sessionToken,
        csrfToken: f.environment.CREWON_CONTROL_CSRF_TOKEN!,
        origin: f.environment.CREWON_CONTROL_ORIGIN!,
      };
      const client = new ControlApiClient(clientConfig);
      const signal = new AbortController().signal;
      const createThread = async (
        workspaceId: string,
        idempotencyKey: string,
      ) => {
        const response = await fetch(
          `http://127.0.0.1:${f.port}/api/v1/threads`,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(5000),
            headers: {
              "authorization": `Bearer ${f.sessionToken}`,
              "origin": f.environment.CREWON_CONTROL_ORIGIN!,
              "x-csrf-token": f.environment.CREWON_CONTROL_CSRF_TOKEN!,
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify({
              title: "Native workspace ownership regression",
              workspaceId,
            }),
          },
        );
        const body = await response.text();
        assert.equal(response.status, 201, body);
        const result = JSON.parse(body) as {
          thread: { threadId: string; workspaceId: string };
        };
        assert.equal(result.thread.workspaceId, workspaceId);
        return result.thread;
      };
      const firstThread = await createThread(
        f.firstWorkspace.workspaceId,
        "native-workspace-first-thread",
      );
      f.workspaceAuthority.activate(f.secondWorkspace.workspaceId, {
        expectedRevision: f.workspaceAuthority.status().revision,
        idempotencyKey: "native-workspace-second-active",
      });
      const secondThread = await createThread(
        f.secondWorkspace.workspaceId,
        "native-workspace-second-thread",
      );
      assert.notEqual(firstThread.workspaceId, secondThread.workspaceId);
      const originalThread = await fetch(
        `http://127.0.0.1:${f.port}/api/v1/threads/${firstThread.threadId}`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: {
            authorization: `Bearer ${f.sessionToken}`,
            origin: f.environment.CREWON_CONTROL_ORIGIN!,
          },
        },
      );
      const originalBody = await originalThread.text();
      assert.equal(originalThread.status, 200, originalBody);
      assert.equal(
        JSON.parse(originalBody).thread.workspaceId,
        f.firstWorkspace.workspaceId,
      );
      assert.equal(
        f.workspaceAuthority.root(f.firstWorkspace.workspaceId),
        f.workspaceRoots[0],
      );
      assert.deepEqual(
        await f.store.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId: f.environment.CREWON_AGENT_VERSION_ID!,
        }),
        f.originalDefaultVersion,
        "workspace activation must retain the original default Agent version",
      );
      assert.equal(current.worker.exitCode, null);
      assert.equal(current.control.exitCode, null);
      const response = await fetch(
        `http://127.0.0.1:${f.port}/api/v1/plugins/selections/${f.identity.pluginId}`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: {
            authorization: `Bearer ${f.sessionToken}`,
            origin: f.environment.CREWON_CONTROL_ORIGIN!,
          },
        },
      );
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const loaded = parseGetPluginSelectionResponse(JSON.parse(body), {
        pluginId: f.identity.pluginId,
      });
      assert.equal(loaded.selection?.state, "disabled");
      assert.equal(
        loaded.selection?.selectedPackageDigest,
        f.identity.packageDigest,
      );
      const selected = await f.store
        .pluginInstallationStore()
        .loadSelection({ scope: f.scope, pluginId: f.identity.pluginId });
      assert.equal(selected?.state, "disabled");
      if (process.env.CREWON_TEST_NATIVE_ENABLE_SELECTION === "1") {
        assert.ok(loaded.selection);
        const before = candidateSideEffectCounts(f.databasePath);
        const request = {
          expectedSelectionRevision: loaded.selection.revision,
          state: "enabled" as const,
          selectedPackageDigest: f.identity.packageDigest,
        };
        const command = {
          pluginId: f.identity.pluginId,
          request,
          idempotencyKey: "native-real-enable",
        };
        if (!variant.cold) {
          let activationConnectionFailed = false;
          const disconnectedOnce = new ControlApiClient({
            ...clientConfig,
            fetch: async (...arguments_) => {
              const url = new URL(String(arguments_[0]));
              if (
                !activationConnectionFailed &&
                arguments_[1]?.method === "PUT" &&
                url.pathname ===
                  `/api/v1/extensions/${f.identity.pluginId}/activation`
              ) {
                activationConnectionFailed = true;
                throw new TypeError("Owned Main activation connection failure");
              }
              return fetch(...arguments_);
            },
          });
          await assert.rejects(
            setDesktopPluginSelectionWithNativeBusinessActivation({
              runtime: completed.runtime,
              client: disconnectedOnce,
              command,
              signal,
            }),
            { message: "desktop_native_plugin_business_activation_failed" },
          );
          assert.equal(activationConnectionFailed, true);
          assert.equal(
            (await client.plugins.getSelection(f.identity.pluginId)).selection
              ?.revision,
            request.expectedSelectionRevision + 1,
          );
          assert.equal(
            (await client.getExtensionActivation(f.identity.pluginId))
              .activation,
            null,
          );
        }
        const result = variant.cold
          ? await client.plugins.setSelection(
              command.pluginId,
              command.request,
              command.idempotencyKey,
            )
          : await setDesktopPluginSelectionWithNativeBusinessActivation({
              runtime: completed.runtime,
              client,
              command,
              signal,
            });
        assert.equal(
          result.mutation.disposition,
          variant.cold ? "committed" : "replayed",
        );
        assert.equal(
          result.mutation.selection.revision,
          request.expectedSelectionRevision + 1,
        );
        if (variant.cold) {
          assert.equal(
            (await client.getExtensionActivation(f.identity.pluginId))
              .activation,
            null,
          );
          assert.deepEqual(
            await restoreDesktopNativePluginBusinessActivations({
              runtime: completed.runtime,
              client,
              signal,
            }),
            [],
          );
        }
        const activeBusiness = (
          await client.getExtensionActivation(f.identity.pluginId)
        ).activation;
        assert.equal(activeBusiness?.state, "enabled");
        assert.deepEqual(
          activeBusiness?.target,
          completed.runtime.expectedCatalogEntries[0]!.configuredTarget,
        );
        assert.deepEqual(
          await restoreDesktopNativePluginBusinessActivations({
            runtime: completed.runtime,
            client,
            signal,
          }),
          [],
        );
        assert.deepEqual(
          (await client.getExtensionActivation(f.identity.pluginId)).activation,
          activeBusiness,
          "matching cold recovery must not create another activation revision",
        );
        assert.equal(
          (await client.plugins.getSelection(f.identity.pluginId)).selection
            ?.revision,
          result.mutation.selection.revision,
          "cold recovery must not change package selection revision",
        );
        assert.equal(result.mutation.selection.state, "enabled");
        assert.equal(
          result.projection.outcome,
          variant.cold ? "applied" : "unchanged",
        );
        assert.equal(
          (
            await f.store
              .pluginInstallationStore()
              .loadSelection({ scope: f.scope, pluginId: f.identity.pluginId })
          )?.state,
          "enabled",
        );
        if (f.projectSource !== null) {
          const post = async (path: string, input: object, key?: string) => {
            const response = await fetch(`http://127.0.0.1:${f.port}${path}`, {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(10000),
              headers: {
                "authorization": `Bearer ${f.sessionToken}`,
                "origin": f.environment.CREWON_CONTROL_ORIGIN!,
                "x-csrf-token": f.environment.CREWON_CONTROL_CSRF_TOKEN!,
                "content-type": "application/json",
                ...(key === undefined ? {} : { "idempotency-key": key }),
              },
              body: JSON.stringify(input),
            });
            const body = await response.text();
            assert.equal(response.status, 200, body);
            return JSON.parse(body);
          };
          const source = f.projectSource.identity;
          const enableSourceRequest = {
            expectedSelectionRevision: 1,
            state: "enabled" as const,
            selectedPackageDigest: source.packageDigest,
          };
          const sourceSelection =
            await setDesktopPluginSelectionWithNativeBusinessActivation({
              runtime: completed.runtime,
              client,
              command: {
                pluginId: source.pluginId,
                request: enableSourceRequest,
                idempotencyKey: "native-real-short-drama-enable",
              },
              signal,
            });
          assert.equal(
            await f.store.extensionStore().loadExtensionActivation({
              ...f.scope,
              pluginId: source.pluginId,
            }),
            null,
            "UI-only source must not receive a business activation",
          );
          const lease = await post("/api/v1/plugins/ui/mounts", {
            pluginId: source.pluginId,
            contributionId: "workbench",
            expectedSelectionRevision:
              sourceSelection.mutation.selection.revision,
            expectedPackageDigest: source.packageDigest,
          });
          const invoke = async (action: string, input: object) =>
            (
              await post(
                `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
                { action, input },
              )
            ).output;
          const project = await invoke(
            "crewon.creative-projects.v1.createProject",
            {
              request: {
                title: "Actual Native project bridge",
                briefText: "Metadata-only readiness regression",
              },
              idempotencyKey: "native-project-create",
            },
          );
          const concept = await invoke(
            "crewon.creative-projects.v1.createConcept",
            {
              projectId: project.project.projectId,
              request: {
                briefRevision: project.brief.briefRevision,
                name: "Actual Native concept",
                prompt: "A quiet garden in morning light",
                expectedProjectRevision: project.project.revision,
              },
              idempotencyKey: "native-concept-create",
            },
          );
          const reference = {
            projectId: project.project.projectId,
            assetId: concept.asset.assetId,
            assetRevision: concept.assetRevision.assetRevision,
            expectedProjectRevision: concept.project.revision,
            expectedAssetMetadataRevision: concept.asset.revision,
          };
          const targetSelection = await f.store
            .pluginInstallationStore()
            .loadSelection({ scope: f.scope, pluginId: f.identity.pluginId });
          assert.equal(targetSelection?.state, "enabled");
          const legacyActivation = await f.store
            .extensionStore()
            .loadExtensionActivation({
              tenantId: f.scope.tenantId,
              spaceId: f.scope.spaceId,
              pluginId: f.identity.pluginId,
            });
          assert.equal(legacyActivation?.state, "enabled");
          const readiness = await invoke(
            "crewon.project-generation-contexts.v1.getReadiness",
            { reference },
          );
          assert.deepEqual(readiness, {
            reference,
            readiness: { outcome: "ready" },
          });
          assert.equal(f.projectSource.descriptor.entrypoints.node, null);
          const hydrated = await invoke(
            "crewon.creative-projects.v1.getConceptRevision",
            {
              projectId: reference.projectId,
              assetId: reference.assetId,
              assetRevision: reference.assetRevision,
            },
          );
          assert.equal(
            hydrated.assetRevision.prompt,
            "A quiet garden in morning light",
          );
        }
        const disableRequest = {
          expectedSelectionRevision: result.mutation.selection.revision,
          state: "disabled" as const,
          selectedPackageDigest: f.identity.packageDigest,
        };
        const disabled =
          await setDesktopPluginSelectionWithNativeBusinessActivation({
            runtime: completed.runtime,
            client,
            command: {
              pluginId: f.identity.pluginId,
              request: disableRequest,
              idempotencyKey: "native-real-disable",
            },
            signal,
          });
        assert.equal(disabled.mutation.selection.state, "disabled");
        assert.equal(disabled.projection.outcome, "applied");
        const disabledBusiness = (
          await client.getExtensionActivation(f.identity.pluginId)
        ).activation;
        assert.equal(disabledBusiness?.state, "disabled");
        assert.equal(disabledBusiness.target, null);
        const enabledPackageAgain = await client.plugins.setSelection(
          f.identity.pluginId,
          {
            expectedSelectionRevision: disabled.mutation.selection.revision,
            state: "enabled",
            selectedPackageDigest: f.identity.packageDigest,
          },
          "native-cold-preserve-business-disabled",
        );
        assert.deepEqual(
          await restoreDesktopNativePluginBusinessActivations({
            runtime: completed.runtime,
            client,
            signal,
          }),
          [],
        );
        assert.deepEqual(
          (await client.getExtensionActivation(f.identity.pluginId)).activation,
          disabledBusiness,
          "cold recovery must not undo explicit business disable",
        );
        const revokedBusiness = await client.setExtensionActivation(
          f.identity.pluginId,
          {
            configurationRevision: f.configuration.revision,
            expectedRevision: disabledBusiness.revision,
            state: "revoked",
            agentVersionId: null,
          },
          "native-original-business-revocation",
        );
        await setDesktopPluginSelectionWithNativeBusinessActivation({
          runtime: completed.runtime,
          client,
          command: {
            pluginId: f.identity.pluginId,
            request: {
              ...disableRequest,
              expectedSelectionRevision:
                enabledPackageAgain.mutation.selection.revision,
            },
            idempotencyKey: "native-final-disable",
          },
          signal,
        });
        assert.deepEqual(
          (await client.getExtensionActivation(f.identity.pluginId)).activation,
          revokedBusiness.activation,
          "package disable must preserve business revocation",
        );
        assert.equal(
          (
            await f.store
              .pluginInstallationStore()
              .loadSelection({ scope: f.scope, pluginId: f.identity.pluginId })
          )?.state,
          "disabled",
        );
        const after = candidateSideEffectCounts(f.databasePath);
        for (const table of [
          "run_snapshots",
          "extension_run_bindings",
          "extension_external_operations",
          "extension_credit_admissions",
          "plugin_credit_accounts",
          "plugin_credit_entries",
          "plugin_credit_reservations",
        ])
          assert.equal(
            after[table],
            before[table],
            `enable/disable must not create ${table}`,
          );
      }
      assert.ok(
        (await f.audit()).every((row) =>
          row.origin.startsWith("http://127.0.0.1:"),
        ),
        "metadata startup must not request a model or supplier",
      );
      const latest = await f.store
        .extensionStore()
        .loadLatestExtensionConfiguration({
          ...f.scope,
          pluginId: f.identity.pluginId,
        });
      assert.deepEqual(latest, f.configuration);
      const peerOrigin =
        /CrewON Installed Plugin Peer origin (http:\/\/127\.0\.0\.1:[0-9]+)/u.exec(
          f.logs(current.worker).stdout,
        )?.[1];
      assert.ok(peerOrigin);
      const token = completed.runtime.token;
      const peerCatalog = () =>
        fetch(`${peerOrigin}${INSTALLED_PLUGIN_PEER_PRIVATE_PATH}`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: {
            "authorization": `Bearer ${token}`,
            "content-type": "application/json",
            "accept": "application/json",
          },
          body: JSON.stringify(
            parseInstalledPluginPeerRequest({
              protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
              requestId: randomUUID(),
              operation: "catalog",
              actor,
              scope: f.scope,
            }),
          ),
        });
      const beforeWithdrawal = await peerCatalog();
      assert.equal(beforeWithdrawal.status, 200, await beforeWithdrawal.text());
      f.owner.withdraw();
      assert.equal(
        current.worker.exitCode,
        null,
        "withdrawal must deny a still-alive child before termination",
      );
      const withdrawn = await peerCatalog();
      assert.notEqual(withdrawn.status, 200, await withdrawn.text());
      assert.equal(current.worker.exitCode, null);
    },
  );

for (const variant of [
  { label: "source", runtimeDirectory: undefined, skip: false },
  {
    label: "packaged",
    runtimeDirectory: process.env.CREWON_TEST_NATIVE_PACKAGED_RUNTIME_DIR,
    skip: process.env.CREWON_TEST_NATIVE_PACKAGED_RUNTIME_DIR === undefined,
  },
])
  test(
    `${variant.label}: genuine all-unprepared Native policy rejects enable without hiding original package withdrawal`,
    { timeout: 60000, skip: variant.skip },
    async (t) => {
      const f = await nativeLocalProcessFixture(t, {
        saveConfiguration: false,
        packagedRuntimeDirectory: variant.runtimeDirectory,
      });
      await f.runRelease(f.owner.preparationEnvironment);
      const completed = f.owner.complete();
      assert.equal(completed.kind, "default");
      if (completed.kind !== "default") return;
      assert.equal(completed.statuses[0]!.state, "blocked");
      const control = f.start(
        "control",
        completed.environments.sharedEnvironment,
      );
      await f.waitForControl(control);
      const client = new ControlApiClient({
        baseUrl: `http://127.0.0.1:${f.port}/`,
        accessToken: f.sessionToken,
        csrfToken: f.environment.CREWON_CONTROL_CSRF_TOKEN!,
        origin: f.environment.CREWON_CONTROL_ORIGIN!,
      });
      const signal = new AbortController().signal;
      const initial = (await client.plugins.getSelection(f.identity.pluginId))
        .selection!;
      await assert.rejects(
        setDesktopPluginSelectionWithNativeBusinessActivation({
          runtime: null,
          nativePreparation: f.owner,
          client,
          signal,
          command: {
            pluginId: f.identity.pluginId,
            request: {
              expectedSelectionRevision: initial.revision,
              state: "enabled",
              selectedPackageDigest: f.identity.packageDigest,
            },
            idempotencyKey: "native-unprepared-enable-denied",
          },
        }),
        { message: "desktop_native_plugin_business_runtime_unprepared" },
      );
      assert.deepEqual(
        (await client.plugins.getSelection(f.identity.pluginId)).selection,
        initial,
      );
      const disabled =
        await setDesktopPluginSelectionWithNativeBusinessActivation({
          runtime: null,
          nativePreparation: f.owner,
          client,
          signal,
          command: {
            pluginId: f.identity.pluginId,
            request: {
              expectedSelectionRevision: initial.revision,
              state: "disabled",
              selectedPackageDigest: f.identity.packageDigest,
            },
            idempotencyKey: "native-unprepared-disable",
          },
        });
      assert.equal(disabled.mutation.selection.state, "disabled");
      const removed =
        await setDesktopPluginSelectionWithNativeBusinessActivation({
          runtime: null,
          nativePreparation: f.owner,
          client,
          signal,
          command: {
            pluginId: f.identity.pluginId,
            request: {
              expectedSelectionRevision: disabled.mutation.selection.revision,
              state: "uninstalled",
              selectedPackageDigest: null,
            },
            idempotencyKey: "native-unprepared-uninstall",
          },
        });
      assert.equal(removed.mutation.selection.state, "uninstalled");
      const counts = candidateSideEffectCounts(f.databasePath);
      assert.equal(counts.run_snapshots, 0);
      assert.equal(counts.extension_external_operations, 0);
      assert.ok(
        (await f.audit()).every((row) =>
          row.origin.startsWith("http://127.0.0.1:"),
        ),
      );
    },
  );
