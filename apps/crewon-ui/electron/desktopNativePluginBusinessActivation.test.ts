import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import {
  parseExtensionExecutionTarget,
  type ExtensionActivation,
} from "@crewon/domain";
import type { PluginSelectionView } from "@crewon/contracts";
import { desktopInstalledPluginRuntimeFixture } from "./desktopInstalledPluginRuntime.test-support.ts";
import {
  bindDesktopNativePluginBusinessActivation,
  setDesktopPluginSelectionWithNativeBusinessActivation,
} from "./desktopNativePluginBusinessActivation.ts";

const cleanups: (() => Promise<void>)[] = [];
async function fixture() {
  const f = await desktopInstalledPluginRuntimeFixture();
  const runtime = f.prepare();
  const entry = runtime.expectedCatalogEntries[0]!;
  bindDesktopNativePluginBusinessActivation(runtime, [entry.identity]);
  const nextDigest = `sha256:${"b".repeat(64)}`;
  let selection: PluginSelectionView = {
    pluginId: entry.identity.pluginId,
    publisherId: entry.identity.publisherId,
    revision: 3,
    state: "disabled",
    selectedPackageDigest: entry.identity.packageDigest,
    updatedAt: "2026-10-07T00:00:00.000Z",
  };
  let activation: ExtensionActivation | null = null;
  const requests: {
    method: string;
    path: string;
    key: string | null;
    body: unknown;
  }[] = [];
  let afterCommit = () => {};
  const client = new ControlApiClient({
    baseUrl: "https://named-upgrade-control.test",
    origin: "https://named-upgrade-ui.test",
    accessToken: "named-token",
    csrfToken: "named-csrf",
    fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : null;
      requests.push({
        method,
        path,
        key: new Headers(init.headers).get("idempotency-key"),
        body,
      });
      if (method === "GET" && path.endsWith("/activation"))
        return Response.json({ activation });
      if (
        method === "GET" &&
        path === `/api/v1/plugins/selections/${entry.identity.pluginId}`
      )
        return Response.json({ selection });
      if (
        method === "PUT" &&
        path === `/api/v1/plugins/selections/${entry.identity.pluginId}`
      ) {
        expect(body.expectedSelectionRevision).toBe(selection.revision);
        selection = { ...selection, ...body, revision: selection.revision + 1 };
        Reflect.deleteProperty(selection, "expectedSelectionRevision");
        const mutation = {
          kind: "select",
          disposition: "committed",
          selection,
        };
        afterCommit();
        return Response.json({ mutation, projection: { outcome: "applied" } });
      }
      throw new Error(
        `Unexpected Native version-switch request: ${method} ${path}`,
      );
    },
  });
  const command = {
    pluginId: entry.identity.pluginId,
    request: {
      state: "disabled" as const,
      selectedPackageDigest: nextDigest,
      expectedSelectionRevision: 3,
    },
    idempotencyKey: "named-native-version-switch",
  };
  const api = {
    f,
    runtime,
    requests,
    command,
    get selection() {
      return selection;
    },
    set selection(value: PluginSelectionView) {
      selection = value;
    },
    set activation(value: ExtensionActivation | null) {
      activation = value;
    },
    set afterCommit(value: () => void) {
      afterCommit = value;
    },
    enabledActivation(): ExtensionActivation {
      return {
        tenantId: runtime.scope.tenantId,
        spaceId: runtime.scope.spaceId,
        schemaVersion: "crewon.extension-activation.v0",
        pluginId: entry.identity.pluginId,
        revision: 1,
        configurationRevision: f.release.entries[0]!.configuration.revision,
        configurationDigest: f.release.entries[0]!.configuration.contentDigest,
        state: "enabled",
        target: parseExtensionExecutionTarget(entry.configuredTarget),
        updatedByActorId: "named-actor",
        updatedAt: "2026-10-07T00:00:00.000Z",
      };
    },
    select: () =>
      setDesktopPluginSelectionWithNativeBusinessActivation({
        runtime,
        client,
        command,
        signal: f.controller.signal,
      }),
  };
  cleanups.push(async () => {
    await runtime.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  return api;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("selects a disabled replacement through the real typed client without reconciling it against the old pinned release", async () => {
  const f = await fixture();
  const result = await f.select();
  expect(result.mutation.selection).toEqual(f.selection);
  expect(f.selection.state).toBe("disabled");
  expect(f.selection.selectedPackageDigest).toBe(
    f.command.request.selectedPackageDigest,
  );
  const writes = f.requests.filter((item) => item.method !== "GET");
  expect(writes).toEqual([
    {
      method: "PUT",
      path: `/api/v1/plugins/selections/${f.command.pluginId}`,
      key: f.command.idempotencyKey,
      body: f.command.request,
    },
  ]);
});

it.each(["selection", "activation"])(
  "refuses to change versions while the original %s remains enabled",
  async (kind) => {
    const f = await fixture();
    if (kind === "selection")
      f.selection = { ...f.selection, state: "enabled" };
    else f.activation = f.enabledActivation();
    await expect(f.select()).rejects.toThrow("version_change_requires_disable");
    expect(f.requests.every((item) => item.method === "GET")).toBe(true);
  },
);

it.each(["selection", "activation", "owner"])(
  "does not acknowledge a replaced %s after the durable disabled selection",
  async (kind) => {
    const f = await fixture();
    f.afterCommit = () => {
      if (kind === "selection")
        f.selection = { ...f.selection, revision: f.selection.revision + 1 };
      else if (kind === "activation") f.activation = f.enabledActivation();
      else f.runtime.withdraw();
    };
    await expect(f.select()).rejects.toThrow();
    expect(f.requests.filter((item) => item.method !== "GET")).toHaveLength(1);
    expect(f.selection.state).toBe("disabled");
  },
);
