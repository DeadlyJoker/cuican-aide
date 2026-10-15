import {
  ApplicationError,
  type PluginTaskUnmeteredAuthorityPort,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parsePluginTaskUnmeteredAuthorization,
} from "@crewon/domain";
import { InstalledPluginTaskHttpAuthority } from "./installed-plugin-credit-quote-authority.ts";
import type { InstalledPluginTaskEndpoint } from "./installed-plugin-task-environment.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

/** An explicit deployment policy; missing prices or client parameters never imply free execution. */
type Owner = Readonly<{
  endpoint: InstalledPluginTaskEndpoint;
  http: InstalledPluginTaskHttpAuthority;
  currentSignal(): AbortSignal;
  assertCurrent(): Promise<void>;
}>;
export class InstalledPluginUnmeteredAuthority
  implements PluginTaskUnmeteredAuthorityPort
{
  readonly #owner: Owner;
  constructor(owner: Owner) {
    this.#owner = owner;
  }

  async prepareGeneration(
    input: Parameters<PluginTaskUnmeteredAuthorityPort["prepareGeneration"]>[0],
  ) {
    const value = pluginSecurityRecord(input, ["actor", "pin"]);
    const actor = pluginSecurityActor(value.actor);
    const pin = parsePluginTaskAdmissionPin(value.pin);
    if (
      ["tenantId", "spaceId", "principalId", "actorId"].some(
        (key) =>
          actor[key as keyof typeof actor] !== pin[key as keyof typeof pin],
      )
    )
      denied();
    const signal = this.#owner.currentSignal();
    const active = () => signal.throwIfAborted();
    const check = async () => {
      active();
      await this.#owner.assertCurrent();
      const response = pluginSecurityRecord(
        await this.#owner.http.post(
          this.#owner.endpoint,
          {
            schemaVersion: "crewon.plugin-task-unmetered-policy.v1",
            actor,
            pin,
          },
          signal,
        ),
        ["outcome", "authorization"],
      );
      if (response.outcome !== "allow") denied();
      const authorization = parsePluginTaskUnmeteredAuthorization(
        response.authorization,
      );
      await this.#owner.assertCurrent();
      active();
      return authorization;
    };
    const authorization = await check();
    return Object.freeze({
      authorization,
      assertActive: active,
      assertCurrent: async () => {
        if (
          extensionCanonicalJson(await check()) !==
          extensionCanonicalJson(authorization)
        )
          denied();
      },
    });
  }
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "installed_plugin_unmetered_policy_denied",
  );
}
