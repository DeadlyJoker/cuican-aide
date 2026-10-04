import type {
  PluginTaskAdmissionPin,
  PluginTaskUnmeteredAuthorization,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";

/** A trusted host's explicit policy. Packages, public requests and absent quotes cannot issue this authority. */
export interface PluginTaskUnmeteredAuthorityPort {
  prepareGeneration(
    input: Readonly<{ actor: ActorContext; pin: PluginTaskAdmissionPin }>,
  ): Promise<PluginTaskUnmeteredPreparedAuthority>;
}
export type PluginTaskUnmeteredPreparedAuthority = Readonly<{
  authorization: PluginTaskUnmeteredAuthorization;
  /** Must be safe with the original transaction connection held; never acquire another Store connection. */
  assertCurrent(): Promise<void>;
  assertActive(): void;
}>;
