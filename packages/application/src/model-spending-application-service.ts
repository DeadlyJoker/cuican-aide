import {
  validModelMoney,
  validateModelSpendingScope,
  type ModelSpendingScope,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { RunStoreError } from "./run-store-port.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type { DomainStore } from "./domain-store-port.ts";
export class ModelSpendingApplicationService {
  readonly dependencies: {
    store: Pick<DomainStore, "loadThread" | "modelSpending">;
    authorization: AuthorizationPort;
  };
  constructor(dependencies: ModelSpendingApplicationService["dependencies"]) {
    this.dependencies = dependencies;
  }
  async #authorize(
    actor: ActorContext,
    scope: ModelSpendingScope,
    access: "read" | "write",
  ) {
    try {
      validateModelSpendingScope(scope);
    } catch {
      throw new ApplicationError("validation", "model_spending_scope_invalid");
    }
    let decision;
    try {
      decision = await this.dependencies.authorization.authorize({
        actor,
        action: access === "write" ? "thread:goal:write" : "thread:goal:read",
        resource: {
          kind: "thread",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: scope.threadId,
        },
      });
    } catch {
      throw new ApplicationError("internal", "authorization_failed");
    }
    if (decision.outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
    const thread = await this.dependencies.store.loadThread({
      tenantId: actor.tenantId,
      threadId: scope.threadId,
    });
    if (
      thread === null ||
      thread.tenantId !== actor.tenantId ||
      thread.spaceId !== actor.spaceId ||
      thread.status === "deleted"
    )
      throw new ApplicationError("notFound", "thread_not_found");
    const store = this.dependencies.store.modelSpending;
    if (store === undefined)
      throw new ApplicationError("internal", "model_spending_unavailable");
    return store;
  }
  async get(actor: ActorContext, threadId: string, goalId: string) {
    const scope = { tenantId: actor.tenantId, threadId, goalId },
      store = await this.#authorize(actor, scope, "read");
    try {
      return await store.get(scope);
    } catch (e) {
      throw map(e);
    }
  }
  async set(
    actor: ActorContext,
    threadId: string,
    goalId: string,
    value: unknown,
  ) {
    const scope = { tenantId: actor.tenantId, threadId, goalId },
      store = await this.#authorize(actor, scope, "write");
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "currency,expectedRevision,limitPicounits"
    )
      throw new ApplicationError(
        "validation",
        "model_spending_settings_invalid",
      );
    const input = value as {
      currency: string;
      expectedRevision: number;
      limitPicounits: string;
    };
    if (
      typeof input.currency !== "string" ||
      !/^[A-Z]{3}$/.test(input.currency) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !validModelMoney(input.limitPicounits)
    )
      throw new ApplicationError(
        "validation",
        "model_spending_settings_invalid",
      );
    try {
      return await store.set({ ...scope, ...input });
    } catch (e) {
      throw map(e);
    }
  }
}
function map(error: unknown): ApplicationError {
  return error instanceof RunStoreError &&
    [
      "model_spending_revision_conflict",
      "model_spending_currency_immutable",
      "model_spending_goal_changed",
    ].includes(error.code)
    ? new ApplicationError("conflict", error.code)
    : new ApplicationError("internal", "model_spending_store_failed", {
        cause: error,
      });
}
