import { isProjectSourceUploadAction } from "@crewon/contracts/project-source-uploads";
import { ApplicationError } from "./application-error.ts";
import { projectSourceUploadActionContext } from "./plugin-project-source-upload-action-context.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import {
  captureProjectSourceUploadExecutionAuthority,
  PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS,
} from "./project-source-upload-plugin-commit-authority.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
type Registration = Readonly<{
  snapshot: ReturnType<typeof projectSourceUploadActionContext>;
  transactionCurrent(): Promise<void>;
}>;
const registrations = new WeakMap<object, Registration>();

/** Private registration only during the original JSON invoke, with existing live base membership. */
export function registerPluginProjectSourceUploadInvocation(
  context: PluginUiActionContext,
  transactionCurrent: () => Promise<void>,
): () => void {
  if (!isProjectSourceUploadAction(context.action)) unavailable();
  return register(context, transactionCurrent);
}
/** Future raw mount lifecycle must issue its own real writePart action; a prepare grant cannot qualify it. */
export function registerPluginProjectSourceUploadRawInvocation(
  context: PluginUiActionContext,
  transactionCurrent: () => Promise<void>,
): () => void {
  if (
    context.action !==
    PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS["projectSourceUpload:write"]
  )
    unavailable();
  return register(context, transactionCurrent);
}
function register(
  context: PluginUiActionContext,
  transactionCurrent: () => Promise<void>,
): () => void {
  if (registrations.has(context) || typeof transactionCurrent !== "function")
    unavailable();
  const base = capturePluginUiInvocationCommitAuthority(context);
  if (base.transaction !== undefined) unavailable();
  const registration = Object.freeze({
    snapshot: projectSourceUploadActionContext(context),
    transactionCurrent,
  });
  registrations.set(context, registration);
  return () => {
    if (registrations.get(context) === registration)
      registrations.delete(context);
  };
}
/** Capture cannot be issued from a copied context, ended invocation, or unrelated task/Run grant. */
export function capturePluginProjectSourceUploadInvocation(
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
      projectSourceUploadActionContext(context).fingerprint !==
        registration.snapshot.fingerprint
    )
      unavailable();
  };
  const assertCurrent = async () => {
    assertActive();
    await base.assertCurrent();
    assertActive();
  };
  const transactionCurrent = async () => {
    assertActive();
    if ((await registration.transactionCurrent()) !== undefined) unavailable();
    assertActive();
  };
  assertActive();
  const snapshot = registration.snapshot;
  const authority = captureProjectSourceUploadExecutionAuthority({
    authority: {
      assertCurrent,
      assertActive,
      transaction: {
        version: "crewon.project-source-upload-plugin-commit.v1",
        pin: snapshot.pin,
        selection: snapshot.context.selection,
        package: snapshot.context.package,
        assertCurrent: transactionCurrent,
      },
    },
  })!;
  return Object.freeze({ snapshot, authority });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_source_upload_invocation_unavailable",
  );
}
