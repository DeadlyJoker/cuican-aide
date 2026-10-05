import { ApplicationError } from "./application-error.ts";
import { parseProjectHistoricalQueryUiActionRequest } from "@crewon/contracts/plugins";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";

export type PluginHistoricalQueryInvocationAuthority = Readonly<{
  version: "crewon.project-historical-query-invocation.v1";
  sourcePin: ReturnType<typeof committedTaskContext>["pin"];
  context: PluginUiActionContext;
  fingerprint: string;
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
type Registration = {
  snapshot: ReturnType<typeof committedTaskContext>;
  current: () => Promise<void>;
  transaction: () => Promise<void>;
  active: () => void;
};
const registrations = new WeakMap<object, Registration>(),
  issued = new WeakMap<object, Registration>();
/** Private Main/Control UI service registration. Never exported by the package entrypoint. */
export function registerPluginHistoricalQueryInvocation(
  context: PluginUiActionContext,
  current: () => Promise<void>,
  transaction: () => Promise<void>,
  active: () => void,
): () => void {
  if (
    registrations.has(context) ||
    typeof current !== "function" ||
    typeof transaction !== "function" ||
    typeof active !== "function"
  )
    throw new ApplicationError(
      "internal",
      "project_historical_query_invocation_invalid",
    );
  const snapshot = committedTaskContext(context);
  parseProjectHistoricalQueryUiActionRequest({
    action: snapshot.context.action,
    input: snapshot.context.input,
  });
  const registration = { snapshot, current, transaction, active };
  registrations.set(context, registration);
  return () => {
    if (registrations.get(context) === registration)
      registrations.delete(context);
  };
}
export function capturePluginHistoricalQueryInvocationCommitAuthority(
  context: PluginUiActionContext,
): PluginHistoricalQueryInvocationAuthority {
  const registered = registrations.get(context);
  if (registered === undefined)
    throw new ApplicationError(
      "authorization",
      "project_historical_query_invocation_unavailable",
    );
  const active = () => {
    if (
      registrations.get(context) !== registered ||
      committedTaskContext(context).fingerprint !==
        registered.snapshot.fingerprint
    )
      throw new ApplicationError(
        "authorization",
        "project_historical_query_invocation_unavailable",
      );
    if (registered.active() !== undefined)
      throw new ApplicationError(
        "authorization",
        "project_historical_query_active_check_invalid",
      );
  };
  active();
  const authority: PluginHistoricalQueryInvocationAuthority = Object.freeze({
    version: "crewon.project-historical-query-invocation.v1",
    sourcePin: registered.snapshot.pin,
    context,
    fingerprint: registered.snapshot.fingerprint,
    assertActive: active,
    async assertCurrent() {
      active();
      await registered.current();
      active();
    },
    async assertTransactionCurrent() {
      active();
      await registered.transaction();
      active();
    },
  });
  issued.set(authority, registered);
  return authority;
}
/** A copied callback object, old public qualification or another invocation is never this authority. */
export function assertPluginHistoricalQueryInvocationAuthority(
  input: PluginHistoricalQueryInvocationAuthority,
): void {
  const registered = issued.get(input);
  if (
    registered === undefined ||
    registrations.get(input.context) !== registered ||
    input.fingerprint !== registered.snapshot.fingerprint
  )
    throw new ApplicationError(
      "authorization",
      "project_historical_query_invocation_unavailable",
    );
  input.assertActive();
}

/** Retains the genuine issuer identity while adding an owner's synchronous lifetime fence. */
export function fencePluginHistoricalQueryInvocationAuthority(
  original: PluginHistoricalQueryInvocationAuthority,
  assertOwnerActive: () => void,
): PluginHistoricalQueryInvocationAuthority {
  assertPluginHistoricalQueryInvocationAuthority(original);
  if (typeof assertOwnerActive !== "function")
    throw new ApplicationError(
      "internal",
      "project_historical_query_active_check_invalid",
    );
  const active = () => {
    assertOwnerActive();
    original.assertActive();
  };
  const next = Object.freeze({
    ...original,
    assertActive: active,
    async assertCurrent() {
      active();
      await original.assertCurrent();
      active();
    },
    async assertTransactionCurrent() {
      active();
      await original.assertTransactionCurrent();
      active();
    },
  });
  issued.set(next, issued.get(original)!);
  return next;
}
