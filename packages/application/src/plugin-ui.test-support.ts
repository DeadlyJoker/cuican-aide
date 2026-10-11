import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  parsePluginPackageDescriptor,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { PluginInstallationStore } from "./plugin-installation-store-port.ts";
import {
  PluginUiApplicationService,
  type PluginUiApplicationLimits,
} from "./plugin-ui-application-service.ts";
import type {
  PluginUiAuthorizationAction,
  PluginUiJsonValue,
  PluginUiPackageContext,
} from "./plugin-ui-ports.ts";

export const uiTestActor: ActorContext = Object.freeze({
  tenantId: "tenant-a",
  spaceId: "space-a",
  principalId: "principal-a",
  actorId: "actor-a",
});
export const uiTestScope: PluginProfileScope = Object.freeze({
  tenantId: "tenant-a",
  spaceId: "space-a",
  profileId: "profile-a",
});
export const uiTestDigest = `sha256:${"a".repeat(64)}`;
export const uiTestAt = "2026-10-02T03:00:00.000Z";
export const uiTestBytes = new TextEncoder().encode("export default {};");
export const uiTestDescriptor = parsePluginPackageDescriptor({
  schemaVersion: "crewon.plugin-package.v1",
  hostApi: "crewon.plugin-host.v1",
  pluginId: "example.story",
  version: "1.0.0",
  title: "Story",
  description: "Independent UI",
  publisherId: "example.publisher",
  entrypoints: {
    node: "node.mjs",
    ui: { path: "ui.mjs", mode: "trustedModule" },
  },
  businessManifestPath: null,
  requires: [],
  provides: [],
  contributions: [
    {
      id: "workbench",
      kind: "module",
      slot: "main.content",
      title: "Story workbench",
    },
  ],
  files: ["ui.mjs", "node.mjs"].map((path) => ({
    path,
    byteLength: uiTestBytes.byteLength,
    sha256: createHash("sha256").update(uiTestBytes).digest("hex"),
  })),
});
export const uiTestPackage = parseInstalledPluginPackage({
  schemaVersion: "crewon.installed-plugin-package.v1",
  ...uiTestScope,
  pluginId: uiTestDescriptor.pluginId,
  version: uiTestDescriptor.version,
  publisherId: uiTestDescriptor.publisherId,
  packageDigest: uiTestDigest,
  installedAt: uiTestAt,
  installedByPrincipalId: uiTestActor.principalId,
  installedByActorId: uiTestActor.actorId,
});
export const uiTestSelection = parsePluginSelection({
  schemaVersion: "crewon.plugin-selection.v1",
  ...uiTestScope,
  pluginId: uiTestDescriptor.pluginId,
  publisherId: uiTestDescriptor.publisherId,
  revision: 2,
  state: "enabled",
  selectedPackageDigest: uiTestDigest,
  updatedAt: uiTestAt,
  updatedByPrincipalId: uiTestActor.principalId,
  updatedByActorId: uiTestActor.actorId,
});
export const uiTestMountCommand = Object.freeze({
  pluginId: "example.story",
  contributionId: "workbench",
  expectedSelectionRevision: 2,
  expectedPackageDigest: uiTestDigest,
});
export function uiDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Explicit trusted in-memory fixture; this is not a production policy, directory or Run adapter. */
export function uiFixture(
  limits?: PluginUiApplicationLimits,
  catalogInspection?: (input: PluginUiPackageContext) => Promise<boolean>,
) {
  const state = {
    scope: uiTestScope,
    selection: uiTestSelection as PluginSelection | null,
    package: uiTestPackage,
    descriptor: uiTestDescriptor as PluginPackageDescriptor,
    publicAssets: ["ui.mjs"] as readonly string[],
    epoch: "epoch-a",
    now: uiTestAt,
    nextId: "r".repeat(40),
    allowed: new Set<PluginUiAuthorizationAction>([
      "catalog",
      "mount",
      "asset",
      "invoke",
    ]),
    beforeProfile: null as (() => Promise<void>) | null,
    beforeAuthorize: null as
      | ((action: PluginUiAuthorizationAction) => Promise<void>)
      | null,
    beforeSelection: null as (() => Promise<void>) | null,
    beforeVerify: null as (() => Promise<void>) | null,
    beforeRead: null as (() => Promise<void>) | null,
    beforeInvoke: null as (() => Promise<void>) | null,
    authorizationOverride: undefined as unknown,
    verifyOverride: undefined as unknown,
    readOverride: undefined as unknown,
    actionOverride: undefined as unknown,
    pageOverride: undefined as unknown,
    calls: [] as string[],
    authorizationResources: [] as unknown[],
    contexts: [] as PluginUiPackageContext[],
    actionInputs: [] as PluginUiJsonValue[],
  };
  const unsupported = async (): Promise<never> => {
    throw new Error("fixture_write_not_supported");
  };
  const store: PluginInstallationStore = {
    async loadSelection(input) {
      state.calls.push("selection");
      await state.beforeSelection?.();
      return state.selection?.pluginId === input.pluginId
        ? state.selection
        : null;
    },
    async loadPackage() {
      state.calls.push("package");
      return state.package;
    },
    async listSelections() {
      state.calls.push("page");
      return state.pageOverride === undefined
        ? { selections: state.selection ? [state.selection] : [], next: null }
        : (state.pageOverride as Awaited<
            ReturnType<PluginInstallationStore["listSelections"]>
          >);
    },
    listPackages: unsupported,
    loadReceipt: unsupported,
    recordInstalledPackage: unsupported,
    commitSelection: unsupported,
  };
  const service = new PluginUiApplicationService({
    store,
    profiles: {
      async resolve() {
        await state.beforeProfile?.();
        return state.scope;
      },
    },
    authorization: {
      async authorize(input) {
        state.calls.push(`authorize:${input.action}`);
        state.authorizationResources.push(input.resource);
        await state.beforeAuthorize?.(input.action);
        return state.authorizationOverride !== undefined
          ? (state.authorizationOverride as never)
          : state.allowed.has(input.action)
            ? { outcome: "allow", authorityEpoch: state.epoch }
            : { outcome: "deny", reasonCode: "denied" };
      },
    },
    packages: {
      ...(catalogInspection ? { isNodeOnly: catalogInspection } : {}),
      async verify(input) {
        state.calls.push("verify");
        state.contexts.push(input);
        await state.beforeVerify?.();
        return state.verifyOverride !== undefined
          ? (state.verifyOverride as never)
          : { descriptor: state.descriptor, publicAssets: state.publicAssets };
      },
      async readAsset(input) {
        state.calls.push("read");
        state.contexts.push(input);
        await state.beforeRead?.();
        return state.readOverride !== undefined
          ? (state.readOverride as never)
          : {
              bytes: uiTestBytes,
              contentType: "text/javascript; charset=utf-8",
            };
      },
    },
    actions: {
      async invoke(input) {
        state.calls.push("invoke");
        state.actionInputs.push(input.input);
        await state.beforeInvoke?.();
        // Real fixture allowlist and a final dispatch fence, rather than arbitrary name forwarding.
        if (input.action !== "echo")
          throw new ApplicationError(
            "authorization",
            "plugin_ui_action_unavailable",
          );
        if (
          state.selection?.state !== "enabled" ||
          state.selection.revision !== input.selection.revision ||
          state.selection.selectedPackageDigest !==
            input.package.packageDigest ||
          state.epoch !== input.authorityEpoch ||
          !state.allowed.has("invoke") ||
          Date.parse(state.now) >= Date.parse(input.lease.expiresAt)
        )
          throw new ApplicationError("conflict", "fixture_dispatch_fenced");
        return state.actionOverride !== undefined
          ? (state.actionOverride as never)
          : input.input;
      },
    },
    ids: { nextId: () => state.nextId },
    clock: { now: () => state.now },
    ...(limits === undefined ? {} : { limits }),
  });
  return { service, state, store };
}
export async function uiRejects(
  action: () => Promise<unknown>,
  category: string,
  code: string,
) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.category, category);
    assert.equal(error.code, code);
    return true;
  });
}
