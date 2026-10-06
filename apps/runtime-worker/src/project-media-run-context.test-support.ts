import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mediaGenerationFixture } from "./project-media-generation.test-support.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import {
  ProjectMediaRunContext,
  type ProjectMediaRunPermission,
} from "./project-media-run-context.ts";

/** Real admitted Run and archives. Publisher/readiness/PDP and network responses are named fixtures. */
export async function mediaRunContextFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: Readonly<{ configurationFixture?: "large" }> = {},
) {
  const f = await mediaGenerationFixture(t, backend, {
    unmetered: true,
    ...options,
  });
  const policy = {
    submit: true,
    observe: true,
    active: true,
    actor: true,
    extensionRun: true,
    requests: [] as ProjectMediaRunPermission[],
    hook: undefined as
      | undefined
      | ((permission: ProjectMediaRunPermission) => Promise<void>),
  };
  const authorization = {
    authorize: async (permission: ProjectMediaRunPermission) => {
      policy.requests.push(permission);
      await policy.hook?.(permission);
      return f.decision(
        permission.action === "projectMediaRun:submit"
          ? policy.submit
          : policy.observe,
      );
    },
    assertActive: () => {
      if (!policy.active) throw new Error("named_media_run_owner_retired");
    },
  };
  const open = (next = f) => {
    const installed = new InstalledPluginRunContext({
      extensions: next.ext,
      runs: next.parent,
      installations: next.parent.pluginInstallationStore(),
      authorization: { authorize: async () => f.decision(policy.extensionRun) },
      resolveActor: async () => (policy.actor ? f.actor : null),
    });
    const reader = new ProjectMediaRunContext({
      installed,
      extensions: next.ext,
      materials: next.materials,
      metadataAuthorization: f.mediaAuthorization,
      authorization,
    });
    const load = async (
      binding: Awaited<ReturnType<typeof f.create>>["binding"],
      purpose: "submit" | "observe" = "submit",
    ) => {
      const signal = f.signal().signal;
      const snapshot = await installed.load({
        locator: {
          tenantId: binding.tenantId,
          spaceId: binding.spaceId,
          runId: binding.runId,
        },
        expectedTarget: binding.target,
        purpose,
        signal,
      });
      assert.ok(snapshot);
      const media = await reader.load(snapshot, { purpose, signal });
      assert.ok(media);
      return { snapshot, media };
    };
    return { installed, reader, load };
  };
  const current = open();
  const cold = async () => {
    const next = await f.cold();
    return { ...next, ...open({ ...f, ...next }) };
  };
  return { ...f, ...current, policy, authorization, cold };
}
