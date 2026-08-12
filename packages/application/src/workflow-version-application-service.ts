import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
  type WorkflowContentDigester,
  type WorkflowVersionSource,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { AgentVersionStore } from "./agent-version-store-port.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type {
  WorkflowVersionListCursor,
  WorkflowVersionStore,
} from "./workflow-version-store-port.ts";

/** Publishes server-compiled WorkflowVersions after resolving every AgentVersion authority. */
export class WorkflowVersionApplicationService {
  readonly #dependencies: {
    store: WorkflowVersionStore;
    agentVersions: AgentVersionStore;
    authorization: AuthorizationPort;
    digester: WorkflowContentDigester;
    now(): string;
  };

  constructor(dependencies: {
    store: WorkflowVersionStore;
    agentVersions: AgentVersionStore;
    authorization: AuthorizationPort;
    digester: WorkflowContentDigester;
    now(): string;
  }) {
    this.#dependencies = dependencies;
  }

  async publish(actor: ActorContext, source: WorkflowVersionSource) {
    await this.#authorize(actor, "publish", source.workflowVersionId);
    const version = compileWorkflowVersion(source, this.#dependencies.digester);
    const referenced = new Set<string>();
    for (const node of version.nodes) {
      if (node.kind === "agent") referenced.add(node.agentVersionId);
      if (node.kind === "verification") {
        referenced.add(node.verifierAgentVersionId);
      }
    }
    for (const agentVersionId of referenced) {
      if (
        (await this.#dependencies.agentVersions.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId,
        })) === null
      ) {
        throw new ApplicationError(
          "validation",
          "workflow_agent_version_not_found",
        );
      }
    }
    return this.#dependencies.store.registerWorkflowVersion({
      schemaVersion: "crewon.workflow-version-asset.v0",
      tenantId: actor.tenantId,
      workflowId: version.workflowId,
      workflowVersionId: version.workflowVersionId,
      contentDigest: version.contentDigest,
      definitionJson: serializeCompiledWorkflowVersion(version),
      createdAt: this.#dependencies.now(),
    });
  }

  async get(actor: ActorContext, workflowVersionId: string) {
    await this.#authorize(actor, "read", workflowVersionId);
    const asset = await this.#dependencies.store.loadWorkflowVersion({
      tenantId: actor.tenantId,
      workflowVersionId,
    });
    if (asset === null) {
      throw new ApplicationError("notFound", "workflow_version_not_found");
    }
    return asset;
  }

  async list(
    actor: ActorContext,
    input: {
      workflowId: string;
      after: WorkflowVersionListCursor | null;
      limit: number;
    },
  ) {
    await this.#authorize(actor, "list", null);
    return this.#dependencies.store.listWorkflowVersions({
      tenantId: actor.tenantId,
      ...input,
    });
  }

  async #authorize(
    actor: ActorContext,
    operation: "publish" | "read" | "list",
    workflowVersionId: string | null,
  ) {
    const decision = await this.#dependencies.authorization.authorize({
      actor,
      action: `workflowVersion:${operation}`,
      resource: {
        kind: "workflowVersion",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        workflowVersionId,
      },
    });
    if (decision.outcome !== "allow") {
      throw new ApplicationError("authorization", "authorization_denied");
    }
  }
}
