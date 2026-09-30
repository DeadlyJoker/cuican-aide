import type {
  ExtensionConfiguration,
  ExtensionExecutionTarget,
  ExtensionManifest,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";

/** Reviewed host metadata only. Registration alone confers no execution authority. */
export type ExtensionRegistration = Readonly<{
  manifest: ExtensionManifest;
  manifestDigest: string;
  implementationDigest: string;
}>;

export interface ExtensionCatalogPort {
  list(): readonly ExtensionRegistration[];
  resolve(
    identity: Readonly<{ pluginId: string; pluginVersion: string }>,
  ): ExtensionRegistration | null;
}

export type ExtensionReadiness =
  | Readonly<{ outcome: "ready"; target: ExtensionExecutionTarget }>
  | Readonly<{
      outcome: "unavailable";
      reasonCode:
        | "extension_runtime_unavailable"
        | "extension_implementation_unavailable"
        | "extension_credential_unavailable"
        | "extension_execution_authority_unsupported";
    }>;

export interface ExtensionHostPort {
  /** Adapter-specific non-secret configuration and scoped credential-reference validation; no API call. */
  validateConfiguration(
    input: Readonly<{
      actor: ActorContext;
      registration: ExtensionRegistration;
      configuration: ExtensionConfiguration;
    }>,
  ): Promise<void>;
  /**
   * Must verify the exact manifest, implementation and configuration against a deployed
   * kernel runtime. Does not select a default model, publish, or silently switch authority.
   * Current permission/credential revocation must also be checked before each external call.
   */
  evaluate(
    input: Readonly<{
      actor: ActorContext;
      registration: ExtensionRegistration;
      configuration: ExtensionConfiguration;
      agentVersionId: string;
    }>,
  ): Promise<ExtensionReadiness>;
}
