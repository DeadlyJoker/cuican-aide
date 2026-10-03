import assert from "node:assert/strict";
import { readFile, rename } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import {
  assertAutomaticHistoricalPublication,
  assertAutomaticManagementOnly,
  assertAutomaticNoExecution,
  automaticPreparationDirectories,
  automaticPreparationSnapshot,
  automaticPublishedSnapshot,
  nativeAutomaticProcessFixture,
  saveAutomaticConfiguration,
} from "./desktopInstalledPluginRuntime.automatic.process.test-support.ts";
import {
  closeNativeProcessFixture,
  nativeBootstrapFiles,
  nativeProcessFacts,
  nativeProcessHttp,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;

it.runIf(packageDirectory !== undefined)(
  "actual Native v2 first startup prepares and publishes the current model and disabled HTTP configuration, restores offline and republishes only the latest revision without execution or funds",
  async () => {
    const f = await nativeAutomaticProcessFixture(packageDirectory!);
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      const fixedBytes = await readFile(f.fixedPath);
      const firstChildCount = (await f.observations()).length;
      const first = f.supervisor(true);
      await first.start();
      expect(
        (
          await nativeProcessHttp(
            first.session(),
            "GET",
            "/api/v1/health/ready",
          )
        ).status,
      ).toBe(200);
      assertAutomaticChildren((await f.observations()).slice(firstChildCount));
      const firstPreparation = await automaticPreparationSnapshot(
        f.dataDirectory,
      );
      const published = await automaticPublishedSnapshot(
        f,
        firstPreparation,
        f.configuration,
      );
      expect(published.active.activation.previousReleaseId).toBe(null);
      await assertAutomaticManagementOnly(
        f,
        first.session(),
        f.installed.selection,
        f.configuration,
      );
      const {
        sourceId: _id,
        directory: _directory,
        ...identity
      } = f.sources[0]!;
      expect(f.requests.some(({ path }) => path === "/actor")).toBe(true);
      expect(f.requests.some(({ path }) => path === "/profile")).toBe(true);
      const packageRequests = f.requests.filter(
        ({ path }) => path === "/package",
      );
      expect(packageRequests.length).toBeGreaterThan(0);
      expect(
        packageRequests.every(
          ({ body }) =>
            body.purpose === "read" &&
            isDeepStrictEqual(body.identity, identity),
        ),
      ).toBe(true);
      const firstFacts = nativeProcessFacts(f.databasePath);
      await first.stop();
      expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
        [],
      );
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);

      // The approved delivery directory is now genuinely absent. Cold startup
      // must reconstruct its document from installed bytes and persisted facts.
      await rename(
        f.sources[0]!.directory,
        `${f.sources[0]!.directory}-offline`,
      );
      const coldChildCount = (await f.observations()).length;
      const cold = f.supervisor(true);
      await cold.start();
      expect(
        (await nativeProcessHttp(cold.session(), "GET", "/api/v1/health/ready"))
          .status,
      ).toBe(200);
      assertAutomaticChildren((await f.observations()).slice(coldChildCount));
      const coldPreparation = await automaticPreparationSnapshot(
        f.dataDirectory,
      );
      const reopened = await automaticPublishedSnapshot(
        f,
        coldPreparation,
        f.configuration,
      );
      expect(coldPreparation.directory).not.toBe(firstPreparation.directory);
      expect(coldPreparation.document).toEqual(firstPreparation.document);
      expect(reopened.active.bundle).toEqual(published.active.bundle);
      expect(reopened.assets).toEqual(published.assets);
      for (const table of [
        "agent_versions",
        "agent_version_deployments",
        "agent_version_release_bundles",
      ])
        expect(nativeProcessFacts(f.databasePath).counts[table]).toBe(
          firstFacts.counts[table],
        );
      await assertAutomaticManagementOnly(
        f,
        cold.session(),
        f.installed.selection,
        f.configuration,
      );

      // Saving business preferences is not an implicit restart or activation.
      const beforeSaveChildren = (await f.observations()).length;
      const revisedConfiguration = await saveAutomaticConfiguration(
        f,
        cold.session(),
        1,
      );
      expect(revisedConfiguration.revision).toBe(2);
      expect(revisedConfiguration.contentDigest).not.toBe(
        f.configuration.contentDigest,
      );
      expect((await f.observations()).length).toBe(beforeSaveChildren);
      expect(await automaticPreparationSnapshot(f.dataDirectory)).toEqual(
        coldPreparation,
      );
      await automaticPublishedSnapshot(f, coldPreparation, f.configuration);
      await cold.stop();
      expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
        [],
      );

      const revisedChildCount = (await f.observations()).length;
      const revised = f.supervisor(true);
      await revised.start();
      expect(
        (
          await nativeProcessHttp(
            revised.session(),
            "GET",
            "/api/v1/health/ready",
          )
        ).status,
      ).toBe(200);
      assertAutomaticChildren(
        (await f.observations()).slice(revisedChildCount),
      );
      const revisionPreparation = await automaticPreparationSnapshot(
        f.dataDirectory,
      );
      const current = await automaticPublishedSnapshot(
        f,
        revisionPreparation,
        revisedConfiguration,
      );
      expect(current.entry.target).not.toEqual(published.entry.target);
      expect(current.entry.version.agentVersionId).not.toBe(
        published.entry.version.agentVersionId,
      );
      expect(current.active.bundle.releaseId).not.toBe(
        published.active.bundle.releaseId,
      );
      expect(current.active.activation.previousReleaseId).toBe(
        published.active.bundle.releaseId,
      );
      expect(current.original).toEqual(published.original);
      await assertAutomaticHistoricalPublication(f, published);
      await assertAutomaticManagementOnly(
        f,
        revised.session(),
        f.installed.selection,
        revisedConfiguration,
      );
      await assertAutomaticManagementOnly(
        f,
        revised.session(),
        f.installed.selection,
        f.configuration,
      );
      expect(await readFile(f.fixedPath)).toEqual(fixedBytes);
      await revised.stop();
      expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
        [],
      );
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);

      const beforeDeniedFacts = nativeProcessFacts(f.databasePath);
      const beforeDeniedChildren = (await f.observations()).length;
      const beforeDeniedRequests = f.requests.length;
      f.denyPackages();
      const refused = f.supervisor(true);
      await expect(refused.start()).rejects.toThrow(
        /Installed plugin preparation failed/u,
      );
      expect(() => refused.session()).toThrow("control_runtime_unavailable");
      const deniedChildren = (await f.observations()).slice(
        beforeDeniedChildren,
      );
      expect(deniedChildren).toHaveLength(1);
      expect(
        deniedChildren[0]!.entry.endsWith(
          "/runtime-worker/src/release-main.ts",
        ),
      ).toBe(true);
      expect(deniedChildren[0]!.preparation).toBe(true);
      expect(
        f.requests
          .slice(beforeDeniedRequests)
          .some(
            ({ path, body }) => path === "/package" && body.purpose === "read",
          ),
      ).toBe(true);
      expect(nativeProcessFacts(f.databasePath)).toEqual(beforeDeniedFacts);
      await refused.stop();
      expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
        [],
      );
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
      await assertAutomaticNoExecution(f);
      await assertAutomaticHistoricalPublication(f, published);
      await assertAutomaticHistoricalPublication(f, current);
      expect(await readFile(f.fixedPath)).toEqual(fixedBytes);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await closeNativeProcessFixture(f, failure);
    }
  },
  180_000,
);

function assertAutomaticChildren(
  rows: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof nativeAutomaticProcessFixture>>["observations"]
    >
  >,
) {
  assert.equal(rows.length, 4);
  const release = rows.filter((row) =>
    row.entry.endsWith("/runtime-worker/src/release-main.ts"),
  );
  assert.equal(release.length, 2);
  assert.equal(release[0]!.preparation, true);
  assert.equal(release[0]!.installed, false);
  assert.equal(release[1]!.preparation, false);
  assert.equal(release[1]!.installed, true);
  assert.ok(release.every((row) => row.authorityTokenPresent && !row.peer));
  assert.equal(
    release[0]!.environment.CREWON_AGENT_VERSION_ID,
    release[1]!.environment.CREWON_AGENT_VERSION_ID,
  );
  const worker = rows.find((row) =>
    row.entry.endsWith("/runtime-worker/src/main.ts"),
  );
  assert.ok(
    worker?.installed &&
      worker.peer &&
      worker.authorityTokenPresent &&
      !worker.preparation,
  );
  const control = rows.find((row) =>
    row.entry.endsWith("/control-api/src/main.ts"),
  );
  assert.ok(control?.nativeBootstrap);
  assert.ok(
    !control.installed &&
      !control.peer &&
      !control.preparation &&
      !control.authorityTokenPresent,
  );
}
