import { ApplicationError } from "./application-error.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { CreativeProjectPluginCommitTransactionAuthority } from "./creative-project-store-port.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { isProjectTextUiMutationAction } from "@crewon/contracts/project-texts-ui";
import type { ProjectTextUiCommitTransactionAuthority } from "./project-text-ui-commit-authority.ts";
import { projectTextActionContext } from "./plugin-project-text-action-context.ts";

export type PluginUiInvocationCommitAuthority = Readonly<{
  assertCurrent(): Promise<void>;
  assertActive(): void;
  transaction?: CreativeProjectPluginCommitTransactionAuthority;
}>;

type Invocation = Readonly<{
  assertCurrent: () => Promise<void>;
  assertActive?: () => void;
  transaction?: Readonly<{
    pin: CreativeProjectPluginCommitTransactionAuthority["pin"];
    selection: CreativeProjectPluginCommitTransactionAuthority["selection"];
    package: CreativeProjectPluginCommitTransactionAuthority["package"];
    fingerprint: string;
    assertCurrent: () => Promise<void>;
  }>;
  textUiTransaction?: ProjectTextUiCommitTransactionAuthority &
    Readonly<{ fingerprint: string }>;
}>;
const invocations = new WeakMap<object, Invocation>();

/** Private service registration; this function is deliberately absent from the package entrypoint. */
export function registerPluginUiInvocation(
  context: PluginUiActionContext,
  assertCurrent: () => Promise<void>,
  assertActive?: () => void,
  transaction?: Readonly<{ assertCurrent(): Promise<void> }>,
  textUiTransaction?: Readonly<{ assertCurrent(): Promise<void> }>,
): () => void {
  if (
    context === null ||
    typeof context !== "object" ||
    typeof assertCurrent !== "function" ||
    (assertActive !== undefined && typeof assertActive !== "function") ||
    invocations.has(context) ||
    (transaction !== undefined && textUiTransaction !== undefined)
  )
    throw new ApplicationError(
      "internal",
      "plugin_ui_invocation_registration_invalid",
    );
  let capturedTransaction: Invocation["transaction"];
  let capturedTextTransaction: Invocation["textUiTransaction"];
  if (textUiTransaction !== undefined) {
    const method = Object.getOwnPropertyDescriptor(
      textUiTransaction,
      "assertCurrent",
    );
    if (
      ![Object.prototype, null].includes(
        Object.getPrototypeOf(textUiTransaction),
      ) ||
      Reflect.ownKeys(textUiTransaction).length !== 1 ||
      method === undefined ||
      !method.enumerable ||
      !Object.hasOwn(method, "value") ||
      typeof method.value !== "function"
    )
      throw new ApplicationError(
        "internal",
        "plugin_ui_invocation_registration_invalid",
      );
    const snapshot = projectTextActionContext(context);
    if (!isProjectTextUiMutationAction(snapshot.request.action))
      throw new ApplicationError(
        "internal",
        "plugin_ui_invocation_registration_invalid",
      );
    capturedTextTransaction = Object.freeze({
      version: "crewon.project-text-plugin-commit.v1",
      actor: snapshot.context.actor,
      installation: snapshot.installation,
      actionId: snapshot.request.action,
      input: snapshot.request.input,
      selection: snapshot.context.selection,
      package: snapshot.context.package,
      fingerprint: snapshot.fingerprint,
      assertCurrent: method.value.bind(textUiTransaction),
    });
  }
  if (transaction !== undefined) {
    const fields = Reflect.ownKeys(transaction);
    const method = Object.getOwnPropertyDescriptor(
      transaction,
      "assertCurrent",
    );
    if (
      ![Object.prototype, null].includes(Object.getPrototypeOf(transaction)) ||
      fields.length !== 1 ||
      fields[0] !== "assertCurrent" ||
      method === undefined ||
      !method.enumerable ||
      !Object.hasOwn(method, "value") ||
      typeof method.value !== "function"
    )
      throw new ApplicationError(
        "internal",
        "plugin_ui_invocation_registration_invalid",
      );
    const {
      pin,
      fingerprint,
      context: captured,
    } = committedTaskContext(context);
    capturedTransaction = Object.freeze({
      pin,
      selection: captured.selection,
      package: captured.package,
      fingerprint,
      assertCurrent: method.value.bind(transaction),
    });
  }
  const invocation = Object.freeze({
    assertCurrent,
    assertActive,
    ...(capturedTransaction === undefined
      ? {}
      : { transaction: capturedTransaction }),
    ...(capturedTextTransaction === undefined
      ? {}
      : { textUiTransaction: capturedTextTransaction }),
  });
  invocations.set(context, invocation);
  return () => {
    if (invocations.get(context) === invocation) invocations.delete(context);
  };
}

/** Independent text qualification comes only from this exact live registered invocation. */
export function capturePluginProjectTextUiInvocationCommitAuthority(
  context: PluginUiActionContext,
): Readonly<{
  assertActive(): void;
  assertCurrent(): Promise<void>;
  textUiTransaction?: ProjectTextUiCommitTransactionAuthority;
}> {
  const invocation =
    context !== null && typeof context === "object"
      ? invocations.get(context)
      : undefined;
  if (invocation === undefined || invocation.transaction !== undefined)
    throw new ApplicationError(
      "authorization",
      "plugin_ui_invocation_unavailable",
    );
  // Membership and local liveness are checked before reading the context's fields.
  const base = capturePluginUiInvocationCommitAuthority(context);
  const captured = invocation.textUiTransaction;
  const snapshot = projectTextActionContext(context);
  if (
    isProjectTextUiMutationAction(snapshot.request.action) &&
    captured === undefined
  )
    throw new ApplicationError(
      "authorization",
      "plugin_project_text_transaction_required",
    );
  const current = () => {
    base.assertActive();
    if (
      captured !== undefined &&
      projectTextActionContext(context).fingerprint !== captured.fingerprint
    )
      throw new ApplicationError(
        "authorization",
        "plugin_ui_invocation_unavailable",
      );
  };
  current();
  return Object.freeze({
    assertActive: current,
    assertCurrent: async () => {
      current();
      await base.assertCurrent();
      current();
    },
    ...(captured === undefined
      ? {}
      : {
          textUiTransaction: Object.freeze({
            version: captured.version,
            actor: captured.actor,
            installation: captured.installation,
            actionId: captured.actionId,
            input: captured.input,
            selection: captured.selection,
            package: captured.package,
            assertCurrent: async () => {
              try {
                current();
                const result: unknown = await captured.assertCurrent();
                if (result !== undefined)
                  throw new ApplicationError(
                    "authorization",
                    "plugin_ui_invocation_current_check_invalid",
                  );
                current();
              } catch (error) {
                if (
                  error instanceof ApplicationError &&
                  error.code === "plugin_ui_authorization_denied" &&
                  invocations.get(context) === invocation
                )
                  invocations.delete(context);
                if (error instanceof ApplicationError) throw error;
                throw new ApplicationError(
                  "authorization",
                  "plugin_ui_invocation_unavailable",
                  { cause: error },
                );
              }
            },
          }),
        }),
  });
}

/** Trusted Host-only capability for an actual registered invocation; not a JSON permission. */
export function capturePluginUiInvocationCommitAuthority(
  context: PluginUiActionContext,
): PluginUiInvocationCommitAuthority {
  const invocation =
    context !== null && typeof context === "object"
      ? invocations.get(context)
      : undefined;
  if (invocation?.assertActive === undefined)
    throw new ApplicationError(
      "authorization",
      "plugin_ui_invocation_unavailable",
    );
  const assertActive = () => {
    if (invocations.get(context) !== invocation)
      throw new ApplicationError(
        "authorization",
        "plugin_ui_invocation_unavailable",
      );
    const result: unknown = invocation.assertActive!();
    if (result !== undefined) {
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function")
      )
        try {
          void Promise.prototype.then.call(
            result,
            () => undefined,
            () => undefined,
          );
        } catch {
          // Arbitrary thenables remain unread and cannot defer the synchronous fence.
        }
      throw new ApplicationError(
        "authorization",
        "plugin_ui_invocation_active_check_invalid",
      );
    }
    if (invocations.get(context) !== invocation)
      throw new ApplicationError(
        "authorization",
        "plugin_ui_invocation_unavailable",
      );
  };
  assertActive();
  const transaction = invocation.transaction;
  return Object.freeze({
    assertActive,
    assertCurrent: async () => {
      assertActive();
      await assertPluginUiInvocationCurrent(context);
      assertActive();
    },
    ...(transaction === undefined
      ? {}
      : {
          transaction: Object.freeze({
            version: "crewon.creative-project-plugin-commit.v1" as const,
            pin: transaction.pin,
            selection: transaction.selection,
            package: transaction.package,
            assertCurrent: async () => {
              const current = () => {
                assertActive();
                if (
                  committedTaskContext(context).fingerprint !==
                  transaction.fingerprint
                )
                  throw new ApplicationError(
                    "authorization",
                    "plugin_ui_invocation_unavailable",
                  );
              };
              try {
                current();
                const result: unknown = await transaction.assertCurrent();
                if (result !== undefined)
                  throw new ApplicationError(
                    "authorization",
                    "plugin_ui_invocation_current_check_invalid",
                  );
                current();
              } catch (error) {
                if (
                  error instanceof ApplicationError &&
                  error.code === "plugin_ui_authorization_denied" &&
                  invocations.get(context) === invocation
                )
                  invocations.delete(context);
                if (error instanceof ApplicationError) throw error;
                throw new ApplicationError(
                  "authorization",
                  "plugin_ui_invocation_unavailable",
                  { cause: error },
                );
              }
            },
          }),
        }),
  });
}

/** Host bridge commit fence for this exact live UI invocation, including actual closeMount disposal. */
export async function assertPluginUiInvocationCurrent(
  context: PluginUiActionContext,
): Promise<void> {
  const invocation =
    context !== null && typeof context === "object"
      ? invocations.get(context)
      : undefined;
  if (invocation === undefined)
    throw new ApplicationError(
      "authorization",
      "plugin_ui_invocation_unavailable",
    );
  try {
    await invocation.assertCurrent();
  } catch (error) {
    // An action deny withdraws this invocation, while independent mount/asset permissions retain their original semantics.
    if (
      error instanceof ApplicationError &&
      error.code === "plugin_ui_authorization_denied" &&
      invocations.get(context) === invocation
    )
      invocations.delete(context);
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "authorization",
      "plugin_ui_invocation_unavailable",
      { cause: error },
    );
  }
  // A callback that started while active cannot retain authority after its invocation has ended.
  if (invocations.get(context) !== invocation)
    throw new ApplicationError(
      "authorization",
      "plugin_ui_invocation_unavailable",
    );
}
