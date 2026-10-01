import type { ExtensionRunBinding } from "@crewon/domain";
import type {
  ActorContext,
  AuthorizationDecision,
  AuthorizationPort,
} from "./authorization-port.ts";

export type ExtensionExecutionAccessRequest = Readonly<{
  binding: ExtensionRunBinding;
  source: ExtensionRunBinding | null;
  action: "submit" | "observe";
  signal: AbortSignal;
}>;
export interface ExtensionExecutionAccessPort {
  authorize(
    input: ExtensionExecutionAccessRequest,
  ): Promise<AuthorizationDecision>;
}

/** Background execution resolves current identity from a trusted host, never from model arguments. */
export class CurrentExtensionExecutionAuthorization
  implements ExtensionExecutionAccessPort
{
  readonly #authorization: AuthorizationPort;
  readonly #resolveActor: (
    owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
    signal: AbortSignal,
  ) => Promise<ActorContext | null>;
  constructor(input: {
    authorization: AuthorizationPort;
    resolveActor: (
      owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
      signal: AbortSignal,
    ) => Promise<ActorContext | null>;
  }) {
    this.#authorization = input.authorization;
    this.#resolveActor = input.resolveActor;
  }

  async authorize(
    input: ExtensionExecutionAccessRequest,
  ): Promise<AuthorizationDecision> {
    const { action, signal } = input;
    const binding = structuredClone(input.binding);
    const source = input.source === null ? null : structuredClone(input.source);
    signal.throwIfAborted();
    const resolved = await this.#resolveActor(
      {
        tenantId: binding.tenantId,
        spaceId: binding.spaceId,
        actorId: binding.actorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      resolved === null ||
      resolved.tenantId !== binding.tenantId ||
      resolved.spaceId !== binding.spaceId ||
      resolved.actorId !== binding.actorId ||
      !resolved.principalId
    )
      return {
        outcome: "deny",
        reasonCode: "extension_execution_identity_unavailable",
      };
    const actor = Object.freeze({ ...resolved });
    if (
      (binding.source === null) !== (source === null) ||
      (source !== null &&
        (action === "submit" ||
          source.source !== null ||
          source.pluginId !== binding.pluginId ||
          source.tenantId !== binding.tenantId ||
          source.spaceId !== binding.spaceId ||
          source.runId !== binding.source?.runId ||
          source.bindingDigest !== binding.source.bindingDigest))
    )
      return { outcome: "deny", reasonCode: "extension_query_source_invalid" };
    const requests: Parameters<AuthorizationPort["authorize"]>[0][] = [
      {
        actor,
        action: "run:execute",
        resource: {
          kind: "run",
          tenantId: binding.tenantId,
          spaceId: binding.spaceId,
          threadId: binding.threadId,
          runId: binding.runId,
        },
      },
      {
        actor,
        action: action === "submit" ? "extension:run" : "extension:query",
        resource: {
          kind: "extension",
          tenantId: binding.tenantId,
          spaceId: binding.spaceId,
          pluginId: binding.pluginId,
        },
      },
    ];
    if (source !== null)
      requests.push({
        actor,
        action: "run:read",
        resource: {
          kind: "run",
          tenantId: source.tenantId,
          spaceId: source.spaceId,
          threadId: source.threadId,
          runId: source.runId,
        },
      });
    for (const request of requests) {
      signal.throwIfAborted();
      const decision = await this.#authorization.authorize(request);
      signal.throwIfAborted();
      if (decision.outcome !== "allow")
        return {
          outcome: "deny",
          reasonCode: "extension_execution_access_denied",
        };
    }
    return { outcome: "allow" };
  }
}
