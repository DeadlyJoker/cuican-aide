import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import { nativeProjectMainFixture } from "./desktop-project-startup-main.integration.test-support.ts";
import {
  startFullAppProcess,
  stopFullAppProcess,
} from "./installed-plugin-full-app-process.test-support.ts";
import { waitTaskProcess } from "./installed-plugin-tasks-process.test-support.ts";

test(
  "actual base Main preserves authenticated history without plugin approval or a model provider",
  { timeout: 90_000 },
  async (t) => {
    const f = await nativeProjectMainFixture(t);
    const approved = await f.start();
    const threads = await approved.client.listThreads();
    const effects = await f.effects();
    await approved.stop();
    const environment = { ...approved.environment };
    delete environment.CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH;
    assert.equal(
      Object.keys(environment).some((key) => key.startsWith("CREWON_MODEL_")),
      false,
    );
    const child = startFullAppProcess("control", environment);
    t.after(() => stopFullAppProcess(child));
    await waitTaskProcess(
      "actual base Main without Native plugin approval",
      async () => child.stdout().includes("CrewON Control API listening"),
      [child],
    );
    assert.deepEqual(await approved.client.listThreads(), threads);
    const unauthorized = new ControlApiClient({
      baseUrl: `http://127.0.0.1:${approved.port}`,
      accessToken: "unauthorized-base-session",
      csrfToken: approved.csrfToken,
      origin: approved.origin,
    });
    await assert.rejects(
      unauthorized.listThreads(),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 401,
    );
    await assert.rejects(
      approved.client.plugins.uiCatalog(),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 404,
    );
    assert.deepEqual(await f.effects(), effects);
  },
);

test(
  "actual Main keeps authenticated base reads and original business history after all profile plugins are uninstalled and the process restarts",
  { timeout: 90_000 },
  async (t) => {
    const f = await nativeProjectMainFixture(t);
    const effects = await f.effects();
    const first = await f.start();
    const lease = await first.mount();
    const threads = await first.client.listThreads();
    const packages = await first.client.plugins.listPackages();
    assert.ok(packages.packages.length > 0);

    let afterPluginId: string | null = null;
    const selections = [];
    do {
      const page = await first.client.plugins.listSelections({ afterPluginId });
      selections.push(...page.selections);
      afterPluginId = page.next;
    } while (afterPluginId !== null);
    assert.ok(selections.some((s) => s.state === "enabled"));
    for (const selection of selections) {
      if (selection.state === "uninstalled") continue;
      const receipt = await first.client.plugins.setSelection(
        selection.pluginId,
        {
          state: "uninstalled",
          selectedPackageDigest: null,
          expectedSelectionRevision: selection.revision,
        },
        `zero-plugins-uninstall-${selection.pluginId}`,
      );
      assert.equal(receipt.mutation.selection.state, "uninstalled");
    }
    assert.deepEqual(await first.client.plugins.uiCatalog(), {
      plugins: [],
      next: null,
    });
    await assert.rejects(first.client.plugins.validateMount(lease.mountRef));
    assert.deepEqual(await first.client.listThreads(), threads);
    assert.deepEqual(await f.effects(), effects);
    await first.stop();

    const second = await f.start();
    assert.notEqual(second.child.child.pid, first.child.child.pid);
    assert.deepEqual(await second.client.plugins.uiCatalog(), {
      plugins: [],
      next: null,
    });
    assert.deepEqual(await second.client.listThreads(), threads);
    assert.deepEqual(await second.client.plugins.listPackages(), packages);
    for (const selection of selections) {
      const current = await second.client.plugins.getSelection(
        selection.pluginId,
      );
      assert.equal(current.selection?.state, "uninstalled");
      assert.equal(current.selection.selectedPackageDigest, null);
    }
    const staleSession = new ControlApiClient({
      baseUrl: second.origin,
      accessToken: first.sessionToken,
      csrfToken: first.csrfToken,
      origin: second.origin,
    });
    await assert.rejects(
      staleSession.listThreads(),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 401,
    );
    await assert.rejects(
      staleSession.plugins.uiCatalog(),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 401,
    );
    assert.deepEqual(await f.effects(), effects);
    assert.deepEqual(await f.providerTransports(), []);
    await f.assertNoNodeImport();
    await second.stop();
  },
);

test(
  "actual Main retains plugin discovery and authenticated history when the default runtime has no plugin execution owner",
  { timeout: 90_000 },
  async (t) => {
    const f = await nativeProjectMainFixture(t);
    const approved = await f.start();
    const threads = await approved.client.listThreads();
    const packages = await approved.client.plugins.listPackages();
    const effects = await f.effects();
    await approved.stop();
    const environment = { ...approved.environment };
    delete environment.CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH;
    delete environment.CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH;
    delete environment.CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH;
    const child = startFullAppProcess("control", environment);
    t.after(() => stopFullAppProcess(child));
    await waitTaskProcess(
      "actual metadata Main without plugin execution owner",
      async () => child.stdout().includes("CrewON Control API listening"),
      [child],
    );
    assert.deepEqual(await approved.client.listThreads(), threads);
    assert.deepEqual(await approved.client.plugins.listPackages(), packages);
    assert.deepEqual(await f.effects(), effects);
  },
);
