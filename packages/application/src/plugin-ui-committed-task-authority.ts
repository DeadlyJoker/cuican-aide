import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import type {
  CommitExtensionTurnResult,
  ExtensionStore,
} from "./extension-store-port.ts";
import type { RunStore } from "./run-store-port.ts";
import type {
  PluginUiActionContext,
  PluginUiCommittedTaskOutcome,
  PluginUiCommittedTaskPort,
  PluginUiJsonValue,
} from "./plugin-ui-ports.ts";
import {
  assertSavedPluginTask,
  pluginTaskReceipt,
  requirePluginTaskStore,
} from "./extension-plugin-task-support.ts";
import {
  assertCommittedRun,
  committedTaskCommand,
  committedTaskContext,
  committedTaskProjection,
  committedTaskResult,
} from "./plugin-ui-committed-task-support.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";

export type PluginUiCommittedTaskAuthorityDependencies = Readonly<{
  extensions: ExtensionStore;
  runs: Pick<RunStore, "loadRunInSpace">;
  digester: ContentDigester;
}>;
type VerifiedOutcome = Readonly<{
  context: PluginUiActionContext;
  contextFingerprint: string;
  output: PluginUiJsonValue;
}>;
// A custom prototype makes an outcome invalid as plain JSON even without a configured authority.
const outcomePrototype = Object.freeze(Object.create(null) as object);

/**
 * Trusted host-only receipt authority, not a plugin SDK or a current authorization grant.
 * It verifies the original transaction, then returns only its accepted task DTO once per invocation.
 */
export class PluginUiCommittedTaskAuthority
  implements PluginUiCommittedTaskPort
{
  readonly #dependencies: PluginUiCommittedTaskAuthorityDependencies;
  readonly #outcomes = new WeakMap<object, VerifiedOutcome>();

  constructor(dependencies: PluginUiCommittedTaskAuthorityDependencies) {
    requirePluginTaskStore(dependencies.extensions);
    if (
      typeof dependencies.extensions.loadExtensionTurnReceipt !== "function" ||
      typeof dependencies.runs?.loadRunInSpace !== "function" ||
      typeof dependencies.digester?.sha256 !== "function"
    )
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_task_port_missing",
      );
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  async issue(
    input: Readonly<{
      context: PluginUiActionContext;
      command: CreateExtensionTaskCommand;
      result: CommitExtensionTurnResult;
    }>,
  ): Promise<PluginUiCommittedTaskOutcome> {
    try {
      // All caller-owned records are captured before the first storage await.
      const value = uiRecord(input, ["context", "command", "result"]);
      const invocation = value.context as PluginUiActionContext;
      const { context, pin, fingerprint } = committedTaskContext(invocation);
      const command = committedTaskCommand(
        value.command as CreateExtensionTaskCommand,
        pin,
      );
      const receipt = pluginTaskReceipt(
        context.actor,
        command,
        pin,
        this.#dependencies.digester,
      );
      const claimed = committedTaskResult(
        value.result as CommitExtensionTurnResult,
        command,
        pin,
        receipt,
        this.#dependencies.digester,
      );
      const raw = await this.#dependencies.extensions.loadExtensionTurnReceipt({
        tenantId: pin.tenantId,
        spaceId: pin.spaceId,
        pluginId: pin.pluginId,
        receipt,
      });
      if (raw === null) throw new Error("plugin_ui_committed_receipt_missing");
      const saved = committedTaskResult(
        raw,
        command,
        pin,
        receipt,
        this.#dependencies.digester,
      );
      if (saved.fingerprint !== claimed.fingerprint)
        throw new Error("plugin_ui_committed_receipt_mismatch");
      await assertSavedPluginTask({
        store: this.#dependencies.extensions,
        pin,
        binding: saved.binding,
        threadId: command.threadId,
        receipt,
        digester: this.#dependencies.digester,
      });
      const run = await this.#dependencies.runs.loadRunInSpace({
        tenantId: pin.tenantId,
        spaceId: pin.spaceId,
        runId: saved.binding.runId,
      });
      if (run === null) throw new Error("plugin_ui_committed_run_missing");
      assertCommittedRun(run, saved.binding);
      if (committedTaskContext(invocation).fingerprint !== fingerprint)
        throw new Error("plugin_ui_committed_context_changed");
      const outcome = Object.freeze(
        Object.create(outcomePrototype),
      ) as PluginUiCommittedTaskOutcome;
      this.#outcomes.set(
        outcome,
        Object.freeze({
          context: invocation,
          contextFingerprint: fingerprint,
          output: committedTaskProjection(claimed.result),
        }),
      );
      return outcome;
    } catch (error) {
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_task_invalid",
        { cause: error },
      );
    }
  }

  isOutcome(input: unknown): input is PluginUiCommittedTaskOutcome {
    return (
      input !== null && typeof input === "object" && this.#outcomes.has(input)
    );
  }

  verify(
    context: PluginUiActionContext,
    outcome: PluginUiCommittedTaskOutcome,
  ): PluginUiJsonValue {
    try {
      const saved = this.#outcomes.get(outcome);
      this.#outcomes.delete(outcome);
      if (
        saved === undefined ||
        saved.context !== context ||
        committedTaskContext(context).fingerprint !== saved.contextFingerprint
      )
        throw new Error("plugin_ui_committed_outcome_invalid");
      return saved.output;
    } catch (error) {
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_task_invalid",
        { cause: error },
      );
    }
  }
}
