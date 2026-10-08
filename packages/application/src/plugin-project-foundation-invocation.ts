import { isProjectFoundationUiMutationAction } from "@crewon/contracts/project-foundation";
import { ApplicationError } from "./application-error.ts";
import { projectFoundationActionContext } from "./plugin-project-foundation-action-context.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { captureProjectFoundationCommitAuthority } from "./project-foundation-commit-authority.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
type Registration = Readonly<{
  snapshot: ReturnType<typeof projectFoundationActionContext>;
  transactionCurrent(): Promise<void>;
}>;
const registrations = new WeakMap<object, Registration>();
/** Private membership issued only during the original PluginUiApplicationService invocation. */
export function registerPluginProjectFoundationInvocation(
  context: PluginUiActionContext,
  transactionCurrent: () => Promise<void>,
): () => void {
  if (registrations.has(context) || typeof transactionCurrent !== "function")
    unavailable();
  const base = capturePluginUiInvocationCommitAuthority(context);
  if (base.transaction !== undefined) unavailable();
  const registration = Object.freeze({
    snapshot: projectFoundationActionContext(context),
    transactionCurrent,
  });
  registrations.set(context, registration);
  return () => {
    if (registrations.get(context) === registration)
      registrations.delete(context);
  };
}
export function capturePluginProjectFoundationInvocation(
  context: PluginUiActionContext,
) {
  const registration =
    context !== null && typeof context === "object"
      ? registrations.get(context)
      : undefined;
  if (registration === undefined) unavailable();
  const base = capturePluginUiInvocationCommitAuthority(context);
  const assertActive = () => {
    base.assertActive();
    if (
      registrations.get(context) !== registration ||
      projectFoundationActionContext(context).fingerprint !==
        registration.snapshot.fingerprint
    )
      unavailable();
  };
  const assertCurrent = async () => {
    assertActive();
    await base.assertCurrent();
    assertActive();
  };
  const assertTransactionCurrent = async () => {
    assertActive();
    const result: unknown = await registration.transactionCurrent();
    if (result !== undefined) unavailable();
    assertActive();
  };
  assertActive();
  const snapshot = registration.snapshot;
  const authority = captureProjectFoundationCommitAuthority({
    authority: {
      assertCurrent,
      assertActive,
      ...(isProjectFoundationUiMutationAction(snapshot.request.action)
        ? {
            transaction: {
              version: "crewon.project-foundation-plugin-commit.v1",
              pin: snapshot.pin,
              selection: snapshot.context.selection,
              package: snapshot.context.package,
              assertCurrent: assertTransactionCurrent,
            },
          }
        : {}),
    },
  })!;
  return Object.freeze({ snapshot, ...authority });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_foundation_invocation_unavailable",
  );
}
