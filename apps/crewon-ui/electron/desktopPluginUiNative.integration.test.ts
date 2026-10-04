import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { trackDesktopTestChildren } from "./desktopPluginTestChildren.test-support.ts";
import {
  createPluginControlRouteFixture,
  pluginRouteHeaders,
  pluginRouteCredentials,
} from "../../control-api/src/plugin-control-route.test-support.ts";

it("real Electron 43 loads actual installed UI bytes through the production frame gate and private native IPC", async () => {
  const cleanups: (() => unknown | Promise<unknown>)[] = [];
  const context = {
    after: (fn: () => unknown) => cleanups.push(fn),
  } as unknown as TestContext;
  const directory = await mkdtemp(join(tmpdir(), "crewon-native-plugin-ui-"));
  let child: ReturnType<typeof spawn> | null = null;
  let tracked: ReturnType<typeof trackDesktopTestChildren> | null = null;
  let mainClosed = false;
  let primaryFailure: unknown;
  try {
    const f = await createPluginControlRouteFixture(context);
    f.app.get("/native-probe", (_req, reply) =>
      reply
        .type("text/html")
        .send("<!doctype html><title>Foreign frame</title>"),
    );
    f.advanceClock(Date.now() - Date.parse("2026-10-03T00:00:00.000Z"));
    const pkg = await f.createPackage("1.0.0");
    const install = await f.app.inject({
      method: "POST",
      url: "/api/v1/plugins/installations",
      headers: {
        ...pluginRouteHeaders,
        "idempotency-key": "native-ui-install",
      },
      payload: {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.expectedPluginId,
        expectedPackageDigest: pkg.expectedPackageDigest,
        expectedSelectionRevision: null,
      },
    });
    expect(install.statusCode, install.body).toBe(200);
    const enable = await f.app.inject({
      method: "PUT",
      url: `/api/v1/plugins/selections/${pkg.expectedPluginId}`,
      headers: { ...pluginRouteHeaders, "idempotency-key": "native-ui-enable" },
      payload: {
        state: "enabled",
        selectedPackageDigest: pkg.expectedPackageDigest,
        expectedSelectionRevision: 1,
      },
    });
    expect(enable.statusCode, enable.body).toBe(200);
    const opened = await f.app.inject({
      method: "POST",
      url: "/api/v1/plugins/ui/mounts",
      headers: pluginRouteHeaders,
      payload: {
        pluginId: pkg.expectedPluginId,
        contributionId: "counter",
        expectedSelectionRevision: 2,
        expectedPackageDigest: pkg.expectedPackageDigest,
      },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const lease = opened.json();
    // Advance only the issuing test Control clock. Electron still sees a live original lease.
    f.advanceClock(60_000);
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const address = f.app.server.address();
    if (!address || typeof address === "string")
      throw new Error("native_fixture_server_missing");
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    const userData = join(directory, "user-data");
    await mkdir(userData, { mode: 0o700 });
    const csp =
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(
        await readFile(resolve("index.html"), "utf8"),
      )![1];
    await writeFile(
      join(directory, "index.html"),
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><div id="plugin-root"></div>`,
    );
    // Test-only source bundling; neither the UI product build nor SDK distribution is rebuilt.
    await build({
      entryPoints: [resolve("electron/desktopPluginUiNative.test-support.ts")],
      outfile: join(directory, "main.cjs"),
      platform: "node",
      format: "cjs",
      bundle: true,
      packages: "bundle",
      external: ["electron"],
      logLevel: "silent",
    });
    await build({
      entryPoints: [resolve("electron/preload.ts")],
      outfile: join(directory, "preload.cjs"),
      platform: "node",
      format: "cjs",
      bundle: true,
      external: ["electron"],
      logLevel: "silent",
    });
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        session: { baseUrl, ...pluginRouteCredentials },
        lease,
        preload: join(directory, "preload.cjs"),
        document: join(directory, "index.html"),
        userData,
      }),
    );
    const env = { ...process.env };
    for (const name of Object.keys(env))
      if (
        name.startsWith("CREWON_") ||
        name.startsWith("ELECTRON_") ||
        name === "NODE_OPTIONS" ||
        name === "AICUICAN_API_KEY"
      )
        delete env[name];
    child = spawn(
      createRequire(import.meta.url)("electron"),
      [
        join(directory, "main.cjs"),
        join(directory, "config.json"),
        `--user-data-dir=${userData}`,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    tracked = trackDesktopTestChildren(child);
    let output = "";
    child.stdout!.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr!.on("data", (bytes) => {
      output += bytes;
    });
    const code = await new Promise<number | null>((accept, reject) => {
      const timer = setTimeout(() => {
        child?.kill("SIGKILL");
        reject(new Error("native_plugin_ui_timeout"));
      }, 25_000);
      child!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once("close", (code) => {
        mainClosed = true;
        clearTimeout(timer);
        accept(code);
      });
    });
    expect(code, output).toBe(0);
    const proof = JSON.parse(
      /CREWON_NATIVE_PLUGIN_PROOF:(.+)/u.exec(output)![1],
    );
    expect(proof.electron).toBe("43.4.1");
    expect(proof.mounted).toEqual({
      pluginId: "test.counter",
      text: "1.0.0",
      node: "undefined",
      process: "undefined",
    });
    expect(proof.viewResult).toBe(false);
    expect(proof.foreignResult).toBe(false);
    expect(proof.foreignIpc).toBe(false);
    expect(proof.foreignRenewIpc).toBe(false);
    expect(proof.childResult).toBe(false);
    expect(proof.reboundResult).toBe(false);
    expect(proof.shown).toBe(false);
    expect(proof.focused).toBe(false);
    expect(proof.renewal.lease).toEqual({
      ...lease,
      expiresAt: new Date(Date.parse(lease.expiresAt) + 60_000).toISOString(),
    });
    expect(proof.renewal.sameBindingRef).toBe(true);
    expect(proof.renewal.sameEntryUrl).toMatch(
      /^crewon-plugin:\/\/ui\/[a-f0-9]{64}\/ui\/entry\.mjs$/u,
    );
    expect(proof.renewal.view).toEqual({
      chunk: pkg.content["ui/chunk.mjs"],
      status: 200,
      sameInstance: true,
      sameRoot: true,
      text: "1.0.0",
    });
    expect(
      proof.gates
        .filter((v: { cancel: boolean }) => !v.cancel)
        .map((v: { url: string }) => v.url.split("/").at(-1)),
    ).toEqual(["entry.mjs", "chunk.mjs", "chunk.mjs"]);
    expect(
      proof.gates.filter((v: { cancel: boolean }) => v.cancel),
    ).toHaveLength(4);
    expect(proof.usage).toMatchObject({
      bindings: 0,
      requests: 0,
      operations: 0,
      reservedBytes: 0,
    });
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: `/api/v1/plugins/ui/mounts/${lease.mountRef}`,
          headers: pluginRouteHeaders,
        })
      ).statusCode,
    ).toBe(404);
    console.log("Actual Electron installed UI proof:", JSON.stringify(proof));
    if (process.env.CREWON_NATIVE_PLUGIN_UI_PROOF)
      await writeFile(
        process.env.CREWON_NATIVE_PLUGIN_UI_PROOF,
        JSON.stringify(proof, null, 2) + "\n",
        { mode: 0o600 },
      );
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanup: unknown[] = [];
    if (child && !mainClosed) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child!.once("close", resolve));
      mainClosed = true;
    }
    try {
      expect(await tracked?.close()).toEqual([]);
    } catch (error) {
      cleanup.push(error);
    }
    for (const release of cleanups.reverse())
      try {
        await release();
      } catch (error) {
        cleanup.push(error);
      }
    if (cleanup.length === 0)
      await rm(directory, { recursive: true, force: true });
    if (primaryFailure !== undefined || cleanup.length)
      throw new AggregateError(
        [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanup],
        "native_plugin_ui_failed",
      );
  }
}, 40_000);
