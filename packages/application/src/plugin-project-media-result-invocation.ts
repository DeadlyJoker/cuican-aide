import {
  parseProjectMediaResultUiRequest,
  PROJECT_MEDIA_RESULT_WRITE_ACTIONS,
} from "@crewon/contracts/project-media-results-ui";
import { ApplicationError } from "./application-error.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

type Registration = Readonly<{
  fingerprint: string;
  transaction(): Promise<void>;
}>;
const registrations = new WeakMap<object, Registration>();
export type PluginProjectMediaResultInvocationAuthority = Readonly<{
  assertActive(): void;
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
}>;
/** Private Application registration. It is never exported through the package entrypoint. */
export function registerPluginProjectMediaResultInvocation(
  context: PluginUiActionContext,
  transaction: () => Promise<void>,
): () => void {
  if (registrations.has(context) || typeof transaction !== "function")
    unavailable();
  capturePluginUiInvocationCommitAuthority(context);
  const request = parseProjectMediaResultUiRequest({
    action: context.action,
    input: context.input,
  });
  if (request.action !== PROJECT_MEDIA_RESULT_WRITE_ACTIONS.saveCandidate)
    unavailable();
  const registration = Object.freeze({
    fingerprint: JSON.stringify(context),
    transaction,
  });
  registrations.set(context, registration);
  return () => {
    if (registrations.get(context) === registration)
      registrations.delete(context);
  };
}
/** Actual registered UI invocation; the metadata Store checks the same short-drama installation inside its own SQL transaction. */
export function capturePluginProjectMediaResultInvocationAuthority(
  context: PluginUiActionContext,
): PluginProjectMediaResultInvocationAuthority {
  const registration =
    context !== null && typeof context === "object"
      ? registrations.get(context)
      : undefined;
  if (!registration) unavailable();
  const base = capturePluginUiInvocationCommitAuthority(context);
  const active = () => {
    base.assertActive();
    if (
      registrations.get(context) !== registration ||
      JSON.stringify(context) !== registration.fingerprint
    )
      unavailable();
  };
  active();
  return Object.freeze({
    assertActive: active,
    assertCurrent: async () => {
      active();
      await base.assertCurrent();
      active();
    },
    assertTransactionCurrent: async () => {
      active();
      if ((await registration.transaction()) !== undefined) unavailable();
      active();
    },
  });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_media_result_invocation_unavailable",
  );
}
