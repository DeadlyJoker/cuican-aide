import {
  ApplicationError,
  type ActorContext,
  type AuthorizationDecision,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  assertDesktopNativePluginControlConfigCurrent,
  type DesktopNativePluginControlConfig,
} from "./desktop-native-plugin-control-environment.ts";
import { pluginSecurityActor } from "./plugin-security-validation.ts";

/** The Main-issued local grant authorizes only its explicitly pinned business packages. */
export class DesktopNativePluginActivationAuthority {
  readonly #configuration: DesktopNativePluginControlConfig;
  #closed = false;
  constructor(configuration: DesktopNativePluginControlConfig) {
    assertDesktopNativePluginControlConfigCurrent(configuration);
    this.#configuration = configuration;
  }
  async decide(
    input: Readonly<{ actor: ActorContext; pluginId: string }>,
    signal: AbortSignal,
  ): Promise<AuthorizationDecision> {
    signal.throwIfAborted();
    if (this.#closed) denied();
    assertDesktopNativePluginControlConfigCurrent(this.#configuration);
    if (
      extensionCanonicalJson(pluginSecurityActor(input.actor)) !==
        extensionCanonicalJson(this.#configuration.authority.actor) ||
      !this.#configuration.publication.entries.some(
        (entry) => entry.identity.pluginId === input.pluginId,
      )
    )
      denied();
    signal.throwIfAborted();
    return { outcome: "allow" };
  }
  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_native_plugin_activation_denied",
  );
}
