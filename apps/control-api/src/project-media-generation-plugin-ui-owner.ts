import {
  ApplicationError,
  isPluginUiRecoveryApplicationService,
  PluginUiRecoveryApplicationService,
  capturePluginUiInvocationCommitAuthority,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiCommittedTaskOutcome,
  type PluginUiCommittedTaskPort,
} from "@crewon/application";
import {
  parsePluginUiLease,
  parsePluginUiJsonValue,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  CREWON_PROJECT_MEDIA_GENERATIONS_SERVICE,
  PROJECT_MEDIA_GENERATE_UI_ACTION,
  PROJECT_MEDIA_RECOVERY_UI_ACTION,
  parseProjectMediaGenerationUiRequest,
  parseGenerateProjectMediaResponse,
} from "@crewon/contracts/project-media-generations";
import { MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES } from "@crewon/contracts/project-media-generations";
import {
  parsePluginProfileScope,
  parsePluginSelection,
  parseInstalledPluginPackage,
} from "@crewon/domain";
import {
  appendProjectMediaGenerationUiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import {
  InstalledProjectMediaGenerationRuntime,
  isInstalledProjectMediaGenerationRuntime,
} from "./installed-project-media-generation-runtime.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

type Outcome = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const issued = new WeakSet<object>();
export function isProjectMediaGenerationPluginUiOwner(
  input: unknown,
): input is ProjectMediaGenerationPluginUiOwner {
  return input !== null && typeof input === "object" && issued.has(input);
}
const outcomePrototype = Object.freeze(Object.create(null) as object);

/** One independent exact-package UI grant borrows the original Core generation owner. */
export class ProjectMediaGenerationPluginUiOwner {
  readonly actions: PluginUiActionPort;
  readonly committedTasks: PluginUiCommittedTaskPort;
  readonly #generate: InstalledProjectMediaGenerationRuntime["generateFromPluginUi"];
  readonly #assertRuntime: InstalledProjectMediaGenerationRuntime["assertAvailable"];
  readonly #publications: CreativeProjectPluginUiConfig["publications"];
  readonly #recovery:
    | (() => PluginUiRecoveryApplicationService | undefined)
    | undefined;
  readonly #outcomes = new WeakMap<object, Outcome>();
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  constructor(
    input: Readonly<{
      runtime: InstalledProjectMediaGenerationRuntime;
      configuration: CreativeProjectPluginUiConfig;
      recovery?: () => PluginUiRecoveryApplicationService | undefined;
    }>,
  ) {
    const fields = pluginSecurityRecord(input, [
      "runtime",
      "configuration",
      ...(Object.hasOwn(input, "recovery") ? ["recovery"] : []),
    ]);
    if (fields.recovery !== undefined && typeof fields.recovery !== "function")
      unavailable();
    this.#recovery = fields.recovery as
      | (() => PluginUiRecoveryApplicationService | undefined)
      | undefined;
    if (!isInstalledProjectMediaGenerationRuntime(fields.runtime))
      unavailable();
    this.#generate =
      InstalledProjectMediaGenerationRuntime.prototype.generateFromPluginUi.bind(
        fields.runtime,
      );
    this.#assertRuntime =
      InstalledProjectMediaGenerationRuntime.prototype.assertAvailable.bind(
        fields.runtime,
      );
    this.#publications = captureCreativeProjectPluginUiConfig(
      fields.configuration,
    )!.publications;
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(context),
    });
    this.committedTasks = Object.freeze({
      isOutcome: (value: unknown): value is PluginUiCommittedTaskOutcome =>
        value !== null &&
        typeof value === "object" &&
        this.#outcomes.has(value),
      verify: (
        context: PluginUiActionContext,
        value: PluginUiCommittedTaskOutcome,
      ) => {
        const outcome = this.#outcomes.get(value);
        this.#outcomes.delete(value);
        if (
          !outcome ||
          outcome.context !== context ||
          snapshot(context).fingerprint !== outcome.fingerprint
        )
          throw new ApplicationError(
            "internal",
            "plugin_ui_committed_task_invalid",
          );
        return outcome.output;
      },
    });
    issued.add(this);
    Object.freeze(this);
  }
  supportsAction(action: string): boolean {
    return (
      action === PROJECT_MEDIA_GENERATE_UI_ACTION ||
      action === PROJECT_MEDIA_RECOVERY_UI_ACTION
    );
  }
  recoveryPublications() {
    this.#assertRuntime();
    this.#lifetime.signal.throwIfAborted();
    return this.#publications;
  }
  hostUiServices(
    fallback?: PluginUiHostServiceAvailabilityPort,
  ): PluginUiHostServiceAvailabilityPort {
    return appendProjectMediaGenerationUiServiceAvailability({
      mediaGenerations: Object.freeze({
        isAvailable: ({ candidate, requirement }) => {
          try {
            this.#assertRuntime();
          } catch {
            return false;
          }
          return (
            !this.#lifetime.signal.aborted &&
            requirement.service === CREWON_PROJECT_MEDIA_GENERATIONS_SERVICE &&
            requirement.apiVersion === "1" &&
            this.#publications.some(
              (p) =>
                p.pluginId === candidate.descriptor.pluginId &&
                p.packageDigest === candidate.packageDigest &&
                candidate.descriptor.contributions.some(
                  (c) =>
                    c.id === p.contributionId &&
                    c.kind === "module" &&
                    c.slot === "main.content",
                ),
            )
          );
        },
      }),
      ...(fallback === undefined ? {} : { fallback }),
    });
  }
  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= Promise.allSettled([...this.#pending]).then(
      () => {},
    ));
  }
  #invoke(context: PluginUiActionContext) {
    this.#lifetime.signal.throwIfAborted();
    // Membership is checked before any property read. A copied mount is never an invocation.
    capturePluginUiInvocationCommitAuthority(context);
    this.#assertRuntime();
    if (context.action === PROJECT_MEDIA_RECOVERY_UI_ACTION) {
      const recovery = this.#recovery?.();
      if (!isPluginUiRecoveryApplicationService(recovery)) unavailable();
      const pending =
        PluginUiRecoveryApplicationService.prototype.getMediaGenerationRecovery
          .call(recovery, context)
          .then((value) => {
            this.#lifetime.signal.throwIfAborted();
            this.#assertRuntime();
            return value;
          });
      this.#pending.add(pending);
      void pending.then(
        () => this.#pending.delete(pending),
        () => this.#pending.delete(pending),
      );
      return pending;
    }
    const captured = snapshot(context);
    if (
      !this.#publications.some(
        (p) =>
          p.pluginId === captured.context.package.pluginId &&
          p.packageDigest === captured.context.package.packageDigest &&
          p.contributionId === captured.context.lease.contributionId,
      )
    )
      unavailable();
    const pending = this.#execute(context, captured);
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }
  async #execute(
    context: PluginUiActionContext,
    captured: ReturnType<typeof snapshot>,
  ) {
    const value = await this.#generate(context, this.#lifetime.signal);
    const output = parsePluginUiJsonValue(
      parseGenerateProjectMediaResponse(captured.request.input, value),
      { maxBytes: MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES },
    );
    if (snapshot(context).fingerprint !== captured.fingerprint) unavailable();
    // No late policy recheck can turn a real durable commit/replay into a failed write.
    const outcome = Object.freeze(
      Object.create(outcomePrototype),
    ) as PluginUiCommittedTaskOutcome;
    this.#outcomes.set(
      outcome,
      Object.freeze({ context, fingerprint: captured.fingerprint, output }),
    );
    return outcome;
  }
}

function snapshot(input: PluginUiActionContext) {
  const f = pluginSecurityRecord(input, [
    "actor",
    "scope",
    "selection",
    "package",
    "lease",
    "authorityEpoch",
    "action",
    "input",
  ]);
  const actor = pluginSecurityActor(f.actor),
    scope = parsePluginProfileScope(f.scope),
    selection = parsePluginSelection(f.selection),
    pkg = parseInstalledPluginPackage(f.package),
    lease = parsePluginUiLease(f.lease),
    request = parseProjectMediaGenerationUiRequest({
      action: f.action,
      input: f.input,
    });
  if (
    typeof f.authorityEpoch !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(f.authorityEpoch) ||
    scope.tenantId !== actor.tenantId ||
    scope.spaceId !== actor.spaceId ||
    selection.state !== "enabled" ||
    selection.revision !== lease.selectionRevision ||
    selection.selectedPackageDigest !== pkg.packageDigest ||
    pkg.packageDigest !== lease.packageDigest ||
    selection.pluginId !== pkg.pluginId ||
    selection.publisherId !== pkg.publisherId ||
    pkg.pluginId !== lease.descriptor.pluginId ||
    pkg.publisherId !== lease.descriptor.publisherId ||
    pkg.version !== lease.descriptor.version ||
    ["tenantId", "spaceId", "profileId"].some(
      (key) =>
        selection[key as keyof typeof scope] !==
          scope[key as keyof typeof scope] ||
        pkg[key as keyof typeof scope] !== scope[key as keyof typeof scope],
    ) ||
    !lease.descriptor.requires.some(
      (r) =>
        r.service === CREWON_PROJECT_MEDIA_GENERATIONS_SERVICE &&
        r.apiVersion === "1",
    ) ||
    !lease.descriptor.contributions.some(
      (c) =>
        c.id === lease.contributionId &&
        c.kind === "module" &&
        c.slot === "main.content",
    )
  )
    unavailable();
  const context = Object.freeze({
    actor,
    scope,
    selection,
    package: pkg,
    lease,
    authorityEpoch: f.authorityEpoch,
    action: request.action,
    input: request.input,
  });
  return Object.freeze({
    context,
    request,
    fingerprint: JSON.stringify(context),
  });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "project_media_generation_ui_unavailable",
  );
}
