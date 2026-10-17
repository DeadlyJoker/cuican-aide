import {
  captureWorkflowRunListQuery,
  type WorkflowRunListQuery,
  type WorkflowRunListResponse,
} from "@crewon/contracts";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";

export interface WorkflowRunListStore {
  /** Snapshot of root summaries only. Never schedule work or infer admission receipt outcomes. */
  listWorkflowRuns(input: {
    tenantId: string;
    spaceId: string;
    query: WorkflowRunListQuery;
    authorizeScope(): Promise<void>;
    authorizeRun(resource: { runId: string; threadId: string }): Promise<void>;
  }): Promise<WorkflowRunListResponse>;
}
export class WorkflowRunListApplicationService {
  readonly #store: WorkflowRunListStore;
  readonly #authorization: AuthorizationPort;
  constructor(input: {
    store: WorkflowRunListStore;
    authorization: AuthorizationPort;
  }) {
    this.#store = input.store;
    this.#authorization = input.authorization;
  }
  async listRuns(
    actor: ActorContext,
    input: WorkflowRunListQuery,
  ): Promise<WorkflowRunListResponse> {
    actor = captureActor(actor);
    let query: WorkflowRunListQuery;
    try {
      query = captureWorkflowRunListQuery(input);
    } catch (cause) {
      throw new ApplicationError(
        "validation",
        "workflow_read_request_invalid",
        { cause },
      );
    }
    const scope = async () => {
      await this.#allow({
        actor,
        action: "workflowVersion:read",
        resource: {
          kind: "workflowVersion",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          workflowVersionId: query.workflowVersionId,
        },
      });
      await this.#allow({
        actor,
        action: "thread:read",
        resource: {
          kind: "thread",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: query.threadId,
        },
      });
      if (query.threadId !== null)
        await this.#allow({
          actor,
          action: "run:read",
          resource: {
            kind: "run",
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            threadId: query.threadId,
            runId: null,
          },
        });
    };
    await scope();
    try {
      return await this.#store.listWorkflowRuns({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        query,
        authorizeScope: scope,
        authorizeRun: async ({ runId, threadId }) => {
          await this.#allow({
            actor,
            action: "thread:read",
            resource: {
              kind: "thread",
              tenantId: actor.tenantId,
              spaceId: actor.spaceId,
              threadId,
            },
          });
          await this.#allow({
            actor,
            action: "run:read",
            resource: {
              kind: "run",
              tenantId: actor.tenantId,
              spaceId: actor.spaceId,
              threadId,
              runId,
            },
          });
        },
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("internal", "workflow_run_list_failed", {
        cause: error,
      });
    }
  }
  async #allow(request: Parameters<AuthorizationPort["authorize"]>[0]) {
    try {
      const decision = await this.#authorization.authorize(request);
      if (decision.outcome !== "allow")
        throw new ApplicationError(
          "authorization",
          "workflow_run_list_authorization_denied",
        );
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "authorization",
        "workflow_run_list_authorization_unavailable",
        { cause: error },
      );
    }
  }
}
function captureActor(input: ActorContext): ActorContext {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new ApplicationError("validation", "workflow_read_request_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).length !== 4 ||
    Object.keys(descriptors).sort().join() !==
      "actorId,principalId,spaceId,tenantId"
  )
    throw new ApplicationError("validation", "workflow_read_request_invalid");
  const pairs = Object.entries(descriptors).map(([key, d]) => {
    if (
      !d.enumerable ||
      !("value" in d) ||
      typeof d.value !== "string" ||
      !d.value ||
      d.value.trim() !== d.value ||
      d.value.length > 512 ||
      new TextEncoder().encode(d.value).byteLength > 512 ||
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        new TextEncoder().encode(d.value),
      ) !== d.value ||
      /[\u0000-\u001f\u007f]/u.test(d.value)
    )
      throw new ApplicationError("validation", "workflow_read_request_invalid");
    return [key, d.value];
  });
  return Object.freeze(Object.fromEntries(pairs)) as ActorContext;
}
