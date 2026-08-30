import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import {
  canonicalWorkspaceListAction,
  canonicalWorkspaceListDispatchCommand,
  validateFrozenWorkspaceListCommand,
  WorkspaceListCommandFactoryError,
  type FrozenWorkspaceListCommand,
  type WorkspaceListCommandFactoryPort,
} from "./workspace-operation-store-port.ts";
import type { ExecuteWorkspaceListCommand } from "./workspace-list-application-service.ts";
export class WorkspaceListCommandCoordinator {
  readonly #authorization: AuthorizationPort;
  readonly #digester: ContentDigester;
  readonly #commands: WorkspaceListCommandFactoryPort;

  constructor(
    authorization: AuthorizationPort,
    digester: ContentDigester,
    commands: WorkspaceListCommandFactoryPort,
  ) {
    this.#authorization = authorization;
    this.#digester = digester;
    this.#commands = commands;
  }
  async authorize(actor: ActorContext, threadId: string | null): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action: "thread:workspace:write",
        resource: {
          kind: "thread",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId,
        },
      });
      if (decision.outcome !== "allow") {
        throw new ApplicationError("authorization", "authorization_denied");
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }

  async createFrozenCommand(
    actor: ActorContext,
    command: ExecuteWorkspaceListCommand,
    signal: AbortSignal,
  ): Promise<FrozenWorkspaceListCommand> {
    try {
      const frozen = validateFrozenWorkspaceListCommand(
        await this.#commands.create(
          {
            actor,
            threadId: command.threadId,
            expectedThreadRevision: command.expectedRevision,
            idempotencyKey: command.idempotencyKey,
            maxEntries: command.maxEntries,
          },
          signal,
        ),
      );
      const actionDigest = this.#digester.sha256(
        canonicalWorkspaceListAction({
          idempotencyKey: command.idempotencyKey,
          command: frozen,
        }),
      );
      const commandDigest = this.#digester.sha256(
        canonicalWorkspaceListDispatchCommand({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: command.threadId,
          expectedThreadRevision: command.expectedRevision,
          principalId: actor.principalId,
          actorId: actor.actorId,
          idempotencyKey: command.idempotencyKey,
          command: { ...frozen, actionDigest },
        }),
      );
      if (
        frozen.actionDigest !== actionDigest ||
        frozen.commandDigest !== commandDigest
      ) {
        throw new Error("workspace_command_digest_mismatch");
      }
      return frozen;
    } catch (error) {
      const code =
        error instanceof WorkspaceListCommandFactoryError &&
        error.kind === "unavailable"
          ? "workspace_command_factory_unavailable"
          : "workspace_command_factory_invalid";
      throw new ApplicationError("internal", code, {
        cause: error,
      });
    }
  }
}
