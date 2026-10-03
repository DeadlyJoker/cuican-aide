import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { automaticPreparationDirectories } from "./desktopInstalledPluginRuntime.automatic.process.test-support.ts";
import {
  activationDirectories,
  activationSnapshot,
  assertActivationNoPluginExecution,
  businessActivate,
  moduleEnable,
  nativeActivationProcessFixture,
  selection,
  type NativeActivationFixture,
} from "./desktopInstalledPluginRuntime.activation.process.test-support.ts";
import {
  assertIsolationTaskRoutesUnavailable,
  isolationActivePublication,
  runIsolationDefaultAgent,
} from "./desktopInstalledPluginRuntime.fault-isolation.test-support.ts";
import {
  closeNativeProcessFixture,
  nativeBootstrapFiles,
  nativeProcessFacts,
  nativeProcessHttp,
  type NativeInstalledProcessFixtureOptions,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";

const professionalDirectory =
  process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
const kreaDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
const enabled =
  professionalDirectory !== undefined && kreaDirectory !== undefined;
const krea = "crewon.comfyui-krea2",
  professional = "example.professional";
const fixture = (
  network: "public" | "private" | "missing" = "public",
  options: NativeInstalledProcessFixtureOptions = {},
) =>
  nativeActivationProcessFixture(
    {
      professionalDirectory: professionalDirectory!,
      kreaDirectory: kreaDirectory!,
      network,
    },
    options,
  );
async function activation(f: NativeActivationFixture, pluginId = krea) {
  const response = await nativeProcessHttp(
    f.runtime.session(),
    "GET",
    `/api/v1/extensions/${pluginId}/activation`,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).activation;
}
async function assertDefault(f: NativeActivationFixture) {
  const publication = await isolationActivePublication(f);
  await runIsolationDefaultAgent(
    f,
    f.runtime.session(),
    publication.active.bundle.defaultAgentVersionId,
  );
  await assertIsolationTaskRoutesUnavailable(f, f.runtime.session());
  await assertActivationNoPluginExecution(f, true);
}
async function assertDisabled(f: NativeActivationFixture, revision = 1) {
  expect(await selection(f, krea)).toEqual({
    ...f.installed[1]!.selection,
    revision,
  });
  expect(await activation(f)).toBe(null);
  expect(nativeProcessFacts(f.databasePath).counts.extension_activations).toBe(
    0,
  );
  await assertActivationNoPluginExecution(f);
}

it.runIf(enabled)(
  "actual explicit Native v3 enables real disabled Krea and professional modules before original activation CAS and replay, and restores saved activation through restart without dispatch or funds",
  async () => {
    // Two real plugins, replay and restart retain every actual actor/profile check.
    const f = await fixture("public", { authorityRequestAuditLimit: 2048 });
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      await assertDisabled(f);
      const premature = await businessActivate(f, krea, {
        key: "native-v3-business-activation-before-module-enable",
      });
      expect(premature.status, await premature.clone().text()).not.toBe(200);
      await assertDisabled(f);
      for (const pluginId of [professional, krea]) {
        const source = f.sources.find((value) => value.pluginId === pluginId)!;
        const response = await moduleEnable(f, pluginId);
        expect(response.status, await response.clone().text()).toBe(200);
        const committed = await response.json();
        expect(committed.mutation.disposition).toBe("committed");
        expect(committed.mutation.selection.state).toBe("enabled");
        expect(committed.mutation.selection.revision).toBe(2);
        expect(committed.mutation.selection.selectedPackageDigest).toBe(
          source.packageDigest,
        );
        expect(await activation(f, pluginId)).toBe(null);
        const repeat = await moduleEnable(f, pluginId);
        expect(repeat.status, await repeat.clone().text()).toBe(200);
        expect((await repeat.json()).mutation).toEqual({
          ...committed.mutation,
          disposition: "replayed",
        });
        expect(await selection(f, pluginId)).toEqual(
          committed.mutation.selection,
        );
        const wrongTarget = await businessActivate(f, pluginId, {
          agentVersionId: f.preparation.document.defaultAgentVersionId,
          key: `native-v3-wrong-published-target-${pluginId}`,
        });
        expect(wrongTarget.status, await wrongTarget.clone().text()).toBe(409);
        expect(await activation(f, pluginId)).toBe(null);
        const active = await businessActivate(f, pluginId);
        expect(active.status, await active.clone().text()).toBe(200);
        const applied = await active.json();
        const entry = f.preparation.document.entries.find(
          ({ packageIdentity }) => packageIdentity.pluginId === pluginId,
        )!;
        expect(applied.disposition).toBe("updated");
        expect(applied.activation.state).toBe("enabled");
        expect(applied.activation.revision).toBe(1);
        expect(applied.activation.configurationDigest).toBe(
          entry.configuration.contentDigest,
        );
        expect(applied.activation.target).toEqual(entry.target);
        expect(applied.activation.updatedByActorId).toBe(
          f.preparation.result.actor.actorId,
        );
        const replay = await businessActivate(f, pluginId);
        expect(replay.status, await replay.clone().text()).toBe(200);
        expect(await replay.json()).toEqual({
          ...applied,
          disposition: "replayed",
        });
      }
      expect(
        nativeProcessFacts(f.databasePath).counts.extension_activations,
      ).toBe(2);
      expect(
        f.authority.requests.some(({ path }) => path === "/activate"),
      ).toBe(true);
      expect(f.authority.requests.some(({ path }) => path === "/network")).toBe(
        true,
      );
      await assertActivationNoPluginExecution(f);
      const saved = await activation(f);
      await f.runtime.stop();
      for (const pid of [f.controlPid, f.workerPid])
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      expect(await activationDirectories(f.dataDirectory)).toEqual([]);
      expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
        [],
      );
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
      const replacement = await f.start();
      expect(replacement.activation.directory).not.toBe(f.activation.directory);
      expect(replacement.preparation.document).toEqual(f.preparation.document);
      expect(await activation(f)).toEqual(saved);
      expect((await selection(f, krea)).revision).toBe(2);
      const replayAfterRestart = await businessActivate(f, krea);
      expect(
        replayAfterRestart.status,
        await replayAfterRestart.clone().text(),
      ).toBe(200);
      expect((await replayAfterRestart.json()).disposition).toBe("replayed");
      f.authority.denyNetwork();
      const withdrawn = await businessActivate(f, krea, {
        state: "revoked",
        expectedRevision: 1,
        key: "native-v3-withdraw-after-network-revocation",
      });
      expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
      const value = await withdrawn.json();
      expect(value.activation.state).toBe("revoked");
      expect(value.activation.revision).toBe(2);
      expect(value.activation.target).toBe(null);
      const disable = await nativeProcessHttp(
        f.runtime.session(),
        "PUT",
        `/api/v1/plugins/selections/${krea}`,
        {
          state: "disabled",
          selectedPackageDigest: f.sources[1]!.packageDigest,
          expectedSelectionRevision: 2,
        },
        "native-v3-module-withdrawal",
      );
      expect(disable.status, await disable.clone().text()).toBe(200);
      expect((await selection(f, krea)).state).toBe("disabled");
      await assertDefault(f);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await closeNativeProcessFixture(f, failure);
    }
  },
  120_000,
);

for (const missing of ["missing", "private"] as const)
  it.runIf(enabled)(
    `actual Native v3 ${missing} IO candidate cannot commit enabled selection or business activation and leaves original default SSE usable`,
    async () => {
      const f = await fixture(missing);
      let failure: Readonly<{ error: unknown }> | undefined;
      try {
        const response = await moduleEnable(f, krea);
        expect(response.status, await response.clone().text()).toBe(409);
        expect((await response.json()).error.code).toBe(
          "extension_runtime_unavailable",
        );
        await assertDisabled(f);
        await assertDefault(f);
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        await closeNativeProcessFixture(f, failure);
      }
    },
    90_000,
  );

it.runIf(enabled)(
  "actual explicit activation policy withdrawal denies Native module enable before installed Node import despite intact management configuration permissions",
  async () => {
    const f = await fixture();
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      f.authority.denyActivation();
      const response = await moduleEnable(f, krea);
      expect(response.status, await response.clone().text()).toBe(403);
      await f.assertNoNodeImports();
      await assertDisabled(f);
      const config = await nativeProcessHttp(
        f.runtime.session(),
        "GET",
        `/api/v1/extensions/${krea}/configuration`,
      );
      expect(config.status).toBe(200);
      expect((await config.json()).configuration).toEqual(f.configurations[1]);
      await assertDefault(f);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await closeNativeProcessFixture(f, failure);
    }
  },
  90_000,
);

for (const withdrawn of ["network", "package"] as const)
  it.runIf(enabled)(
    `actual current ${withdrawn} withdrawal after Native module enable prevents original business activation without creating a Run or activation row`,
    async () => {
      const f = await fixture();
      let failure: Readonly<{ error: unknown }> | undefined;
      try {
        const enabledResponse = await moduleEnable(f, krea);
        expect(
          enabledResponse.status,
          await enabledResponse.clone().text(),
        ).toBe(200);
        if (withdrawn === "network") f.authority.denyNetwork();
        else f.authority.denyPackage();
        const response = await businessActivate(f, krea);
        expect(response.status, await response.clone().text()).not.toBe(200);
        expect(await activation(f)).toBe(null);
        expect((await selection(f, krea)).state).toBe("enabled");
        expect(
          nativeProcessFacts(f.databasePath).counts.extension_activations,
        ).toBe(0);
        await assertDefault(f);
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        await closeNativeProcessFixture(f, failure);
      }
    },
    90_000,
  );

for (const changed of ["configuration", "selection", "policy"] as const)
  it.runIf(enabled)(
    `actual ${changed === "policy" ? "named HTTPS policy withdrawal" : `HTTP ${changed} CAS`} during Native v3 pending IO preflight refuses stale module enable before any enabled SQLite commit`,
    async () => {
      const f = await fixture();
      const gate = f.authority.holdNext("/network");
      let pending: Promise<Response | Error> | null = null;
      let failure: Readonly<{ error: unknown }> | undefined;
      try {
        pending = moduleEnable(f, krea).catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
        );
        await Promise.race([
          gate.entered,
          pending.then((result) => {
            throw result instanceof Error
              ? result
              : new Error("enable_finished_before_actual_io_body");
          }),
        ]);
        if (changed === "policy") f.authority.denyActivation();
        else {
          const update = await nativeProcessHttp(
            f.runtime.session(),
            "PUT",
            changed === "configuration"
              ? `/api/v1/extensions/${krea}/configuration`
              : `/api/v1/plugins/selections/${krea}`,
            changed === "configuration"
              ? {
                  pluginVersion: "1.0.0",
                  expectedRevision: 1,
                  parameters: { baseUrl: "https://8.8.4.4/" },
                  credentialBindings: [],
                }
              : {
                  expectedSelectionRevision: 1,
                  selectedPackageDigest: f.sources[1]!.packageDigest,
                  state: "disabled",
                },
            `native-v3-race-${changed}`,
          );
          expect(update.status, await update.clone().text()).toBe(200);
        }
        gate.release();
        const result = await pending;
        expect(result).toBeInstanceOf(Response);
        if (!(result instanceof Response)) throw result;
        expect(result.status, await result.clone().text()).toBe(
          changed === "policy" ? 403 : 409,
        );
        const current = await selection(f, krea);
        expect(current.state).toBe("disabled");
        expect(current.revision).toBe(changed === "selection" ? 2 : 1);
        expect(await activation(f)).toBe(null);
        expect(
          nativeProcessFacts(f.databasePath).counts.extension_activations,
        ).toBe(0);
        await assertDefault(f);
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        gate.release();
        await pending?.catch(() => {});
        await closeNativeProcessFixture(f, failure);
      }
    },
    90_000,
  );

it.runIf(enabled)(
  "actual Native refuses a lost Krea deployment after real Worker readiness and Local Node preparation despite the held final HTTPS decision already being allow",
  async () => {
    const f = await fixture();
    // Calls 1/2 precede and follow real Worker readiness; call 3 is the explicit
    // refresh after actual Local Node preparation, before returning the candidate.
    const gate = f.authority.holdActivationDecision(3);
    let pending: Promise<Response | Error> | null = null;
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      expect(f.selectionReceiptCount()).toBe(0);
      pending = moduleEnable(f, krea).catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
      );
      await Promise.race([
        gate.entered,
        pending.then((result) => {
          throw result instanceof Error
            ? result
            : new Error("enable_finished_before_final_actual_policy_body");
        }),
      ]);
      expect(gate.decision()).toEqual({ outcome: "allow" });
      // Native installation HTTP reads share the pending selection's serialized
      // profile queue. Mutate the owned database and release the body immediately;
      // examine file/audit evidence after the request settles, within the real 10s policy deadline.
      const target = await f.removeKreaDeployment();
      gate.release();
      const result = await pending;
      expect(
        f.authority.requests.filter(({ path }) => path === "/activate"),
      ).toHaveLength(3);
      expect(
        f.authority.requests.some(
          ({ path, body }) => path === "/network" && body.kind === "readiness",
        ),
      ).toBe(true);
      const source = f.sources.find(({ pluginId }) => pluginId === krea)!;
      const nodePath = `/packages/${source.packageDigest.slice(7)}/node.mjs`;
      const imports = await f.installedImports();
      for (const pid of [f.workerPid, f.controlPid])
        expect(
          imports.some((row) => row.pid === pid && row.url.includes(nodePath)),
        ).toBe(true);
      expect(target).toEqual(
        f.preparation.document.entries.find(
          ({ packageIdentity }) => packageIdentity.pluginId === krea,
        )!.target,
      );
      expect(gate.decision()).toEqual({ outcome: "allow" });
      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) throw result;
      expect(result.status, await result.clone().text()).toBe(409);
      expect((await result.json()).error.code).toBe(
        "extension_execution_target_mismatch",
      );
      expect(
        f.authority.requests.filter(({ path }) => path === "/activate"),
      ).toHaveLength(3);
      expect(f.selectionReceiptCount()).toBe(0);
      await assertDisabled(f);
      // This source case proves the positive policy body cannot hide a changed
      // local deployment. Control/Store tests separately place the late guard in BEGIN.
      await assertDefault(f);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      gate.release();
      await pending?.catch(() => {});
      await closeNativeProcessFixture(f, failure);
    }
  },
  90_000,
);

for (const waiting of ["/network", "/activate"] as const)
  it.runIf(enabled)(
    `actual Native stop joins pending ${waiting} HTTPS body and both consuming children before retiring v3 private files, then restarts the disabled module`,
    async () => {
      const f = await fixture();
      const gate = f.authority.holdNext(waiting);
      let pending: Promise<Response | Error> | null = null;
      let failure: Readonly<{ error: unknown }> | undefined;
      try {
        pending = moduleEnable(f, krea).catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
        );
        await Promise.race([
          gate.entered,
          pending.then((result) => {
            throw result instanceof Error
              ? result
              : new Error("enable_finished_before_actual_authority_body");
          }),
        ]);
        expect(
          await activationSnapshot(f.dataDirectory, f.activation.path),
        ).toEqual(f.activation);
        expect(
          await automaticPreparationDirectories(f.dataDirectory),
        ).toHaveLength(1);
        expect(await nativeBootstrapFiles(f.dataDirectory)).toHaveLength(1);
        for (const pid of [f.workerPid, f.controlPid])
          expect(() => process.kill(pid, 0)).not.toThrow();
        await f.runtime.stop();
        for (const pid of [f.workerPid, f.controlPid])
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        expect(gate.socketClosed()).toBe(true);
        expect(await pending).toBeInstanceOf(Error);
        expect(await activationDirectories(f.dataDirectory)).toEqual([]);
        expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
          [],
        );
        expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
        gate.release();
        const replacement = await f.start();
        expect(replacement.activation.directory).not.toBe(
          f.activation.directory,
        );
        expect(replacement.preparation.document).toEqual(
          f.preparation.document,
        );
        await assertDisabled(f);
        const response = await moduleEnable(f, krea);
        expect(response.status, await response.clone().text()).toBe(200);
        expect((await selection(f, krea)).revision).toBe(2);
        expect(await activation(f)).toBe(null);
        await assertDefault(f);
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        gate.release();
        await pending?.catch(() => {});
        await closeNativeProcessFixture(f, failure);
      }
    },
    120_000,
  );
