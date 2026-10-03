import { expect, it } from "vitest";
import {
  closeNativeProcessFixture,
  nativeBootstrapFiles,
  nativeProcessFacts,
  nativeProcessHttp,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";
import {
  holdActualNativeCatalogResponse,
  nativeInstalledLifetimeFixture,
  waitNativeChildClosed,
} from "./desktopInstalledPluginRuntime.lifetime.test-support.ts";

const packageDirectory = process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;

it.runIf(packageDirectory !== undefined)(
  "actual Native stop and restart join an already-returned private catalog response before removing bootstrap ownership or starting replacement children",
  async () => {
    const f = await nativeInstalledLifetimeFixture(packageDirectory!);
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
      const children = await f.observations();
      const worker = children.findLast((row) =>
        row.entry.endsWith("/runtime-worker/src/main.ts"),
      );
      expect(worker?.installed).toBe(true);
      expect(worker?.peer).toBe(true);
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
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual(bootstrap);
      expect((await f.observations()).length).toBe(children.length);
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
      expect((await f.observations()).length).toBeGreaterThan(children.length);
      await f.assertNoNodeImports();
      for (const [table, count] of Object.entries(
        nativeProcessFacts(f.databasePath).counts,
      ))
        if (!/^(?:agent_version|active_agent_version)/u.test(table))
          expect(count, table).toBe(0);
      expect(f.modelRequests()).toBe(0);
      expect(f.supplierRequests()).toBe(0);
      await runtime.stop();
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
