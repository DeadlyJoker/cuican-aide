import type { ActorContext } from "./authorization-port.ts";
import type { ExtensionExecutionTarget } from "@crewon/domain";
import type {
  ExtensionHostPort,
  ExtensionReadiness,
  ExtensionRegistration,
} from "./extension-host-port.ts";

export type ExtensionQueryRegistrationIdentity = Readonly<{
  pluginId: string;
  pluginVersion: string;
  manifestDigest: string;
  implementationDigest: string;
}>;

/** Resolves only a previously authorized source Run's pinned implementation. */
export interface ExtensionQueryHostPort {
  resolveRegistration(
    input: Readonly<{
      actor: ActorContext;
      identity: ExtensionQueryRegistrationIdentity;
    }>,
  ): Promise<ExtensionRegistration | null>;
  evaluate(
    input: Parameters<ExtensionHostPort["evaluate"]>[0] &
      Readonly<{ expectedTarget: ExtensionExecutionTarget }>,
  ): Promise<ExtensionReadiness>;
}
