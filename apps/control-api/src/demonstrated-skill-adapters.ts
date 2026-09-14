import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  ApplicationError,
  type ActorContext,
  type AgentVersionStore,
  type ContentDigester,
  type ModelCallStore,
  type RunApplicationService,
  type SkillExecutionAuthorizationPort,
  type SkillRunEvidencePort,
} from "@crewon/application";
import { validateModelCallRecord } from "@crewon/domain";

/** Local host scope only; deployment/ToolRuntime authorization remains authoritative. */
export class ConfiguredSkillExecutionAuthorization
  implements SkillExecutionAuthorizationPort
{
  readonly #actor: ActorContext;
  readonly #agentVersions: Pick<AgentVersionStore, "loadAgentVersion">;
  readonly #digester: ContentDigester;

  constructor(dependencies: {
    actor: ActorContext;
    agentVersions: Pick<AgentVersionStore, "loadAgentVersion">;
    digester: ContentDigester;
  }) {
    this.#actor = structuredClone(dependencies.actor);
    this.#agentVersions = dependencies.agentVersions;
    this.#digester = dependencies.digester;
  }

  async authorize(
    input: Parameters<SkillExecutionAuthorizationPort["authorize"]>[0],
  ): ReturnType<SkillExecutionAuthorizationPort["authorize"]> {
    const deny = (reasonCode: string) => ({
      outcome: "deny" as const,
      reasonCode,
    });
    if (
      (["principalId", "actorId", "tenantId", "spaceId"] as const).some(
        (key) => input.actor[key] !== this.#actor[key],
      )
    )
      return deny("skill_scope_mismatch");
    if (input.purpose === "read" || input.purpose === "write")
      return { outcome: "allow" };
    if (!["trial", "schedule", "execute"].includes(input.purpose))
      return deny("skill_purpose_invalid");
    const route = input.route;
    if (route === null) return deny("skill_route_required");
    const asset = await this.#agentVersions.loadAgentVersion({
      tenantId: input.actor.tenantId,
      agentVersionId: route.agentVersionId,
    });
    if (!asset) return deny("skill_agent_version_not_found");
    let version;
    try {
      version = parseAgentVersionAsset(asset, this.#digester);
    } catch {
      return deny("skill_agent_version_invalid");
    }
    if (
      asset.tenantId !== input.actor.tenantId ||
      version.agentVersionId !== route.agentVersionId
    )
      return deny("skill_agent_version_invalid");
    if (
      version.runtimeGeneration !== route.runtimeGeneration ||
      version.policySnapshotId !== route.policySnapshotId
    )
      return deny("skill_route_mismatch");
    if (
      version.resources.workspaceRequired &&
      (route.workspaceBindingId === null || !route.workspaceBindingId.trim())
    )
      return deny("skill_workspace_required");
    const tools = new Set(version.tools.map((tool) => tool.name));
    if (input.requiredToolRefs.some((ref) => !tools.has(ref)))
      return deny("skill_tool_unavailable");
    return { outcome: "allow" };
  }
}

/**
 * A supported adapter's durable completed call proves model I/O only. It does not
 * prove browser actions or delivered output; reviewed completion remains separate.
 */
export class StoreBackedSkillRunEvidence implements SkillRunEvidencePort {
  readonly #application: Pick<RunApplicationService, "getRun">;
  readonly #store: Pick<ModelCallStore, "listModelCalls">;

  constructor(dependencies: {
    application: Pick<RunApplicationService, "getRun">;
    store: Pick<ModelCallStore, "listModelCalls">;
  }) {
    this.#application = dependencies.application;
    this.#store = dependencies.store;
  }

  async observe(
    actor: ActorContext,
    runId: string,
  ): ReturnType<SkillRunEvidencePort["observe"]> {
    // Never query accounting before the application's Run read authorization.
    const run = await this.#application.getRun(actor, runId);
    if (
      run.runId !== runId ||
      run.tenantId !== actor.tenantId ||
      run.spaceId !== actor.spaceId
    )
      throw new ApplicationError("authorization", "skill_run_scope_mismatch");
    let afterOrder = 0;
    let real = false;
    let simulated = false;
    let unsupported = false;
    try {
      // Bounded inventory: a truncated inventory cannot certify real execution.
      for (let page = 0; page < 8; page++) {
        const entries = await this.#store.listModelCalls({
          tenantId: actor.tenantId,
          runId,
          afterOrder,
          limit: 128,
        });
        if (entries.length > 128) return { run, verification: "unknown" };
        for (const entry of entries) {
          validateModelCallRecord(entry.record);
          if (
            !Number.isSafeInteger(entry.order) ||
            entry.order <= afterOrder ||
            entry.record.tenantId !== actor.tenantId ||
            entry.record.runId !== runId
          )
            return { run, verification: "unknown" };
          afterOrder = entry.order;
          const call = entry.record.observation;
          if (
            call.agentVersionId !== run.agentVersionId ||
            call.purpose !== "agent" ||
            call.outcome !== "completed"
          )
            continue;
          if (
            /(?:^|[-_])(fake|mock|simulated)(?:$|[-_])/u.test(call.adapterName)
          )
            simulated = true;
          // Defaults owned by agent-responses and runtime-worker/cloud-agent-transport.
          else if (
            (call.adapterName === "direct-responses" &&
              ["http", "websocket"].includes(call.transport)) ||
            (call.adapterName === "cloud-agent" &&
              call.transport === "cloudAgent")
          )
            real = true;
          else unsupported = true;
        }
        if (entries.length < 128)
          return {
            run,
            verification: simulated
              ? "simulated"
              : real && !unsupported
                ? "real"
                : "unknown",
          };
      }
    } catch {
      // A missing/unreadable accounting record is not evidence of a real trial.
    }
    return { run, verification: "unknown" };
  }
}
