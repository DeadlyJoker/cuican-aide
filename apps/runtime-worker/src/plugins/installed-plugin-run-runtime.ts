import { isDeepStrictEqual } from "node:util";
import type { ExtensionStore } from "@crewon/application";
import {
  parsePluginTaskAdmission,
  type PluginTaskAdmission,
  type RunState,
} from "@crewon/domain";
import type {
  ToolExecutionCommand,
  ToolRuntimePort,
} from "@crewon/tool-broker";
import type { AgentVersionRuntime } from "../agent-version-runtime.ts";
import type {
  RuntimeResourceLease,
  RuntimeResourceScope,
} from "../runtime-resource-lease.ts";
import type { RuntimePreflight } from "../runtime-preflight.ts";
import { readInstalledPluginAgentRuntimeScope } from "./installed-plugin-agent-runtime-factory-proof.ts";
import {
  parseRuntimeExtensionMaterialization,
  type RuntimeExtensionMaterialization,
} from "../extensions/extension-runtime-proof.ts";

export type PluginTaskAdmissionProbe = Pick<
  ExtensionStore,
  "pluginAdmissionVersion" | "loadPluginTaskAdmission"
>;
export type InstalledPluginRunRuntimeResolverPort = Readonly<{
  /**
   * Trusted host composition. The resolver verifies persisted Run/configuration/payer identity,
   * installed bytes and current authority, and owns the returned SDK runtime and actual Node lease.
   * Its methods must repeat current authorization at dispatch; this borrow is not permission to execute.
   */
  acquire(
    input: Readonly<{
      run: RunState;
      base: AgentVersionRuntime;
      purpose: "submit" | "observe";
      signal: AbortSignal;
    }>,
  ): Promise<RuntimeResourceLease<ToolRuntimePort> | null>;
  /** The composition closes an owned resolver after Worker admission stops. */
  close?(): Promise<void>;
}>;

export class InstalledPluginRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "InstalledPluginRuntimeError";
    this.code = code;
  }
}

/** Recovery that may replay the original call requires the same current permission as a new dispatch. */
export function installedPluginToolOperationPurpose(
  input: Readonly<{
    method: "execute" | "reconcile" | "cancel";
    command: ToolExecutionCommand;
  }>,
): "submit" | "observe" {
  switch (input.method) {
    case "execute":
      return "submit";
    case "reconcile":
      return input.command.actionIntent.recovery === "reconcilable"
        ? "observe"
        : "submit";
    case "cancel":
      return "observe";
  }
}

/** Only an authoritative absent record uses legacy execution. Errors and missing capabilities never do. */
export async function readInstalledPluginTaskAdmission(input: {
  run: RunState;
  admissions: PluginTaskAdmissionProbe | undefined;
  scope: RuntimeResourceScope;
  preflight: RuntimePreflight;
}): Promise<PluginTaskAdmission | null> {
  if (input.admissions === undefined) return null;
  const admissions = input.admissions;
  if (
    admissions.pluginAdmissionVersion !== "crewon.plugin-task-admission.v1" ||
    typeof admissions.loadPluginTaskAdmission !== "function"
  )
    fail("installed_plugin_admission_port_unavailable");
  const raw = await input.preflight.run({
    identity: {
      tenantId: input.run.tenantId,
      kind: "runtime",
      resourceId: JSON.stringify([
        "installed-admission",
        input.run.spaceId,
        input.run.runId,
      ]),
    },
    operation: () =>
      input.scope.run(() =>
        admissions.loadPluginTaskAdmission!({
          tenantId: input.run.tenantId,
          spaceId: input.run.spaceId,
          runId: input.run.runId,
        }),
      ),
  });
  if (raw === null) return null;
  let admission: PluginTaskAdmission;
  try {
    admission = parsePluginTaskAdmission(raw);
  } catch (cause) {
    throw new InstalledPluginRuntimeError(
      "installed_plugin_admission_invalid",
      { cause },
    );
  }
  const run = input.run;
  if (
    admission.tenantId !== run.tenantId ||
    admission.spaceId !== run.spaceId ||
    admission.runId !== run.runId ||
    admission.threadId !== run.threadId ||
    admission.actorId !== run.createdByActorId
  )
    fail("installed_plugin_admission_scope_mismatch");
  return admission;
}

/** The target comes from the actually constructed base owner, never from saved Run binding alone. */
export function installedPluginRunMaterialization(input: {
  run: RunState;
  base: AgentVersionRuntime;
  admission: PluginTaskAdmission;
}): RuntimeExtensionMaterialization {
  const proofs = input.base.extensions?.filter(
    (proof) => proof.configuration.pluginId === input.admission.pluginId,
  );
  if (proofs?.length !== 1)
    fail("installed_plugin_materialization_unavailable");
  let proof: RuntimeExtensionMaterialization;
  try {
    proof = parseRuntimeExtensionMaterialization(proofs[0]!);
  } catch (cause) {
    throw new InstalledPluginRuntimeError(
      "installed_plugin_materialization_invalid",
      { cause },
    );
  }
  const { run, base, admission } = input;
  const installedScope = readInstalledPluginAgentRuntimeScope(base);
  if (
    installedScope !== null &&
    (installedScope.tenantId !== admission.tenantId ||
      installedScope.spaceId !== admission.spaceId ||
      installedScope.profileId !== admission.profileId)
  )
    fail("installed_plugin_materialization_profile_mismatch");
  const target = proof.target;
  if (
    base.executionAuthority !== "crewonKernel" ||
    target.executionAuthority !== "crewonKernel" ||
    proof.configuration.tenantId !== run.tenantId ||
    proof.configuration.spaceId !== run.spaceId ||
    proof.configuration.pluginVersion !== admission.version ||
    target.agentVersionId !== base.version.agentVersionId ||
    target.agentVersionContentDigest !== base.version.contentDigest ||
    target.runtimeGeneration !== base.version.runtimeGeneration ||
    target.policySnapshotId !== base.version.policySnapshotId ||
    target.agentVersionId !== run.agentVersionId ||
    target.authorityId !== run.authorityId ||
    target.runtimeGeneration !== run.runtimeGeneration ||
    target.policySnapshotId !== run.policySnapshotId ||
    target.workspaceBindingId !== run.workspaceBindingId
  )
    fail("installed_plugin_materialization_mismatch");
  return proof;
}

/** Call inside the Worker's physical resource scope before any logical timeout can discard its result. */
export async function acquireInstalledPluginRunToolRuntime(input: {
  run: RunState;
  base: AgentVersionRuntime;
  admission: PluginTaskAdmission;
  resolver: InstalledPluginRunRuntimeResolverPort | undefined;
  purpose: "submit" | "observe";
  signal: AbortSignal;
  scope: RuntimeResourceScope;
}): Promise<ToolRuntimePort> {
  if (input.resolver === undefined)
    fail("installed_plugin_runtime_owner_unavailable");
  installedPluginRunMaterialization(input);
  input.signal.throwIfAborted();
  const lease = await input.resolver.acquire({
    run: input.run,
    base: input.base,
    purpose: input.purpose,
    signal: input.signal,
  });
  if (lease === null) fail("installed_plugin_runtime_unavailable");
  const runtime = input.scope.use(lease);
  input.signal.throwIfAborted();
  if (
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(runtime.definitions())),
      input.base.version.tools,
    )
  )
    fail("installed_plugin_runtime_tools_mismatch");
  return runtime;
}

function fail(code: string): never {
  throw new InstalledPluginRuntimeError(code);
}
