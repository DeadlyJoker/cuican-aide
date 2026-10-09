import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import { nativeProjectMainFixture } from "../src/desktop-project-startup-main.integration.test-support.ts";
import {
  startFullAppProcess,
  stopFullAppProcess,
} from "../src/installed-plugin-full-app-process.test-support.ts";
import { waitTaskProcess } from "../src/installed-plugin-tasks-process.test-support.ts";

const input = process.argv[2];
assert.ok(input, "Supply the packaged control-api.mjs path explicitly");
const entrypointPath = resolve(input);
assert.equal((await lstat(entrypointPath)).isFile(), true);

test(
  "packaged Control preserves authenticated base history across two zero-plugin, zero-model cold starts",
  { timeout: 90_000 },
  async (t) => {
    const f = await nativeProjectMainFixture(t);
    const original = await f.start();
    const threads = await original.client.listThreads();
    const effects = await f.effects();
    await original.stop();
    const environment = { ...original.environment };
    delete environment.CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH;
    assert.equal(
      Object.keys(environment).some((key) => key.startsWith("CREWON_MODEL_")),
      false,
    );
    for (let boot = 0; boot < 2; boot++) {
      const child = startFullAppProcess("control", environment, {
        entrypointPath,
      });
      try {
        await waitTaskProcess(
          "packaged base Control",
          async () => child.stdout().includes("CrewON Control API listening"),
          [child],
        );
        assert.deepEqual(await original.client.listThreads(), threads);
        const unauthorized = new ControlApiClient({
          baseUrl: original.origin,
          accessToken: "invalid-packaged-session",
          csrfToken: original.csrfToken,
          origin: original.origin,
        });
        await assert.rejects(
          unauthorized.listThreads(),
          (error: unknown) =>
            error instanceof ControlApiClientError && error.status === 401,
        );
        await assert.rejects(
          original.client.plugins.uiCatalog(),
          (error: unknown) =>
            error instanceof ControlApiClientError && error.status === 404,
        );
        assert.deepEqual(await f.effects(), effects);
      } finally {
        await stopFullAppProcess(child);
      }
    }
    assert.deepEqual(await f.providerTransports(), []);
    await f.assertNoNodeImport();
  },
);
