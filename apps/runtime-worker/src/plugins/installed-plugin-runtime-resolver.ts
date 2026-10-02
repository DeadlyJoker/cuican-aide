import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { PluginInstallationStore } from "@crewon/application";
import {
  extensionCanonicalJson,
  extensionToolName,
  parsePluginProfileScope,
  parsePluginTaskAdmission,
  type PluginProfileScope,
  type PluginTaskAdmission,
} from "@crewon/domain";
import {
  PluginExecutionPackage,
  pluginExecutionPackageFailureOwner,
  type PluginExecutionPackageFailureOwner,
  type PluginActivationCandidate,
  type PluginExecutionPackageBorrow,
  type PluginNodeCommitCandidate,
} from "@crewon/plugin-host";
import type { PluginToolRuntime } from "@crewon/plugin-sdk/node";
import type { ToolDefinition, ToolRuntimePort } from "@crewon/tool-broker";
import type { RuntimeResourceLease } from "../runtime-resource-lease.ts";
import type { RuntimeExtensionMaterialization } from "../extensions/extension-runtime-proof.ts";
import {
  InstalledPluginRunContext,
  type InstalledPluginRunSnapshot,
} from "./installed-plugin-run-context.ts";
import {
  installedPluginRunMaterialization,
  installedPluginToolOperationPurpose,
  type InstalledPluginRunRuntimeResolverPort,
  type PluginTaskAdmissionProbe,
} from "./installed-plugin-run-runtime.ts";
import { adaptPluginToolRuntime } from "./plugin-tool-runtime-adapter.ts";
import {
  checkedCatalog,
  snapshotContext,
} from "./plugin-tool-runtime-adapter-data.ts";
import { composeInstalledPluginToolRuntime } from "./installed-plugin-tool-runtime-router.ts";
import {
  assertPackageCandidate,
  cleanupMethods,
  fail,
  readPackage,
} from "./installed-plugin-runtime-resolver-package.ts";

export type InstalledPluginRuntimeResolverDependencies = Readonly<{
  contexts: InstalledPluginRunContext;
  admissions: Required<PluginTaskAdmissionProbe>;
  installations: PluginInstallationStore;
  installRoot: string;
  authorizePackage(
    input: Readonly<{
      candidate: PluginActivationCandidate;
      scope: PluginProfileScope;
      purpose: "submit" | "observe";
    }>,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
  maximumRuntimes?: number;
}>;
type Acquire = Parameters<InstalledPluginRunRuntimeResolverPort["acquire"]>[0];
type Prepared = Readonly<{
  admission: PluginTaskAdmission;
  proof: RuntimeExtensionMaterialization;
  snapshot: InstalledPluginRunSnapshot;
  scope: PluginProfileScope;
  names: readonly string[];
  definitions: readonly ToolDefinition[];
  policyContext: Readonly<{
    sandboxMode: "workspace-write" | "danger-full-access";
  }>;
  key: string;
}>;
type Resident = {
  package: PluginExecutionPackage;
  borrow: PluginExecutionPackageBorrow | null;
  candidate: PluginActivationCandidate;
  hasRuntime: boolean;
  cleanup: ReturnType<typeof cleanupMethods>;
  adapter: ToolRuntimePort | null;
  prepared: Prepared;
  runtimeClosed: boolean;
};
type Entry = {
  key: string;
  ready: Promise<Resident> | null;
  resident: Resident | null;
  failureOwner: PluginExecutionPackageFailureOwner | null;
  users: number;
  published: boolean;
  closing: boolean;
  closeTask: Promise<void> | null;
  waitForUsers: (() => void) | null;
};

/** Exact installed ESM execution owners; no latest-version fallback and no ownership of borrowed base tools. */
export class InstalledPluginRuntimeResolver
  implements InstalledPluginRunRuntimeResolverPort
{
  readonly #dependencies: InstalledPluginRuntimeResolverDependencies;
  readonly #maximum: number;
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #retirements = new Set<Promise<void>>();
  #closing = false;
  #closeTask: Promise<void> | null = null;

  constructor(dependencies: InstalledPluginRuntimeResolverDependencies) {
    if (
      !(dependencies.contexts instanceof InstalledPluginRunContext) ||
      dependencies.admissions.pluginAdmissionVersion !==
        "crewon.plugin-task-admission.v1" ||
      typeof dependencies.admissions.loadPluginTaskAdmission !== "function" ||
      typeof dependencies.installations.loadPackage !== "function" ||
      typeof dependencies.authorizePackage !== "function" ||
      typeof dependencies.installRoot !== "string" ||
      !isAbsolute(dependencies.installRoot)
    )
      fail("installed_plugin_runtime_dependencies_invalid");
    const maximum = dependencies.maximumRuntimes ?? 32;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32)
      fail("installed_plugin_runtime_capacity_invalid");
    this.#maximum = maximum;
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  acquire(
    input: Acquire,
  ): Promise<RuntimeResourceLease<ToolRuntimePort> | null> {
    if (this.#closing)
      return Promise.reject(
        new Error("installed_plugin_runtime_resolver_closed"),
      );
    const task = this.#acquire(input);
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task)).catch(() => {});
    return task;
  }

  async #prepare(input: Acquire): Promise<Prepared | null> {
    input.signal.throwIfAborted();
    if (input.purpose !== "submit" && input.purpose !== "observe")
      fail("installed_plugin_runtime_purpose_invalid");
    const raw = await this.#dependencies.admissions.loadPluginTaskAdmission({
      tenantId: input.run.tenantId,
      spaceId: input.run.spaceId,
      runId: input.run.runId,
    });
    input.signal.throwIfAborted();
    if (raw === null) return null;
    const admission = parsePluginTaskAdmission(raw);
    for (const [field, value] of [
      ["tenantId", input.run.tenantId],
      ["spaceId", input.run.spaceId],
      ["runId", input.run.runId],
      ["threadId", input.run.threadId],
      ["actorId", input.run.createdByActorId],
    ] as const)
      if (admission[field] !== value)
        fail("installed_plugin_admission_scope_mismatch");
    const proof = installedPluginRunMaterialization({ ...input, admission });
    const snapshot = await this.#dependencies.contexts.load({
      locator: {
        tenantId: input.run.tenantId,
        spaceId: input.run.spaceId,
        runId: input.run.runId,
      },
      expectedTarget: proof.target,
      purpose: input.purpose,
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    if (snapshot === null) fail("installed_plugin_runtime_context_missing");
    const context = snapshot.context;
    const scope = parsePluginProfileScope(context.scope);
    for (const field of ["tenantId", "spaceId", "profileId"] as const)
      if (scope[field] !== admission[field])
        fail("installed_plugin_runtime_context_mismatch");
    for (const field of ["pluginId", "version", "packageDigest"] as const)
      if (context.identity[field] !== admission[field])
        fail("installed_plugin_runtime_context_mismatch");
    if (
      context.run.runId !== admission.runId ||
      context.run.threadId !== admission.threadId ||
      context.configuration.revision !== proof.configuration.revision ||
      context.configuration.contentDigest !==
        proof.configuration.contentDigest ||
      extensionCanonicalJson(context.configuration.parameters) !==
        extensionCanonicalJson(proof.configuration.parameters) ||
      extensionCanonicalJson(context.configuration.credentialBindings) !==
        extensionCanonicalJson(proof.configuration.credentialBindings) ||
      extensionCanonicalJson(context.target) !==
        extensionCanonicalJson(proof.target)
    )
      fail("installed_plugin_runtime_context_mismatch");
    await readPackage(
      this.#dependencies.installations,
      admission,
      scope,
      input.signal,
    );
    const names = Object.freeze(
      proof.registration.manifest.tools.map((tool) =>
        extensionToolName(admission.pluginId, tool.operationId),
      ),
    );
    const catalog = checkedCatalog(input.base.version.tools);
    const definitions = Object.freeze(
      catalog.filter((tool) => names.includes(tool.name)),
    );
    if (
      definitions.length !== names.length ||
      definitions.some((tool) => tool.kind !== "function")
    )
      fail("installed_plugin_runtime_tools_mismatch");
    const verifiedMode =
      this.#dependencies.contexts.verifiedToolPermissionMode(snapshot);
    if ((input.run.toolPermissionMode ?? null) !== verifiedMode)
      fail("installed_plugin_runtime_permission_mismatch");
    const policyContext = Object.freeze({
      sandboxMode:
        verifiedMode === "fullAccess"
          ? ("danger-full-access" as const)
          : ("workspace-write" as const),
    });
    const key = `sha256:${createHash("sha256").update(extensionCanonicalJson({ admission, context, definitions, policyContext })).digest("hex")}`;
    return Object.freeze({
      admission,
      proof,
      snapshot,
      scope,
      names,
      definitions,
      policyContext,
      key,
    });
  }

  async #acquire(
    input: Acquire,
  ): Promise<RuntimeResourceLease<ToolRuntimePort> | null> {
    const prepared = await this.#prepare(input);
    this.#assertOpen(input.signal);
    if (prepared === null) return null;
    let entry = this.#entries.get(prepared.key);
    let created = false;
    if (entry?.closing) {
      await entry.closeTask;
      this.#assertOpen(input.signal);
      entry = this.#entries.get(prepared.key);
    }
    if (entry === undefined) {
      if (this.#entries.size >= this.#maximum)
        fail("installed_plugin_runtime_capacity_exhausted");
      entry = {
        key: prepared.key,
        ready: null,
        resident: null,
        failureOwner: null,
        users: 0,
        published: false,
        closing: false,
        closeTask: null,
        waitForUsers: null,
      };
      this.#entries.set(entry.key, entry);
      created = true;
      entry.ready = this.#create(entry, prepared, input);
    }
    const selected = entry;
    let resident: Resident;
    let resource: ToolRuntimePort;
    try {
      resident = await selected.ready!;
      this.#assertOpen(input.signal);
      await this.#authorize(resident, input.purpose, input.signal);
      this.#assertOpen(input.signal);
      if (selected.closing || this.#entries.get(selected.key) !== selected)
        fail("installed_plugin_runtime_retired");
      if (resident.adapter === null)
        fail("installed_plugin_runtime_unavailable");
      resource = composeInstalledPluginToolRuntime({
        base: input.base.toolRuntime,
        plugin: resident.adapter,
        pluginToolNames: prepared.names,
      });
    } catch (error) {
      if (selected.users === 0 && selected.resident !== null)
        this.#beginRetirement(
          selected,
          created && !selected.published ? "explicit" : "idle",
        );
      throw error;
    }
    selected.users++;
    selected.published = true;
    return this.#lease(selected, resource);
  }

  /** Never loads a Run, opens a package or authorizes provider work during idle receipt repair. */
  nextToolResultMaintenanceLease(): RuntimeResourceLease<ToolRuntimePort> | null {
    if (this.#closing) return null;
    // Rotate at most the bounded resident set, including entries that remain quarantined.
    for (let visited = 0; visited < this.#entries.size; visited++) {
      const first = this.#entries.entries().next().value;
      if (first === undefined) return null;
      const [key, entry] = first;
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      if (entry.closing || !entry.published || entry.resident?.adapter == null)
        continue;
      if (entry.users === 0) this.#beginRetirement(entry, "idle");
      if (entry.closing) continue;
      entry.users++;
      return this.#lease(entry, entry.resident.adapter);
    }
    return null;
  }

  #lease(
    entry: Entry,
    resource: ToolRuntimePort,
  ): RuntimeResourceLease<ToolRuntimePort> {
    let released = false;
    return Object.freeze({
      resource,
      release: () => {
        if (released) return;
        released = true;
        entry.users--;
        if (entry.users === 0) {
          entry.waitForUsers?.();
          entry.waitForUsers = null;
          if (!entry.closing) this.#beginRetirement(entry, "idle");
        }
      },
    });
  }

  async #create(
    entry: Entry,
    prepared: Prepared,
    input: Acquire,
  ): Promise<Resident> {
    let candidate: PluginActivationCandidate | null = null;
    let committedAuthority = false;
    try {
      // Old hosts that do not support this hook deny the synchronous commit below. The async
      // post-setup current-authority check can never silently degrade to an initial grant.
      const openInput = {
        activation: {
          installRoot: this.#dependencies.installRoot,
          expectedPluginId: prepared.admission.pluginId,
          expectedPackageDigest: prepared.admission.packageDigest,
          authorizeActivation: async (value: PluginActivationCandidate) => {
            this.#assertOpen(input.signal);
            const pkg = await readPackage(
              this.#dependencies.installations,
              prepared.admission,
              prepared.scope,
              input.signal,
            );
            await assertPackageCandidate({
              candidate: value,
              package: pkg,
              proof: prepared.proof,
              installRoot: this.#dependencies.installRoot,
              signal: input.signal,
            });
            await this.#authorizeCandidate(
              prepared,
              value,
              input.purpose,
              input.signal,
            );
            candidate = value;
            return "allow" as const;
          },
        },
        beforeCommit: async () => {
          this.#assertOpen(input.signal);
          if (candidate === null)
            fail("installed_plugin_runtime_candidate_missing");
          const pkg = await readPackage(
            this.#dependencies.installations,
            prepared.admission,
            prepared.scope,
            input.signal,
          );
          await assertPackageCandidate({
            candidate,
            package: pkg,
            proof: prepared.proof,
            installRoot: this.#dependencies.installRoot,
            signal: input.signal,
          });
          await this.#authorizeCandidate(
            prepared,
            candidate,
            input.purpose,
            input.signal,
          );
          this.#assertOpen(input.signal);
          committedAuthority = true;
        },
        commit: {
          authorizeCommit: (value: PluginNodeCommitCandidate) => {
            if (
              this.#closing ||
              input.signal.aborted ||
              !committedAuthority ||
              candidate === null ||
              value.identity.pluginId !== prepared.admission.pluginId ||
              value.identity.version !== prepared.admission.version ||
              value.identity.packageDigest !==
                prepared.admission.packageDigest ||
              extensionCanonicalJson(value.descriptor) !==
                extensionCanonicalJson(candidate.descriptor)
            )
              return "deny" as const;
            return "allow" as const;
          },
        },
      };
      const pkg = await PluginExecutionPackage.open(openInput);
      if (candidate === null) {
        await pkg.close();
        fail("installed_plugin_runtime_candidate_missing");
      }
      const resident: Resident = {
        package: pkg,
        borrow: null,
        candidate,
        hasRuntime: false,
        cleanup: Object.freeze({}),
        adapter: null,
        prepared,
        runtimeClosed: false,
      };
      // Adoption precedes every next await, including a factory that outlives abort or shutdown.
      entry.resident = resident;
      this.#assertOpen(input.signal);
      await this.#authorize(resident, input.purpose, input.signal);
      this.#assertOpen(input.signal);
      resident.borrow = pkg.acquire({
        purpose:
          input.purpose === "submit" ? "newOperation" : "historicalOperation",
        authorizeBorrow: (identity) =>
          identity.pluginId === prepared.admission.pluginId &&
          identity.version === prepared.admission.version &&
          identity.packageDigest === prepared.admission.packageDigest &&
          !this.#closing &&
          !input.signal.aborted
            ? "allow"
            : "deny",
      });
      const raw = await resident.borrow.factory.create(
        snapshotContext(prepared.snapshot.context),
      );
      resident.hasRuntime = true;
      resident.cleanup = cleanupMethods(raw);
      resident.adapter = adaptPluginToolRuntime({
        runtime: raw as PluginToolRuntime,
        context: prepared.snapshot.context,
        definitions: prepared.definitions,
        policyContext: prepared.policyContext,
        authorize: async (operation) => {
          const declared = prepared.proof.registration.manifest.tools.find(
            (tool) =>
              extensionToolName(
                prepared.admission.pluginId,
                tool.operationId,
              ) === operation.command.name,
          );
          const intent = operation.command.actionIntent;
          if (
            declared === undefined ||
            intent.effect !== declared.effect ||
            intent.recovery !== declared.recovery ||
            intent.capability !== declared.capability ||
            intent.approvalRequirement !== prepared.proof.approvalRequirement
          )
            fail("installed_plugin_runtime_policy_mismatch");
          await this.#authorize(
            resident,
            installedPluginToolOperationPurpose(operation),
            operation.signal,
          );
        },
      });
      if (
        resident.adapter.close === undefined &&
        resident.adapter.canRetire?.() !== true
      )
        fail("installed_plugin_runtime_cleanup_unavailable");
      // A factory may resolve after an abort: its actual resource is now owned and can be closed.
      this.#assertOpen(input.signal);
      await this.#authorize(resident, input.purpose, input.signal);
      this.#assertOpen(input.signal);
      return resident;
    } catch (error) {
      if (entry.resident === null) {
        const failureOwner = pluginExecutionPackageFailureOwner(error);
        if (failureOwner === null) this.#entries.delete(entry.key);
        else {
          // The actual failed Host remains owned even when open never returned a package.
          // Retrying this immutable key must not create another failed-cleanup instance.
          entry.failureOwner = failureOwner;
          entry.closing = true;
        }
      } else {
        try {
          await this.#dispose(entry, "explicit");
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "installed_plugin_runtime_start_failed",
          );
        }
      }
      throw error;
    }
  }

  async #authorize(
    resident: Resident,
    purpose: "submit" | "observe",
    signal: AbortSignal,
  ): Promise<void> {
    await this.#authorizeCandidate(
      resident.prepared,
      resident.candidate,
      purpose,
      signal,
    );
  }
  async #authorizeCandidate(
    prepared: Prepared,
    candidate: PluginActivationCandidate,
    purpose: "submit" | "observe",
    signal: AbortSignal,
  ): Promise<void> {
    await this.#dependencies.contexts.assertCurrent(
      prepared.snapshot,
      purpose,
      signal,
    );
    signal.throwIfAborted();
    if (
      (await this.#dependencies.authorizePackage(
        Object.freeze({ candidate, scope: prepared.scope, purpose }),
        signal,
      )) !== "allow"
    )
      fail("installed_plugin_runtime_publisher_denied");
    signal.throwIfAborted();
    // Publisher authorization may await external policy; activation/actor identity is read again.
    await this.#dependencies.contexts.assertCurrent(
      prepared.snapshot,
      purpose,
      signal,
    );
  }
  #assertOpen(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.#closing) fail("installed_plugin_runtime_resolver_closed");
  }

  #beginRetirement(entry: Entry, mode: "idle" | "explicit"): void {
    if (entry.closing || entry.resident === null || entry.users !== 0) return;
    if (mode === "idle") {
      try {
        if (entry.resident.adapter?.canRetire?.() !== true) return;
      } catch {
        return;
      }
    }
    const task = this.#dispose(entry, mode);
    this.#retirements.add(task);
    void task.finally(() => this.#retirements.delete(task)).catch(() => {});
    void task.catch(() => {}); // A failed cleanup remains in the bounded entry; explicit close reports it.
  }

  #dispose(entry: Entry, mode: "idle" | "explicit"): Promise<void> {
    if (entry.closeTask !== null) return entry.closeTask;
    entry.closing = true;
    entry.closeTask = (async () => {
      if (entry.users !== 0)
        await new Promise<void>((resolve) => {
          entry.waitForUsers = resolve;
        });
      if (entry.failureOwner !== null) {
        await entry.failureOwner.close();
        // A failed-start cleanup has no positive evidence of an executable/safely retired owner.
        // Even an unexpected successful callback cannot publish it or free its quarantine slot.
        fail("installed_plugin_runtime_cleanup_failed");
      }
      const resident = entry.resident;
      if (resident === null) return;
      const cleanup = resident.adapter ?? resident.cleanup;
      if (!resident.runtimeClosed && resident.hasRuntime) {
        if (mode === "idle" && cleanup.canRetire?.() !== true)
          fail("installed_plugin_runtime_retirement_unproven");
        if (cleanup.close !== undefined) await cleanup.close();
        else if (cleanup.canRetire?.() !== true)
          fail("installed_plugin_runtime_cleanup_unavailable");
        resident.runtimeClosed = true;
      }
      resident.borrow?.release();
      resident.borrow = null;
      await resident.package.close();
      if (this.#entries.get(entry.key) === entry)
        this.#entries.delete(entry.key);
    })();
    // Failed close remains quarantined; never resume an SDK runtime that partially shut down.
    void entry.closeTask.catch(() => {});
    return entry.closeTask;
  }

  close(): Promise<void> {
    if (this.#closeTask !== null) return this.#closeTask;
    this.#closing = true;
    this.#closeTask = (async () => {
      await Promise.allSettled([...this.#pending]);
      const results = await Promise.allSettled(
        [...this.#entries.values()].map((entry) =>
          this.#dispose(entry, "explicit"),
        ),
      );
      await Promise.allSettled([...this.#retirements]);
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length !== 0)
        throw new AggregateError(
          failures,
          "installed_plugin_runtime_close_failed",
        );
    })();
    return this.#closeTask;
  }
}
