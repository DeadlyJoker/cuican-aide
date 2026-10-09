import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import { nativeProjectMainFixture } from "./desktop-project-startup-main.integration.test-support.ts";

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
