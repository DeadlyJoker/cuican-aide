import {
  WorkflowVersionError,
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
import { RunStoreError } from "./run-store-port.ts";

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
    validateActor(actor);
    let version;
    try {
      version = compileWorkflowVersion(source, this.#dependencies.digester);
    } catch (error) {
      throw mapWorkflowError(error, "publish");
    }
    await this.#authorize(actor, "publish", version.workflowVersionId);
    const referenced = new Set<string>();
    for (const node of version.nodes) {
      if (node.kind === "agent") referenced.add(node.agentVersionId);
      if (node.kind === "verification") {
        referenced.add(node.verifierAgentVersionId);
      }
    }
    for (const agentVersionId of referenced) {
      let referencedVersion;
      try {
        referencedVersion =
          await this.#dependencies.agentVersions.loadAgentVersion({
            tenantId: actor.tenantId,
            agentVersionId,
          });
      } catch (error) {
        throw mapWorkflowError(error, "reference");
      }
      if (referencedVersion === null) {
        throw new ApplicationError(
          "validation",
          "workflow_agent_version_not_found",
        );
      }
    }
    try {
      return await this.#dependencies.store.registerWorkflowVersion({
        schemaVersion: "crewon.workflow-version-asset.v0",
        tenantId: actor.tenantId,
        workflowId: version.workflowId,
        workflowVersionId: version.workflowVersionId,
        contentDigest: version.contentDigest,
        definitionJson: serializeCompiledWorkflowVersion(version),
        createdAt: this.#dependencies.now(),
      });
    } catch (error) {
      throw mapWorkflowError(error, "publish");
    }
  }

  async get(actor: ActorContext, workflowVersionId: string) {
    validateActor(actor);
    await this.#authorize(actor, "read", workflowVersionId);
    let asset;
    try {
      asset = await this.#dependencies.store.loadWorkflowVersion({
        tenantId: actor.tenantId,
        workflowVersionId,
      });
    } catch (error) {
      throw mapWorkflowError(error, "read");
    }
    if (asset === null) {
      throw new ApplicationError("notFound", "workflow_version_not_found");
    }
    return asset;
  }

  async list(
    actor: ActorContext,
    input: {
      workflowId: string | null;
      after: WorkflowVersionListCursor | null;
      limit: number;
    },
  ) {
    validateActor(actor);
    await this.#authorize(actor, "list", null);
    try {
      return await this.#dependencies.store.listWorkflowVersions({
        tenantId: actor.tenantId,
        ...input,
      });
    } catch (error) {
      throw mapWorkflowError(error, "list");
    }
  }

  async #authorize(
    actor: ActorContext,
    operation: "publish" | "read" | "list",
    workflowVersionId: string | null,
  ) {
    try {
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
      if (decision.outcome !== "allow")
        throw new ApplicationError("authorization", "authorization_denied");
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }
}

function validateActor(actor: ActorContext) {
  if (
    !isPlainObject(actor) ||
    !hasExactKeys(actor, ["actorId", "principalId", "spaceId", "tenantId"]) ||
    [actor.actorId, actor.principalId, actor.spaceId, actor.tenantId].some(
      (value) => typeof value !== "string" || value.trim().length === 0,
    )
  )
    throw new ApplicationError("validation", "actor_invalid");
}

function mapWorkflowError(
  error: unknown,
  operation: "publish" | "read" | "list" | "reference",
) {
  if (error instanceof ApplicationError) return error;
  if (error instanceof WorkflowVersionError)
    return new ApplicationError("validation", error.code, { cause: error });
  if (error instanceof RunStoreError) {
    if (
      operation === "publish" &&
      error.code === "workflow_version_id_conflict"
    )
      return new ApplicationError("conflict", error.code, { cause: error });
    if (isWorkflowValidationCode(error.code))
      return new ApplicationError("validation", error.code, { cause: error });
    return new ApplicationError("internal", error.code, { cause: error });
  }
  return new ApplicationError("internal", "workflow_version_operation_failed", {
    cause: error instanceof Error ? error : undefined,
  });
}
function isWorkflowValidationCode(code: string) {
  return (
    code.startsWith("workflow_") &&
    !code.includes("corrupt") &&
    !code.includes("schema_") &&
    code !== "workflow_version_store_failed"
  );
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function hasExactKeys(value: object, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}
