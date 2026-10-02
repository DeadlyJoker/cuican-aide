import { createHash } from "node:crypto";
import {
  PluginInstallationError,
  assertInstalledPluginPackageIdentity,
  assertPluginSelectionPackage,
  parsePluginSelection,
  pluginInstallationNextRevision,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import { PluginInstallationApplicationService } from "./plugin-installation-application-service.ts";
import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { PluginInstallationAuthorizationPort } from "./plugin-installation-authorization-port.ts";
import type {
  InstallPluginPackageCommand,
  SelectPluginPackageCommand,
} from "./plugin-installation-commands.ts";
import type {
  PluginInstallationHostIdentity,
  PluginInstallationHostPort,
  PluginInstallationPrepareSelectionInput,
} from "./plugin-installation-host-port.ts";
import type {
  CommitPluginSelectionInput,
  PluginInstallationMutationResult,
  PluginInstallationStore,
  RecordInstalledPluginPackageInput,
} from "./plugin-installation-store-port.ts";

export const actor: ActorContext = Object.freeze({
  tenantId: "tenant-a",
  spaceId: "space-a",
  principalId: "principal-owner",
  actorId: "actor-device",
});
export const scope: PluginProfileScope = Object.freeze({
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "profile-a",
});
export const digestA = `sha256:${"a".repeat(64)}`;
export const digestB = `sha256:${"b".repeat(64)}`;
export const at = "2026-10-02T03:00:00.000Z";
export const installCommand: InstallPluginPackageCommand = Object.freeze({
  sourceId: "source-a",
  expectedPluginId: "example.story",
  expectedPackageDigest: digestA,
  expectedSelectionRevision: null,
  idempotencyKey: "install-a",
});
export const selectCommand: SelectPluginPackageCommand = Object.freeze({
  pluginId: "example.story",
  state: "enabled",
  selectedPackageDigest: digestA,
  expectedSelectionRevision: 1,
  idempotencyKey: "select-a",
});
export const identityA: PluginInstallationHostIdentity = Object.freeze({
  pluginId: "example.story",
  version: "1.0.0",
  publisherId: "example.publisher",
  packageDigest: digestA,
});
export const identityB: PluginInstallationHostIdentity = Object.freeze({
  ...identityA,
  version: "2.0.0",
  packageDigest: digestB,
});
const profileKey = (value: PluginProfileScope) =>
  JSON.stringify([value.tenantId, value.spaceId, value.profileId]);
const selectionKey = (value: PluginProfileScope, id: string) =>
  `${profileKey(value)}:${id}`;
const packageKey = (value: PluginProfileScope, digest: string) =>
  `${profileKey(value)}:${digest}`;

type ReceiptInput = Parameters<PluginInstallationStore["loadReceipt"]>[0];
export class InstallationMemoryStore implements PluginInstallationStore {
  readonly packages = new Map<string, InstalledPluginPackage>();
  readonly selections = new Map<string, PluginSelection>();
  readonly receipts = new Map<
    string,
    { digest: string; result: PluginInstallationMutationResult }
  >();
  readonly calls: string[] = [];
  commitFailure: Error | null = null;
  beforeCommit: (() => Promise<void>) | null = null;
  #receiptKey(input: ReceiptInput): string {
    return JSON.stringify([
      profileKey(input.scope),
      input.actor.principalId,
      input.actor.actorId,
      input.kind,
      input.receipt.idempotencyKey,
    ]);
  }
  async loadPackage(
    input: Parameters<PluginInstallationStore["loadPackage"]>[0],
  ) {
    this.calls.push("loadPackage");
    return (
      this.packages.get(packageKey(input.scope, input.packageDigest)) ?? null
    );
  }
  async loadSelection(
    input: Parameters<PluginInstallationStore["loadSelection"]>[0],
  ) {
    this.calls.push("loadSelection");
    return (
      this.selections.get(selectionKey(input.scope, input.pluginId)) ?? null
    );
  }
  async listPackages(
    input: Parameters<PluginInstallationStore["listPackages"]>[0],
  ) {
    this.calls.push("listPackages");
    const page = [...this.packages.values()]
      .filter(
        (pkg) =>
          profileKey(pkg) === profileKey(input.scope) &&
          (input.pluginId === null || input.pluginId === pkg.pluginId) &&
          (input.afterPackageDigest === null ||
            pkg.packageDigest > input.afterPackageDigest),
      )
      .sort((a, b) => (a.packageDigest < b.packageDigest ? -1 : 1))
      .slice(0, input.limit + 1);
    const packages = page.slice(0, input.limit);
    return {
      packages,
      next: page.length > input.limit ? packages.at(-1)!.packageDigest : null,
    };
  }
  async listSelections(
    input: Parameters<PluginInstallationStore["listSelections"]>[0],
  ) {
    this.calls.push("listSelections");
    const page = [...this.selections.values()]
      .filter(
        (item) =>
          profileKey(item) === profileKey(input.scope) &&
          (input.afterPluginId === null || item.pluginId > input.afterPluginId),
      )
      .sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1))
      .slice(0, input.limit + 1);
    const selections = page.slice(0, input.limit);
    return {
      selections,
      next: page.length > input.limit ? selections.at(-1)!.pluginId : null,
    };
  }
  async loadReceipt(
    input: ReceiptInput,
  ): Promise<PluginInstallationMutationResult | null> {
    this.calls.push("loadReceipt");
    const saved = this.receipts.get(this.#receiptKey(input));
    if (!saved) return null;
    if (saved.digest !== input.receipt.requestDigest)
      throw new PluginInstallationError(
        "plugin_installation_idempotency_conflict",
      );
    return Object.freeze({ ...saved.result, disposition: "replayed" });
  }
  async recordInstalledPackage(input: RecordInstalledPluginPackageInput) {
    this.calls.push("recordInstalledPackage");
    const id = { ...input, kind: "install" as const };
    const replay = await this.loadReceipt(id);
    if (replay !== null) {
      if (replay.kind !== "install") throw new Error("bad fixture receipt");
      return replay;
    }
    await this.beforeCommit?.();
    if (this.commitFailure) throw this.commitFailure;
    const current =
      this.selections.get(selectionKey(input.scope, input.package.pluginId)) ??
      null;
    if ((current?.revision ?? null) !== input.expectedSelectionRevision)
      throw new PluginInstallationError(
        "plugin_installation_revision_conflict",
      );
    if (current && current.publisherId !== input.package.publisherId)
      throw new PluginInstallationError(
        "plugin_installation_publisher_conflict",
      );
    const old = this.packages.get(
      packageKey(input.scope, input.package.packageDigest),
    );
    if (old) assertInstalledPluginPackageIdentity(old, input.package);
    const sameVersion = [...this.packages.values()].find(
      (pkg) =>
        profileKey(pkg) === profileKey(input.scope) &&
        pkg.pluginId === input.package.pluginId &&
        pkg.version === input.package.version,
    );
    if (sameVersion)
      assertInstalledPluginPackageIdentity(sameVersion, input.package);
    const pkg = old ?? input.package;
    const selection =
      current && current.state !== "uninstalled"
        ? current
        : parsePluginSelection({
            schemaVersion: "crewon.plugin-selection.v1",
            ...input.scope,
            pluginId: pkg.pluginId,
            publisherId: pkg.publisherId,
            revision:
              current === null
                ? 1
                : pluginInstallationNextRevision(current.revision),
            state: "disabled",
            selectedPackageDigest: pkg.packageDigest,
            updatedAt: input.package.installedAt,
            updatedByPrincipalId: input.actor.principalId,
            updatedByActorId: input.actor.actorId,
          });
    const result = Object.freeze({
      kind: "install" as const,
      disposition: "committed" as const,
      package: pkg,
      selection,
    });
    this.packages.set(packageKey(input.scope, pkg.packageDigest), pkg);
    this.selections.set(selectionKey(input.scope, pkg.pluginId), selection);
    this.receipts.set(this.#receiptKey(id), {
      digest: input.receipt.requestDigest,
      result,
    });
    return result;
  }
  async commitSelection(input: CommitPluginSelectionInput) {
    this.calls.push("commitSelection");
    const id = { ...input, kind: "select" as const };
    const replay = await this.loadReceipt(id);
    if (replay !== null) {
      if (replay.kind !== "select") throw new Error("bad fixture receipt");
      return replay;
    }
    await this.beforeCommit?.();
    if (this.commitFailure) throw this.commitFailure;
    const current = this.selections.get(
      selectionKey(input.scope, input.selection.pluginId),
    );
    if (current?.revision !== input.expectedSelectionRevision)
      throw new PluginInstallationError(
        "plugin_installation_revision_conflict",
      );
    assertPluginSelectionPackage({
      selection: input.selection,
      package:
        input.selection.selectedPackageDigest === null
          ? null
          : (this.packages.get(
              packageKey(input.scope, input.selection.selectedPackageDigest),
            ) ?? null),
    });
    const result = Object.freeze({
      kind: "select" as const,
      disposition: "committed" as const,
      selection: input.selection,
    });
    this.selections.set(
      selectionKey(input.scope, input.selection.pluginId),
      input.selection,
    );
    this.receipts.set(this.#receiptKey(id), {
      digest: input.receipt.requestDigest,
      result,
    });
    return result;
  }
}

/** Explicit synthetic trusted integration for App behavior tests; no production readiness claim. */
export function installationFixture() {
  const store = new InstallationMemoryStore();
  const state = {
    profile: scope,
    decisions: [] as Parameters<
      PluginInstallationAuthorizationPort["authorize"]
    >[0][],
    decision: { outcome: "allow" } as AuthorizationDecision,
    authorizeHook: null as
      | ((
          request: Parameters<
            PluginInstallationAuthorizationPort["authorize"]
          >[0],
        ) => Promise<AuthorizationDecision>)
      | null,
    profileHook: null as (() => Promise<PluginProfileScope>) | null,
    profileCalls: 0,
    installs: [] as Parameters<PluginInstallationHostPort["install"]>[0][],
    prepares: [] as PluginInstallationPrepareSelectionInput[],
    prepareHook: null as (() => Promise<void>) | null,
    installHook: null as (() => Promise<void>) | null,
    installFailure: null as Error | null,
    prepareFailure: null as Error | null,
    commitFailure: null as Error | null,
    abortFailure: null as Error | null,
    commits: 0,
    aborts: 0,
    now: at,
    hashes: [] as string[],
    projection: null as PluginSelection | null,
  };
  const sources = new Map([
    ["source-a", identityA],
    ["source-b", identityB],
  ]);
  const host: PluginInstallationHostPort = {
    async install(input) {
      state.installs.push(input);
      await state.installHook?.();
      if (state.installFailure) throw state.installFailure;
      const candidate = sources.get(input.sourceId);
      if (
        !candidate ||
        candidate.pluginId !== input.expectedPluginId ||
        candidate.packageDigest !== input.expectedPackageDigest
      )
        throw new Error("fixture source identity unavailable");
      return candidate;
    },
    async prepareSelection(input) {
      state.prepares.push(input);
      await state.prepareHook?.();
      if (state.prepareFailure) throw state.prepareFailure;
      return Object.freeze({
        commit({ selection }: { selection: PluginSelection }) {
          state.commits++;
          if (state.commitFailure) throw state.commitFailure;
          state.projection = selection;
        },
        async abort() {
          state.aborts++;
          if (state.abortFailure) throw state.abortFailure;
        },
      });
    },
  };
  const service = new PluginInstallationApplicationService({
    store,
    host,
    profiles: {
      async resolve() {
        state.profileCalls++;
        return state.profileHook ? state.profileHook() : state.profile;
      },
    },
    authorization: {
      async authorize(input) {
        state.decisions.push(input);
        return state.authorizeHook
          ? state.authorizeHook(input)
          : state.decision;
      },
    },
    clock: { now: () => state.now },
    digester: {
      sha256(value) {
        state.hashes.push(value);
        return `sha256:${createHash("sha256").update(value).digest("hex")}`;
      },
    },
  });
  return { service, store, host, state, sources };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
