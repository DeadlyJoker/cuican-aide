import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ProjectMediaGenerationCommands } from "@crewon/media-runtime";
import type { ActorContext, AuthorizationPort } from "@crewon/application";
import { mediaGenerationFixture } from "../../runtime-worker/src/project-media-generation.test-support.ts";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { createInstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { deferred } from "./installed-plugin-task-action-owner.test-support.ts";

// Actual original Core, request owner, Application and SQLite/Pg. Media sources,
// deployment readiness and permission decisions remain named test fixtures.
for (const backend of ["sqlite", "postgres"] as const) {
  for (const scenario of [
    "shutdown",
    "accepted",
    "disabled",
    "invalid-session",
  ] as const)
    test(
      `${backend}: shared media command through original Control Core (${scenario})`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaGenerationFixture(t, backend, { unmetered: true });
        const saved = await f.app.saveInput(f.actor, f.command);
        const command = {
          ...f.mediaQuery(saved.input),
          executionId: "core-lifetime-execution",
          threadId: "media-task-thread",
          expectedThreadRevision: 1,
          idempotencyKey: "core-lifetime-command",
        };
        const activation = await f.ext.loadExtensionActivation({
          ...f.actor,
          pluginId: f.pin.pluginId,
        });
        assert.ok(activation);
        const token = "named-core-media-session-" + "s".repeat(32),
          csrf = "named-core-media-csrf-" + "c".repeat(32),
          origin = "http://127.0.0.1:18479";
        const identity = new StandaloneIdentity({
          actor: f.actor,
          sessionToken: token,
          csrfToken: csrf,
          allowedOrigins: [origin],
        });
        const profiles = {
          resolve: async (actor: ActorContext) => ({
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            profileId: f.pin.profileId,
          }),
        };
        const requests = new InstalledPluginRequestOwner({
          identity: { resolveCurrentActor: (r) => identity.resolveActor(r) },
          profiles,
          peer: {
            prepare: async () => ({
              catalog: {
                list: () => [f.registration],
                resolve: () => f.registration,
              },
              host: {
                taskAdmissionMode: () => "installed" as const,
                validateConfiguration: async () => {},
                evaluate: async () => ({
                  outcome: "ready" as const,
                  target: activation.target!,
                }),
              },
              pluginQueryHost: {
                resolveRegistration: async () => {
                  throw new Error("named-media-query-disabled");
                },
                evaluate: async () => {
                  throw new Error("named-media-query-disabled");
                },
              },
            }),
          },
        });
        const entered = deferred();
        const release = deferred();
        let permissions = 0;
        const businessAuthorization: AuthorizationPort = {
          authorize: async () => {
            permissions++;
            entered.resolve();
            if (scenario === "shutdown") await release.promise;
            return { outcome: "allow" };
          },
        };
        const core = await createInstalledPluginTaskRuntimeCore({
          store: f.parent,
          requests,
          installRoot: f.root,
          maximumPackages: 4,
          ...(scenario === "disabled"
            ? {}
            : {
                projectMediaGenerationStorage: {
                  version:
                    "crewon.project-media-generation-storage.v1" as const,
                },
              }),
          publications: [
            { pluginId: f.pin.pluginId, packageDigest: f.pin.packageDigest },
          ],
          profiles,
          businessAuthorization,
          uiAuthorization: {
            authorize: async () => ({
              outcome: "allow",
              authorityEpoch: f.pin.authorityEpoch,
            }),
          },
          authorizePackage: async () => "allow",
          unmeteredTasks: {
            prepareGeneration: async () => ({
              authorization: {
                authorityId: "named-media-unmetered",
                policyRevision: 1,
              },
              assertCurrent: async () => {},
              assertActive: () => {},
            }),
          },
          clock: f.dependencies.clock,
          ids: { nextId: () => randomUUID() },
          digester: f.digester,
        });
        const commands = new ProjectMediaGenerationCommands({
          profileId: f.pin.profileId,
          preparer: f.issuer,
          tasks: core.extensionTasks,
          extensions: f.ext,
          admissions: { resolve: async () => f.admission() },
        });
        t.after(async () => {
          release.resolve();
          await commands.close();
          await core.close();
          await requests.close();
        });
        const before = await f.countRuns();
        const invoke = () =>
          requests.run(
            {
              request: {
                method: "POST",
                url: "/named-media-core-lifetime-fixture",
                remoteAddress: "127.0.0.1",
                headers: {
                  "authorization": `Bearer ${scenario === "invalid-session" ? "invalid" : token}`,
                  origin,
                  "x-csrf-token": csrf,
                },
              },
              actor: f.actor,
            },
            () =>
              commands.generate(f.actor, command, {
                signal: requests.currentSignal(),
              }),
          );
        if (scenario === "disabled") {
          await assert.rejects(
            invoke(),
            /project_media_generation_unavailable/u,
          );
          assert.equal(permissions, 0);
          assert.deepEqual(await f.countRuns(), before);
          return;
        }
        if (scenario === "invalid-session") {
          await assert.rejects(
            invoke(),
            /installed_plugin_request_authority_unavailable/u,
          );
          assert.equal(f.state.sourceGets, 0);
          assert.equal(f.state.uploads, 0);
          assert.equal(permissions, 0);
          assert.deepEqual(await f.countRuns(), before);
          return;
        }
        if (scenario === "accepted") {
          const accepted = await invoke();
          assert.equal(accepted.run.disposition, "committed");
          const counts = await f.countRuns();
          assert.equal(counts.run_snapshots, before.run_snapshots! + 1);
          assert.equal(
            counts.project_media_generation_links,
            before.project_media_generation_links! + 1,
          );
          const io = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
          const replay = await invoke();
          assert.equal(replay.run.disposition, "replayed");
          assert.deepEqual(replay.binding, accepted.binding);
          assert.deepEqual(await f.countRuns(), counts);
          assert.deepEqual(
            [f.state.sourceGets, f.state.uploads, f.state.targetGets],
            io,
          );
          await core.close();
          await assert.rejects(
            invoke(),
            /installed_plugin_request_authority_unavailable/u,
          );
          assert.deepEqual(await f.countRuns(), counts);
          return;
        }
        const pending = invoke();
        // Attach rejection handling before withdrawing the original Core.
        const rejected = assert.rejects(
          pending,
          /installed_plugin_request_authority_unavailable/u,
        );
        await entered.promise;
        assert.equal(permissions, 1);
        assert.ok(
          f.state.uploads > 0,
          "real preparation preceded the original mutation",
        );
        let closed = false;
        const closing = core.close().then(() => {
          closed = true;
        });
        await setImmediate();
        assert.equal(
          closed,
          false,
          "Core must retain its pending physical mutation",
        );
        release.resolve();
        await rejected;
        await closing;
        assert.equal(closed, true);
        assert.deepEqual(
          await f.countRuns(),
          before,
          "withdrawal cannot admit a Run",
        );
        // Core borrows the parent, so its lifetime does not close unrelated data.
        assert.ok(
          await f.parent.loadThreadInSpace({
            ...f.actor,
            threadId: command.threadId,
          }),
        );
      },
    );
}
