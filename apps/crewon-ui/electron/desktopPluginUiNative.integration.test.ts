import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { build } from "esbuild";
import { expect, it } from "vitest";
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
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const address = f.app.server.address();
    if (!address || typeof address === "string")
      throw new Error("native_fixture_server_missing");
    const baseUrl = `http://127.0.0.1:${address.port}/`;
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
      }),
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      createRequire(import.meta.url)("electron"),
      [join(directory, "main.cjs"), join(directory, "config.json")],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
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
      child!.once("exit", (code) => {
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
    expect(proof.childResult).toBe(false);
    expect(proof.reboundResult).toBe(false);
    expect(
      proof.gates
        .filter((v: { cancel: boolean }) => !v.cancel)
        .map((v: { url: string }) => v.url.split("/").at(-1)),
    ).toEqual(["entry.mjs", "chunk.mjs"]);
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
      );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child!.once("exit", resolve));
    }
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
