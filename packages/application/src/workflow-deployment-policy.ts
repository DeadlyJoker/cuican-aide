import type {
  RunState,
  WorkflowContentDigester,
  WorkflowNodeDefinition,
} from "@crewon/domain";
import { parseCompiledWorkflowVersion } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { canonicalJson } from "./canonical-json.ts";
import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { AgentVersionAsset } from "./agent-version-store-port.ts";
import type { AgentVersionDeployment } from "./agent-version-deployment-store-port.ts";
import { compileAgentVersionReleaseBundle } from "./agent-version-release-application-service.ts";
import type { ActiveAgentVersionRelease } from "./agent-version-release-store-port.ts";
import type { WorkflowVersionAsset } from "./workflow-version-store-port.ts";
import type { RunRoute } from "./run-commands.ts";
import type { WorkflowHumanGateAuthority } from "./workflow-human-gate-port.ts";

/** Trusted host configuration, never a model/client-selected execution grant. */
export type WorkflowDeploymentConfiguration = Readonly<{
  schemaVersion: "crewon.workflow-deployment.v1";
  issuer: ActorContext;
  route: RunRoute;
  allowedAgentVersionIds: readonly string[];
  maximumParallelNodes: number;
  humanGates: readonly Readonly<{
    approvalPolicyId: string;
    approver: ActorContext;
  }>[];
}>;
export type WorkflowAgentVersionMetadata = Readonly<{
  agentVersionId: string;
  contentDigest: string;
  runtimeGeneration: string;
  policySnapshotId: string;
  resources: Readonly<{ workspaceRequired: boolean }>;
}>;
/** Must digest-verify and parse the actual immutable asset using the existing AgentVersion compiler. */
export type WorkflowAgentVersionDecoder = (
  asset: AgentVersionAsset,
) => WorkflowAgentVersionMetadata;
/** All reads belong to the caller's actual admission/scheduler transaction. */
export type WorkflowDeploymentReader = Readonly<{
  loadActiveRelease(
    tenantId: string,
  ): Promise<ActiveAgentVersionRelease | null>;
  loadAgentVersion(
    tenantId: string,
    agentVersionId: string,
  ): Promise<AgentVersionAsset | null>;
  loadDeployment(
    tenantId: string,
    agentVersionId: string,
  ): Promise<AgentVersionDeployment | null>;
}>;

/** Same transaction-bound reads, with no Promise permitted inside SQLite writes. */
export type WorkflowDeploymentSyncReader = Readonly<{
  loadActiveRelease(tenantId: string): ActiveAgentVersionRelease | null;
  loadAgentVersion(
    tenantId: string,
    agentVersionId: string,
  ): AgentVersionAsset | null;
  loadDeployment(
    tenantId: string,
    agentVersionId: string,
  ): AgentVersionDeployment | null;
}>;

export function captureWorkflowDeploymentConfiguration(
  value: WorkflowDeploymentConfiguration,
): WorkflowDeploymentConfiguration {
  const row = data(value, [
    "schemaVersion",
    "issuer",
    "route",
    "allowedAgentVersionIds",
    "maximumParallelNodes",
    "humanGates",
  ]);
  if (row.schemaVersion !== "crewon.workflow-deployment.v1") invalid();
  const issuer = actor(row.issuer),
    route = data(row.route, [
      "authorityId",
      "agentVersionId",
      "runtimeGeneration",
      "policySnapshotId",
      "workspaceBindingId",
    ]);
  for (const field of [
    "authorityId",
    "agentVersionId",
    "runtimeGeneration",
    "policySnapshotId",
  ])
    id(route[field]);
  if (route.workspaceBindingId !== null) id(route.workspaceBindingId);
  if (
    !Number.isSafeInteger(row.maximumParallelNodes) ||
    Number(row.maximumParallelNodes) < 1 ||
    Number(row.maximumParallelNodes) > 4
  )
    invalid();
  const allowed = array(row.allowedAgentVersionIds, 65).map(id);
  if (
    !allowed.length ||
    new Set(allowed).size !== allowed.length ||
    !allowed.includes(String(route.agentVersionId))
  )
    invalid();
  const gates = array(row.humanGates, 64).map((value) => {
    const gate = data(value, ["approvalPolicyId", "approver"]),
      approver = actor(gate.approver);
    if (
      approver.tenantId !== issuer.tenantId ||
      approver.spaceId !== issuer.spaceId
    )
      invalid();
    return Object.freeze({
      approvalPolicyId: id(gate.approvalPolicyId),
      approver,
    });
  });
  if (new Set(gates.map((gate) => gate.approvalPolicyId)).size !== gates.length)
    invalid();
  return Object.freeze({
    schemaVersion: "crewon.workflow-deployment.v1",
    issuer,
    route: Object.freeze(route) as RunRoute,
    allowedAgentVersionIds: Object.freeze(allowed),
    maximumParallelNodes: Number(row.maximumParallelNodes),
    humanGates: Object.freeze(gates),
  });
}

/** Shared admission, child dispatch and human-gate policy; execution still uses ordinary Runs. */
export class WorkflowDeploymentPolicy {
  readonly configuration: WorkflowDeploymentConfiguration;
  readonly #decode: WorkflowAgentVersionDecoder;
  readonly #digester: WorkflowContentDigester;
  constructor(
    configuration: WorkflowDeploymentConfiguration,
    decode: WorkflowAgentVersionDecoder,
    digester: WorkflowContentDigester,
  ) {
    this.configuration = captureWorkflowDeploymentConfiguration(configuration);
    this.#decode = decode;
    this.#digester = digester;
  }

  async resolveAdmissionRoute(
    input: {
      tenantId: string;
      spaceId: string;
      workflowVersion: WorkflowVersionAsset;
    },
    reader: WorkflowDeploymentReader,
  ): Promise<RunRoute> {
    const versions = this.admissionVersions(input);
    const active = await reader.loadActiveRelease(input.tenantId);
    this.assertActiveRelease(active, input.tenantId);
    for (const version of versions) {
      const retained = await this.route(version, reader);
      this.assertActiveDeployment(active!, version, retained.deployment);
    }
    return { ...this.configuration.route };
  }

  resolveAdmissionRouteSync(
    input: {
      tenantId: string;
      spaceId: string;
      workflowVersion: WorkflowVersionAsset;
    },
    reader: WorkflowDeploymentSyncReader,
  ): RunRoute {
    const versions = this.admissionVersions(input);
    const active = reader.loadActiveRelease(input.tenantId);
    this.assertActiveRelease(active, input.tenantId);
    for (const version of versions)
      this.assertActiveDeployment(
        active!,
        version,
        this.routeSync(version, reader).deployment,
      );
    return { ...this.configuration.route };
  }

  private admissionVersions(input: {
    tenantId: string;
    spaceId: string;
    workflowVersion: WorkflowVersionAsset;
  }) {
    const cfg = this.configuration;
    if (
      input.tenantId !== cfg.issuer.tenantId ||
      input.spaceId !== cfg.issuer.spaceId ||
      input.workflowVersion.tenantId !== input.tenantId
    )
      deny("workflow_deployment_scope_denied");
    const workflow = parseCompiledWorkflowVersion(
      input.workflowVersion.definitionJson,
      this.#digester,
    );
    if (
      workflow.workflowId !== input.workflowVersion.workflowId ||
      workflow.workflowVersionId !== input.workflowVersion.workflowVersionId ||
      workflow.contentDigest !== input.workflowVersion.contentDigest
    )
      deny("workflow_deployment_version_mismatch");
    const versions = new Set([
      cfg.route.agentVersionId,
      ...workflow.nodes.flatMap((node) =>
        node.kind === "humanGate" ? [] : [agentId(node)],
      ),
    ]);
    for (const node of workflow.nodes)
      if (
        node.kind === "humanGate" &&
        !cfg.humanGates.some(
          (gate) => gate.approvalPolicyId === node.approvalPolicyId,
        )
      )
        deny("workflow_gate_policy_unconfigured");
    return versions;
  }

  private assertActiveRelease(
    active: ActiveAgentVersionRelease | null,
    tenantId: string,
  ): void {
    if (
      !active ||
      active.bundle.tenantId !== tenantId ||
      active.activation.tenantId !== tenantId ||
      active.activation.releaseId !== active.bundle.releaseId ||
      active.bundle.releaseId !==
        compileAgentVersionReleaseBundle(active.bundle, this.#digester)
          .releaseId
    )
      deny("workflow_deployment_release_missing");
  }
  private assertActiveDeployment(
    active: ActiveAgentVersionRelease,
    version: string,
    stored: AgentVersionDeployment,
  ): void {
    const deployed = active.bundle.deployments.find(
      (item) => item.agentVersionId === version,
    );
    if (
      !deployed ||
      [
        "tenantId",
        "agentVersionId",
        "contentDigest",
        "materializationDigest",
        "authorityId",
        "workspaceBindingId",
      ].some(
        (key) =>
          deployed[key as keyof typeof deployed] !==
          stored[key as keyof typeof stored],
      )
    )
      deny("workflow_agent_not_active");
  }

  async authorizeScheduler(
    run: RunState,
    reader: WorkflowDeploymentReader,
  ): Promise<AuthorizationDecision> {
    this.assertRoot(run);
    await this.route(run.agentVersionId, reader);
    return { outcome: "allow" };
  }

  async resolveChildRoute(
    parent: RunState,
    node: WorkflowNodeDefinition,
    reader: WorkflowDeploymentReader,
  ): Promise<RunRoute> {
    this.assertRoot(parent);
    if (node.kind === "humanGate") deny("workflow_child_gate_unsupported");
    return (await this.route(agentId(node), reader)).route;
  }

  authorizeSchedulerSync(
    run: RunState,
    reader: WorkflowDeploymentSyncReader,
  ): AuthorizationDecision {
    this.assertRoot(run);
    this.routeSync(run.agentVersionId, reader);
    return { outcome: "allow" };
  }
  resolveChildRouteSync(
    parent: RunState,
    node: WorkflowNodeDefinition,
    reader: WorkflowDeploymentSyncReader,
  ): RunRoute {
    this.assertRoot(parent);
    if (node.kind === "humanGate") deny("workflow_child_gate_unsupported");
    return this.routeSync(agentId(node), reader).route;
  }

  async authorizeGate(
    input: {
      run: RunState;
      actor: ActorContext;
      authority: WorkflowHumanGateAuthority;
    },
    reader: WorkflowDeploymentReader,
  ): Promise<AuthorizationDecision> {
    this.assertGate(input);
    await this.route(input.run.agentVersionId, reader);
    return { outcome: "allow" };
  }

  authorizeGateSync(
    input: {
      run: RunState;
      actor: ActorContext;
      authority: WorkflowHumanGateAuthority;
    },
    reader: WorkflowDeploymentSyncReader,
  ): AuthorizationDecision {
    this.assertGate(input);
    this.routeSync(input.run.agentVersionId, reader);
    return { outcome: "allow" };
  }
  private assertGate(input: {
    run: RunState;
    actor: ActorContext;
    authority: WorkflowHumanGateAuthority;
  }): void {
    this.assertRoot(input.run);
    const policy = this.configuration.humanGates.find(
      (gate) => gate.approvalPolicyId === input.authority.approvalPolicyId,
    );
    if (
      !policy ||
      canonicalJson(policy.approver) !== canonicalJson(input.actor) ||
      input.authority.runId !== input.run.runId ||
      input.authority.tenantId !== input.run.tenantId ||
      input.authority.spaceId !== input.run.spaceId ||
      canonicalJson(input.authority.binding) !==
        canonicalJson(input.run.workflowVersionBinding)
    )
      deny("workflow_gate_authorization_denied");
  }

  private assertRoot(run: RunState): void {
    const cfg = this.configuration;
    if (
      run.tenantId !== cfg.issuer.tenantId ||
      run.spaceId !== cfg.issuer.spaceId ||
      run.createdByActorId !== cfg.issuer.actorId ||
      run.purpose !== "workflow" ||
      !run.workflowVersionBinding ||
      [
        "authorityId",
        "runtimeGeneration",
        "agentVersionId",
        "policySnapshotId",
        "workspaceBindingId",
      ].some(
        (key) =>
          run[key as keyof RunState] !== cfg.route[key as keyof RunRoute],
      )
    )
      deny("workflow_deployment_scope_denied");
  }
  private async route(
    agentVersionId: string,
    reader: WorkflowDeploymentReader,
  ) {
    const cfg = this.configuration;
    if (!cfg.allowedAgentVersionIds.includes(agentVersionId))
      deny("workflow_agent_not_allowed");
    const asset = await reader.loadAgentVersion(
      cfg.issuer.tenantId,
      agentVersionId,
    );
    const deployment = await reader.loadDeployment(
      cfg.issuer.tenantId,
      agentVersionId,
    );
    return this.checkedRoute(agentVersionId, asset, deployment);
  }
  private routeSync(
    agentVersionId: string,
    reader: WorkflowDeploymentSyncReader,
  ) {
    if (!this.configuration.allowedAgentVersionIds.includes(agentVersionId))
      deny("workflow_agent_not_allowed");
    return this.checkedRoute(
      agentVersionId,
      reader.loadAgentVersion(
        this.configuration.issuer.tenantId,
        agentVersionId,
      ),
      reader.loadDeployment(this.configuration.issuer.tenantId, agentVersionId),
    );
  }
  private checkedRoute(
    agentVersionId: string,
    asset: AgentVersionAsset | null,
    deployment: AgentVersionDeployment | null,
  ) {
    const cfg = this.configuration;
    if (
      !asset ||
      !deployment ||
      asset.tenantId !== cfg.issuer.tenantId ||
      deployment.tenantId !== cfg.issuer.tenantId ||
      asset.agentVersionId !== agentVersionId ||
      deployment.agentVersionId !== agentVersionId ||
      asset.contentDigest !== deployment.contentDigest
    )
      deny("workflow_agent_not_deployed");
    const version = this.#decode(asset);
    if (
      version.agentVersionId !== agentVersionId ||
      version.contentDigest !== asset.contentDigest ||
      version.runtimeGeneration !== cfg.route.runtimeGeneration ||
      version.policySnapshotId !== cfg.route.policySnapshotId ||
      version.resources.workspaceRequired !==
        (deployment.workspaceBindingId !== null) ||
      deployment.authorityId !== cfg.route.authorityId ||
      deployment.workspaceBindingId !== cfg.route.workspaceBindingId
    )
      deny("workflow_agent_route_denied");
    return { route: { ...cfg.route, agentVersionId }, deployment };
  }
}
function agentId(
  node: Exclude<WorkflowNodeDefinition, { kind: "humanGate" }>,
): string {
  return node.kind === "agent"
    ? node.agentVersionId
    : node.verifierAgentVersionId;
}
function deny(code: string): never {
  throw new ApplicationError("authorization", code);
}
function invalid(): never {
  throw new ApplicationError(
    "validation",
    "workflow_deployment_configuration_invalid",
  );
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    new TextEncoder().encode(value).byteLength > 512
  )
    invalid();
  return value;
}
function data(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid();
  const names = Reflect.ownKeys(value);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    invalid();
  return Object.fromEntries(
    names.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        invalid();
      return [key, descriptor.value];
    }),
  );
}
function actor(value: unknown): ActorContext {
  const row = data(value, ["actorId", "principalId", "tenantId", "spaceId"]);
  return Object.freeze({
    actorId: id(row.actorId),
    principalId: id(row.principalId),
    tenantId: id(row.tenantId),
    spaceId: id(row.spaceId),
  });
}
function array(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      invalid();
    return descriptor.value;
  });
}
