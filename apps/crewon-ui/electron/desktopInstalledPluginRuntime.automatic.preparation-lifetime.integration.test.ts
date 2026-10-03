import assert from "node:assert/strict";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import {
  assertAutomaticNoExecution,
  automaticPreparationDirectories,
  automaticPreparationSnapshot,
  automaticPublishedSnapshot,
  nativeAutomaticProcessFixture,
} from "./desktopInstalledPluginRuntime.automatic.process.test-support.ts";
import { holdActualNativePreparationActor } from "./desktopInstalledPluginRuntime.automatic.preparation-lifetime.test-support.ts";
import {
  closeNativeProcessFixture,
  nativeBootstrapFiles,
  nativeProcessFacts,
  nativeProcessHttp,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";
import { waitNativeChildClosed } from "./desktopInstalledPluginRuntime.lifetime.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;

it.runIf(packageDirectory !== undefined)(
  "actual automatic Native stop closes a preparation CLI waiting on the original HTTPS actor response before retiring its two private inputs, then the same settings restart without a prior publication",
  async () => {
    const f = await nativeAutomaticProcessFixture(packageDirectory!);
    let proxy: Awaited<
      ReturnType<typeof holdActualNativePreparationActor>
    > | null = null;
    let starting: Promise<unknown> | null = null;
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      const configuration = JSON.parse(await readFile(f.fixedPath, "utf8"));
      proxy = await holdActualNativePreparationActor(
        configuration.workerAuthorities.actorAuthority.url,
      );
      configuration.workerAuthorities.actorAuthority.url = proxy.url;
      await writeFile(f.fixedPath, JSON.stringify(configuration), {
        mode: 0o600,
      });
      const fixedBytes = await readFile(f.fixedPath);
      const runtime = f.supervisor(true);
      const beforeChildren = (await f.observations()).length;
      starting = runtime.start().then(
        () => null,
        (error: unknown) => error,
      );
      expect(
        await Promise.race([
          proxy.entered,
          starting.then((result) => {
            throw (
              result ??
              new Error(
                "preparation_finished_without_entering_real_authority_gate",
              )
            );
          }),
        ]),
      ).toEqual({ status: 200, actualActor: actor });
      const children = (await f.observations()).slice(beforeChildren);
      expect(children).toHaveLength(1);
      const preparationChild = children[0]!;
      expect(
        preparationChild.entry.endsWith("/runtime-worker/src/release-main.ts"),
      ).toBe(true);
      expect(preparationChild.preparation).toBe(true);
      expect(preparationChild.installed || preparationChild.peer).toBe(false);
      expect(() => process.kill(preparationChild.pid, 0)).not.toThrow();
      const directories = await automaticPreparationDirectories(
        f.dataDirectory,
      );
      expect(directories).toHaveLength(1);
      const directory = join(f.dataDirectory, directories[0]!);
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await readdir(directory)).sort()).toEqual([
        "preparation.json",
        "worker.json",
      ]);
      for (const name of ["preparation.json", "worker.json"])
        expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
      await assert.rejects(lstat(join(directory, "release.json")), {
        code: "ENOENT",
      });
      const bindingsPath = join(
        f.dataDirectory,
        "agent-version-runtime-bindings.json",
      );
      await assert.rejects(lstat(bindingsPath), { code: "ENOENT" });
      const facts = nativeProcessFacts(f.databasePath);
      expect(Object.values(facts.counts).every((count) => count === 0)).toBe(
        true,
      );
      expect(await nativeBootstrapFiles(f.dataDirectory)).toHaveLength(1);

      await runtime.stop();
      // A completed stop is only acceptable after the actual waiting CLI is
      // physically gone; otherwise deleting its inputs would retire a live owner.
      assert.throws(() => process.kill(preparationChild.pid, 0), {
        code: "ESRCH",
      });
      await waitNativeChildClosed(preparationChild.pid);
      expect(await starting).toBeInstanceOf(Error);
      expect((await f.observations()).length).toBe(beforeChildren + 1);
      expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
        [],
      );
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
      expect(nativeProcessFacts(f.databasePath)).toEqual(facts);
      await assert.rejects(lstat(bindingsPath), { code: "ENOENT" });
      proxy.release();
      await proxy.joined();

      await runtime.restart();
      expect(
        (
          await nativeProcessHttp(
            runtime.session(),
            "GET",
            "/api/v1/health/ready",
          )
        ).status,
      ).toBe(200);
      const preparation = await automaticPreparationSnapshot(f.dataDirectory);
      expect(preparation.directory).not.toBe(directory);
      await automaticPublishedSnapshot(f, preparation, f.configuration);
      expect(await readFile(f.fixedPath)).toEqual(fixedBytes);
      await assertAutomaticNoExecution(f);
      await runtime.stop();
      expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
        [],
      );
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      proxy?.release();
      let cleanupFailure: unknown;
      try {
        await proxy?.close();
      } catch (error) {
        cleanupFailure = error;
      }
      await closeNativeProcessFixture(
        f,
        cleanupFailure === undefined
          ? failure
          : {
              error: new AggregateError(
                [...(failure ? [failure.error] : []), cleanupFailure],
                "native_preparation_test_and_proxy_cleanup_failed",
              ),
            },
      );
      if (starting !== null) await starting;
      if (cleanupFailure !== undefined)
        throw new AggregateError(
          [...(failure ? [failure.error] : []), cleanupFailure],
          "native_preparation_test_and_proxy_cleanup_failed",
        );
    }
  },
  120_000,
);
