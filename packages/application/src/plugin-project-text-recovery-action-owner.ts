import {
  parseProjectTextRecoveryActionResponse,
  isProjectTextRecoveryAction,
  MAX_PROJECT_TEXT_RECOVERY_RESPONSE_BYTES,
  type ProjectTextRecoveryActionRequest,
} from "@crewon/contracts/project-text-recovery";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import {
  PluginProjectTextRecoveryApplicationService,
  isPluginProjectTextRecoveryApplicationService,
} from "./plugin-project-text-recovery-application-service.ts";
import { capturePluginProjectTextRecoveryInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import { projectTextRecoveryContext } from "./plugin-project-text-recovery-context.ts";
import {
  captureProjectTextPublications,
  type PluginProjectTextActionPublication,
} from "./plugin-project-text-action-owner.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
  PluginUiCommittedMetadataOutcome,
  PluginUiCommittedMetadataPort,
  PluginUiJsonValue,
} from "./plugin-ui-ports.ts";
import type { ProjectTextRecoveryCommitAuthority } from "./project-text-recovery-commit-authority.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";

export interface PluginProjectTextRecoveryAuthorizationPort {
  /** Identity/profile/publication only; no nested borrow of the committing Store. */
  authorize(
    context: PluginUiActionContext,
    request: ProjectTextRecoveryActionRequest,
  ): Promise<void>;
}
export type PluginProjectTextRecoveryActionOwnerDependencies = Readonly<{
  recovery: PluginProjectTextRecoveryApplicationService;
  publications: readonly PluginProjectTextActionPublication[];
  authorization: PluginProjectTextRecoveryAuthorizationPort;
}>;
const owners = new WeakSet<object>(),
  prototype = Object.freeze(Object.create(null) as object);
export function isPluginProjectTextRecoveryActionOwner(
  input: unknown,
): input is PluginProjectTextRecoveryActionOwner {
  return input !== null && typeof input === "object" && owners.has(input);
}
export class PluginProjectTextRecoveryActionOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #recovery: Readonly<{
    getPending: PluginProjectTextRecoveryApplicationService["getPending"];
    acknowledge: PluginProjectTextRecoveryApplicationService["acknowledge"];
  }>;
  readonly #publications: readonly PluginProjectTextActionPublication[];
  readonly #authorize: PluginProjectTextRecoveryAuthorizationPort["authorize"];
  readonly #outcomes = new WeakMap<
    object,
    Readonly<{
      context: PluginUiActionContext;
      fingerprint: string;
      output: PluginUiJsonValue;
    }>
  >();
  #closed = false;
  #pending = 0;
  #closing: Promise<void> | undefined;
  #finish: (() => void) | undefined;
  constructor(input: PluginProjectTextRecoveryActionOwnerDependencies) {
    const fields = uiRecord(input, [
      "recovery",
      "publications",
      "authorization",
    ]);
    if (!isPluginProjectTextRecoveryApplicationService(fields.recovery))
      throw new ApplicationError(
        "internal",
        "plugin_project_text_recovery_config_invalid",
      );
    const service = fields.recovery;
    this.#recovery = Object.freeze({
      getPending:
        PluginProjectTextRecoveryApplicationService.prototype.getPending.bind(
          service,
        ),
      acknowledge:
        PluginProjectTextRecoveryApplicationService.prototype.acknowledge.bind(
          service,
        ),
    });
    this.#publications = captureProjectTextPublications(fields.publications);
    this.#authorize = captureAuthorization(fields.authorization);
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(context),
    });
    this.committedMetadata = Object.freeze({
      isOutcome: (input: unknown): input is PluginUiCommittedMetadataOutcome =>
        input !== null &&
        typeof input === "object" &&
        this.#outcomes.has(input),
      verify: (
        context: PluginUiActionContext,
        outcome: PluginUiCommittedMetadataOutcome,
      ) => this.#verify(context, outcome),
    });
    owners.add(this);
    Object.freeze(this);
  }
  supportsAction(input: string): boolean {
    return isProjectTextRecoveryAction(input);
  }
  assertAvailable() {
    if (this.#closed)
      throw new ApplicationError(
        "authorization",
        "plugin_project_text_recovery_actions_unavailable",
      );
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    return (this.#closing =
      this.#pending === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            this.#finish = resolve;
          }));
  }
  async #invoke(context: PluginUiActionContext) {
    this.assertAvailable();
    if (this.#pending >= 64)
      throw new ApplicationError(
        "conflict",
        "plugin_project_text_recovery_inflight_limit",
      );
    const original =
        capturePluginProjectTextRecoveryInvocationCommitAuthority(context),
      snapshot = projectTextRecoveryContext(context),
      request = snapshot.request;
    if (
      !this.#publications.some(
        (p) =>
          p.pluginId === snapshot.context.package.pluginId &&
          p.packageDigest === snapshot.context.package.packageDigest &&
          p.contributionId === snapshot.context.lease.contributionId,
      )
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_text_recovery_publication_unavailable",
      );
    let active = true;
    const check = async (current: () => Promise<void>) => {
      try {
        authority.assertActive();
        await current();
        authority.assertActive();
        const result: unknown = await this.#authorize(context, request);
        if (result !== undefined)
          throw new ApplicationError(
            "authorization",
            "plugin_project_text_recovery_authorization_invalid",
          );
        authority.assertActive();
        await current();
        authority.assertActive();
      } catch (error) {
        active = false;
        throw error;
      }
    };
    const authority: ProjectTextRecoveryCommitAuthority = Object.freeze({
      assertActive: () => {
        this.assertAvailable();
        if (!active)
          throw new ApplicationError(
            "authorization",
            "plugin_ui_invocation_unavailable",
          );
        original.assertActive();
      },
      assertCurrent: () => check(original.assertCurrent),
      recoveryTransaction: Object.freeze({
        ...original.recoveryTransaction,
        assertCurrent: () => check(original.recoveryTransaction.assertCurrent),
      }),
    });
    this.#pending++;
    try {
      await authority.assertCurrent();
      const response =
        request.action === "crewon.project-text-recovery.v1.getPending"
          ? await this.#recovery.getPending(context, authority)
          : await this.#recovery.acknowledge(context, authority);
      if (request.action === "crewon.project-text-recovery.v1.getPending")
        await authority.assertCurrent();
      const output = parsePluginUiJsonValue(
        parseProjectTextRecoveryActionResponse(request, response),
        { maxBytes: MAX_PROJECT_TEXT_RECOVERY_RESPONSE_BYTES },
      );
      if (
        projectTextRecoveryContext(context).fingerprint !== snapshot.fingerprint
      )
        throw new ApplicationError(
          "internal",
          "plugin_project_text_recovery_context_changed",
        );
      if (request.action === "crewon.project-text-recovery.v1.getPending")
        return output;
      const outcome = Object.freeze(
        Object.create(prototype),
      ) as PluginUiCommittedMetadataOutcome;
      this.#outcomes.set(
        outcome,
        Object.freeze({ context, fingerprint: snapshot.fingerprint, output }),
      );
      return outcome;
    } finally {
      this.#pending--;
      if (this.#pending === 0) this.#finish?.();
    }
  }
  #verify(
    context: PluginUiActionContext,
    outcome: PluginUiCommittedMetadataOutcome,
  ): PluginUiJsonValue {
    const entry =
      outcome !== null && typeof outcome === "object"
        ? this.#outcomes.get(outcome)
        : undefined;
    this.#outcomes.delete(outcome);
    if (
      entry === undefined ||
      entry.context !== context ||
      projectTextRecoveryContext(context).fingerprint !== entry.fingerprint
    )
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_metadata_invalid",
      );
    return entry.output;
  }
}
function captureAuthorization(
  input: unknown,
): PluginProjectTextRecoveryAuthorizationPort["authorize"] {
  if (input === null || typeof input !== "object")
    throw new ApplicationError(
      "internal",
      "plugin_project_text_recovery_authorization_invalid",
    );
  for (
    let target: object | null = input, depth = 0;
    target !== null && depth < 16;
    target = Object.getPrototypeOf(target), depth++
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "authorize");
    if (descriptor === undefined) continue;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      break;
    return descriptor.value.bind(
      input,
    ) as PluginProjectTextRecoveryAuthorizationPort["authorize"];
  }
  throw new ApplicationError(
    "internal",
    "plugin_project_text_recovery_authorization_invalid",
  );
}
