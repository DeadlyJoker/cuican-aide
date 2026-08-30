import type { CompiledAgentVersion } from "@crewon/agent-version";
import type { ActorContext } from "@crewon/application";
export type { RunRouteResolverPort } from "@crewon/application";

export type ControlApiRequestContext = Readonly<{
  method: string;
  url: string;
  remoteAddress: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}>;

export interface ControlApiIdentityPort {
  resolveActor(request: ControlApiRequestContext): Promise<ActorContext>;
}

export interface AgentVersionAdmissionPort {
  evaluate(input: {
    actor: ActorContext;
    version: CompiledAgentVersion;
  }): AgentVersionAdmissionDecision | Promise<AgentVersionAdmissionDecision>;
}

export type AgentVersionAdmissionDecision =
  | Readonly<{
      outcome: "allow";
      authorityId: string;
      workspaceBindingId: string | null;
    }>
  | Readonly<{ outcome: "deny"; reasonCode: string }>;

export interface ControlApiReadinessPort {
  checkReady(): Promise<void>;
}

export class ControlApiIdentityError extends Error {
  readonly category: "authentication" | "authorization";
  readonly code: string;

  constructor(
    category: "authentication" | "authorization",
    code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ControlApiIdentityError";
    this.category = category;
    this.code = code;
  }
}
