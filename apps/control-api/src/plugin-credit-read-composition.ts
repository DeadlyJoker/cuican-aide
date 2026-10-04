import {
  PluginCreditReadApplicationService,
  type PluginCreditReadAuthorizationPort,
  type PluginCreditReadStore,
} from "@crewon/application";

const unavailableAuthorization: PluginCreditReadAuthorizationPort =
  Object.freeze({
    async authorize() {
      return {
        outcome: "deny" as const,
        reasonCode: "plugin_credit_read_authority_required",
      };
    },
  });

/** Existing callers retain their authorities. Missing credit-read policy never inherits install rights. */
export function composePluginCreditReads(
  store: PluginCreditReadStore,
  authorization?: PluginCreditReadAuthorizationPort,
): PluginCreditReadApplicationService {
  return new PluginCreditReadApplicationService({
    store,
    authorization: authorization ?? unavailableAuthorization,
  });
}
