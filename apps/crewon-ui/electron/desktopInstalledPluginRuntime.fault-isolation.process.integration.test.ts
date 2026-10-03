import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automaticPreparationDirectories,
  automaticPreparationResultSnapshot,
} from "./desktopInstalledPluginRuntime.automatic.process.test-support.ts";
import {
  assertIsolationChildren,
  assertIsolationNoPluginExecution,
  assertIsolationSelection,
  assertIsolationTaskRoutesUnavailable,
  configureIsolationPlugin,
  installIsolationPlugin,
  isolationActivePublication,
  nativeIsolationProcessFixture,
  runIsolationDefaultAgent,
  uninstallIsolationPlugin,
  writeIsolationRuntimeConfiguration,
} from "./desktopInstalledPluginRuntime.fault-isolation.test-support.ts";
import {
  closeNativeProcessFixture,
  nativeBootstrapFiles,
  nativeProcessFacts,
  nativeProcessHttp,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";

const professionalDirectory =
  process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
const kreaDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;

for (const reason of [
  "notInstalled",
  "configurationMissing",
  "readDenied",
] as const) {
  it.runIf(professionalDirectory !== undefined)(
    `actual Native preparation isolates ${reason}, retains management facts and runs the unchanged default Agent through real Responses streaming without plugin Node, IO, tasks or funds`,
    async () => {
      const f = await nativeIsolationProcessFixture(professionalDirectory!);
      let failure: Readonly<{ error: unknown }> | undefined;
      try {
        const source = f.sources[0]!;
        const management = f.supervisor(false);
        await management.start();
        const installed = await installIsolationPlugin(
          management.session(),
          source,
        );
        const configuration =
          reason === "configurationMissing"
            ? null
            : await configureIsolationPlugin(f, management.session(), source);
        const selection =
          reason === "notInstalled"
            ? await uninstallIsolationPlugin(management.session(), source)
            : installed.selection;
        await assertIsolationNoPluginExecution(f, false);
        assert.ok(
          Object.values(nativeProcessFacts(f.databasePath).counts).every(
            (count) => count === 0,
          ),
        );
        await management.stop();
        const fixedPath = await writeIsolationRuntimeConfiguration(f, [
          source.pluginId,
        ]);
        const fixedBytes = await readFile(fixedPath);
        if (reason === "readDenied") f.denyPackages();
        const beforeChildren = (await f.observations()).length;
        const runtime = f.supervisor(true);
        await runtime.start();
        const session = runtime.session();
        expect(
          (await nativeProcessHttp(session, "GET", "/api/v1/health/ready"))
            .status,
        ).toBe(200);
        assertIsolationChildren(
          (await f.observations()).slice(beforeChildren),
          false,
        );
        const snapshot = await automaticPreparationResultSnapshot(
          f.dataDirectory,
        );
        expect(snapshot.document).toBe(null);
        expect(snapshot.result.plugins).toEqual([
          { pluginId: source.pluginId, state: "blocked", reasonCode: reason },
        ]);
        expect(snapshot.result.scope).toEqual(await f.currentProfile());
        const publication = await isolationActivePublication(f);
        expect(nativeProcessFacts(f.databasePath).counts.agent_versions).toBe(
          publication.assets.length,
        );
        expect(publication.active.bundle.defaultAgentVersionId).toBe(
          snapshot.result.defaultAgentVersionId,
        );
        expect(
          publication.assets.every(
            ({ agentVersionId }) =>
              !agentVersionId.startsWith("native-plugin-"),
          ),
        ).toBe(true);
        expect(
          publication.assets.every(
            ({ tools }) =>
              !JSON.stringify(tools).includes("example_professional"),
          ),
        ).toBe(true);
        await assertIsolationSelection(session, selection);
        const saved = await nativeProcessHttp(
          session,
          "GET",
          `/api/v1/extensions/${source.pluginId}/configuration`,
        );
        expect(saved.status).toBe(200);
        expect((await saved.json()).configuration).toEqual(configuration);
        await assertIsolationTaskRoutesUnavailable(f, session);
        await assertIsolationNoPluginExecution(f, false);
        if (reason === "readDenied")
          expect(
            f.requests.some(
              ({ path, body }) =>
                path === "/package" && body.purpose === "read",
            ),
          ).toBe(true);
        await runIsolationDefaultAgent(
          f,
          session,
          publication.active.bundle.defaultAgentVersionId,
        );
        await assertIsolationNoPluginExecution(f, true);
        expect(await readFile(fixedPath)).toEqual(fixedBytes);
        await runtime.stop();
        expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
          [],
        );
        expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
        for (const child of (await f.observations()).slice(beforeChildren))
          assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        await closeNativeProcessFixture(f, failure);
      }
    },
    90_000,
  );
}

it.runIf(professionalDirectory !== undefined && kreaDirectory !== undefined)(
  "actual independently retained Krea2 prepares and publishes while unconfigured professional module stays blocked, preserving both disabled selections without importing either Node entrypoint",
  async () => {
    const f = await nativeIsolationProcessFixture(
      professionalDirectory!,
      kreaDirectory!,
    );
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      const professional = f.sources[0]!,
        krea = f.sources[1]!;
      expect(krea.pluginId).toBe("crewon.comfyui-krea2");
      expect(krea.packageDigest).not.toBe(professional.packageDigest);
      const management = f.supervisor(false);
      await management.start();
      const professionalInstall = await installIsolationPlugin(
        management.session(),
        professional,
      );
      const kreaInstall = await installIsolationPlugin(
        management.session(),
        krea,
      );
      const configuration = await configureIsolationPlugin(
        f,
        management.session(),
        krea,
      );
      await management.stop();
      await writeIsolationRuntimeConfiguration(f, [
        professional.pluginId,
        krea.pluginId,
      ]);
      const beforeChildren = (await f.observations()).length;
      const runtime = f.supervisor(true);
      await runtime.start();
      expect(
        (
          await nativeProcessHttp(
            runtime.session(),
            "GET",
            "/api/v1/health/ready",
          )
        ).status,
      ).toBe(200);
      assertIsolationChildren(
        (await f.observations()).slice(beforeChildren),
        true,
      );
      const snapshot = await automaticPreparationResultSnapshot(
        f.dataDirectory,
      );
      assert.ok(snapshot.document);
      const { sourceId: _sourceId, directory: _directory, ...identity } = krea;
      expect(snapshot.result.plugins[0]).toEqual({
        pluginId: professional.pluginId,
        state: "blocked",
        reasonCode: "configurationMissing",
      });
      const prepared = snapshot.result.plugins[1]!;
      assert.equal(prepared.state, "prepared");
      if (prepared.state !== "prepared")
        throw new Error("actual_krea_not_prepared");
      expect(prepared.packageIdentity).toEqual(identity);
      expect(prepared.configuration).toEqual({
        revision: configuration.revision,
        contentDigest: configuration.contentDigest,
      });
      expect(snapshot.document.entries).toHaveLength(1);
      const entry = snapshot.document.entries[0]!;
      expect(entry.packageIdentity).toEqual(identity);
      expect(entry.configuration).toEqual(configuration);
      const publication = await isolationActivePublication(f);
      expect(nativeProcessFacts(f.databasePath).counts.agent_versions).toBe(
        publication.assets.length,
      );
      expect(publication.active.bundle.defaultAgentVersionId).toBe(
        snapshot.result.defaultAgentVersionId,
      );
      const pluginAssets = publication.assets.filter(({ agentVersionId }) =>
        agentVersionId.startsWith("native-plugin-"),
      );
      expect(pluginAssets).toHaveLength(2);
      expect(
        pluginAssets.find(
          ({ agentVersionId }) =>
            agentVersionId === entry.version.agentVersionId,
        ),
      ).toEqual(entry.version);
      expect(
        pluginAssets.find(
          ({ agentVersionId }) =>
            agentVersionId === entry.modelSource.version.agentVersionId,
        ),
      ).toEqual(entry.modelSource.version);
      expect(JSON.stringify(entry.version.tools)).toContain(
        "crewon_comfyui_krea2__submit",
      );
      expect(JSON.stringify(publication.assets)).not.toContain(
        "example_professional",
      );
      expect(
        publication.assets
          .filter(
            ({ agentVersionId }) =>
              agentVersionId !== entry.version.agentVersionId,
          )
          .every(
            ({ tools }) =>
              !JSON.stringify(tools).includes("crewon_comfyui_krea2__submit"),
          ),
      ).toBe(true);
      for (const version of [entry.version, entry.modelSource.version])
        expect(
          publication.active.bundle.deployments.some(
            ({ agentVersionId }) => agentVersionId === version.agentVersionId,
          ),
        ).toBe(true);
      const targetDeployment = publication.active.bundle.deployments.find(
        ({ agentVersionId }) =>
          agentVersionId === prepared.target.agentVersionId,
      );
      assert.ok(targetDeployment);
      expect(targetDeployment.materializationDigest).toBe(
        prepared.target.materializationDigest,
      );
      await assertIsolationSelection(
        runtime.session(),
        professionalInstall.selection,
      );
      await assertIsolationSelection(runtime.session(), kreaInstall.selection);
      await assertIsolationTaskRoutesUnavailable(f, runtime.session());
      await assertIsolationNoPluginExecution(f, false);
      await runtime.stop();
      expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
        [],
      );
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await closeNativeProcessFixture(f, failure);
    }
  },
  90_000,
);

for (const corrupted of [
  "privateFixedConfiguration",
  "nativeActor",
  "nativeProfile",
] as const) {
  it.runIf(professionalDirectory !== undefined)(
    `actual ${corrupted} corruption remains fatal before automatic preparation or publication instead of becoming an isolated plugin status`,
    async () => {
      const f = await nativeIsolationProcessFixture(professionalDirectory!);
      let failure: Readonly<{ error: unknown }> | undefined;
      try {
        const source = f.sources[0]!;
        const management = f.supervisor(false);
        await management.start();
        await installIsolationPlugin(management.session(), source);
        await configureIsolationPlugin(f, management.session(), source);
        await management.stop();
        const fixed = await writeIsolationRuntimeConfiguration(f, [
          source.pluginId,
        ]);
        if (corrupted === "privateFixedConfiguration")
          await chmod(fixed, 0o644);
        else {
          const path = join(f.dataDirectory, "plugin-profile.json");
          const value = JSON.parse(await readFile(path, "utf8"));
          if (corrupted === "nativeActor")
            value.actor.actorId = "another-native-actor";
          else value.scope.spaceId = "another-native-space";
          await writeFile(path, JSON.stringify(value));
        }
        const facts = nativeProcessFacts(f.databasePath);
        const children = await f.observations();
        const runtime = f.supervisor(true);
        await expect(runtime.start()).rejects.toThrow(
          corrupted === "privateFixedConfiguration"
            ? "desktop_installed_plugin_runtime_file_invalid"
            : "desktop_plugin_bootstrap_profile_invalid",
        );
        expect(() => runtime.session()).toThrow("control_runtime_unavailable");
        expect(await f.observations()).toEqual(children);
        expect(nativeProcessFacts(f.databasePath)).toEqual(facts);
        await runtime.stop();
        expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
          [],
        );
        expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
        await assertIsolationNoPluginExecution(f, false);
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        await closeNativeProcessFixture(f, failure);
      }
    },
    60_000,
  );
}
