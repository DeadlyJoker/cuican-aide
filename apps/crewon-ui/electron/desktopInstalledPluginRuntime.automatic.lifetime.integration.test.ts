import { expect, it } from "vitest";
import {
  assertAutomaticNoExecution,
  automaticPreparationDirectories,
  automaticPreparationSnapshot,
  nativeAutomaticProcessFixture,
} from "./desktopInstalledPluginRuntime.automatic.process.test-support.ts";
import {
  closeNativeProcessFixture,
  nativeBootstrapFiles,
  nativeProcessHttp,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";
import {
  holdActualNativeCatalogResponse,
  waitNativeChildClosed,
} from "./desktopInstalledPluginRuntime.lifetime.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;

it.runIf(packageDirectory !== undefined)(
  "actual automatic Native stop retains CLI-generated preparation files after its Worker closes until the pending real catalog response physically joins, then restart owns a new directory",
  async () => {
    const f = await nativeAutomaticProcessFixture(packageDirectory!);
    const gate = holdActualNativeCatalogResponse();
    const runtime = f.supervisor(true);
    let starting: Promise<unknown> | null = null;
    let stopping: Promise<void> | null = null;
    let restarting: Promise<void> | null = null;
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      starting = runtime.start().then(
        () => null,
        (error: unknown) => error,
      );
      expect(await gate.entered).toEqual({ status: 200, hasBody: true });
      const preparation = await automaticPreparationSnapshot(f.dataDirectory);
      expect(preparation.document.entries[0]!.configuration).toEqual(
        f.configuration,
      );
      const children = await f.observations();
      const releases = children.filter((row) =>
        row.entry.endsWith("/runtime-worker/src/release-main.ts"),
      );
      expect(releases.map(({ preparation }) => preparation)).toEqual([
        true,
        false,
      ]);
      const worker = children.findLast((row) =>
        row.entry.endsWith("/runtime-worker/src/main.ts"),
      );
      expect(worker?.installed && worker.peer).toBe(true);
      const bootstrap = await nativeBootstrapFiles(f.dataDirectory);
      expect(bootstrap).toHaveLength(1);
      let stopped = false,
        restarted = false;
      stopping = runtime.stop().then(() => {
        stopped = true;
      });
      restarting = runtime.restart().then(() => {
        restarted = true;
      });
      await waitNativeChildClosed(worker!.pid);
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(restarted).toBe(false);
      expect((await f.observations()).length).toBe(children.length);
      expect(await automaticPreparationSnapshot(f.dataDirectory)).toEqual(
        preparation,
      );
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual(bootstrap);
      expect(() => runtime.session()).toThrow("control_runtime_unavailable");
      gate.release();
      await stopping;
      expect(await starting).toBeInstanceOf(Error);
      await restarting;
      expect(
        (
          await nativeProcessHttp(
            runtime.session(),
            "GET",
            "/api/v1/health/ready",
          )
        ).status,
      ).toBe(200);
      const replacement = await automaticPreparationSnapshot(f.dataDirectory);
      expect(replacement.directory).not.toBe(preparation.directory);
      expect(replacement.document).toEqual(preparation.document);
      expect(
        (await automaticPreparationDirectories(f.dataDirectory)).length,
      ).toBe(1);
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
      gate.release();
      gate.restore();
      await Promise.allSettled(
        [starting, stopping, restarting].filter((value) => value !== null),
      );
      await closeNativeProcessFixture(f, failure);
    }
  },
  120_000,
);
