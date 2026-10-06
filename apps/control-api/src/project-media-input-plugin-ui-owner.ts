import {
  ApplicationError,
  capturePluginProjectMediaInputInvocationAuthority,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiCommittedMetadataOutcome,
  type PluginUiCommittedMetadataPort,
} from "@crewon/application";
import {
  parsePluginUiLease,
  parsePluginUiJsonValue,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  CREWON_PROJECT_MEDIA_INPUTS_SERVICE,
  CREWON_PROJECT_MEDIA_INPUTS_API_VERSION,
  PROJECT_MEDIA_INPUT_UI_ACTIONS,
  parseProjectMediaInputUiRequest,
  parseProjectMediaInputUiResponse,
} from "@crewon/contracts/project-media-inputs-ui";
import { MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES } from "@crewon/contracts/project-media-inputs";
import {
  parsePluginProfileScope,
  parsePluginSelection,
  parseInstalledPluginPackage,
} from "@crewon/domain";
import {
  appendProjectMediaInputUiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import {
  InstalledProjectMediaInputRuntime,
  isInstalledProjectMediaInputRuntime,
} from "./installed-project-media-input-runtime.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

type Outcome = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const outcomePrototype = Object.freeze(Object.create(null) as object);

/** One independent exact-package UI grant borrows the original Core metadata owner. */
export class ProjectMediaInputPluginUiOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #save: InstalledProjectMediaInputRuntime["saveInputFromPluginUi"];
  readonly #load: InstalledProjectMediaInputRuntime["loadInputFromPluginUi"];
  readonly #list: InstalledProjectMediaInputRuntime["listInputsFromPluginUi"];
  readonly #options: InstalledProjectMediaInputRuntime["getOptionsFromPluginUi"];
  readonly #assertRuntime: InstalledProjectMediaInputRuntime["assertAvailable"];
  readonly #publications: CreativeProjectPluginUiConfig["publications"];
  readonly #outcomes = new WeakMap<object, Outcome>();
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  constructor(
    input: Readonly<{
      runtime: InstalledProjectMediaInputRuntime;
      configuration: CreativeProjectPluginUiConfig;
    }>,
  ) {
    const fields = pluginSecurityRecord(input, ["runtime", "configuration"]);
    if (!isInstalledProjectMediaInputRuntime(fields.runtime)) unavailable();
    this.#save =
      InstalledProjectMediaInputRuntime.prototype.saveInputFromPluginUi.bind(
        fields.runtime,
      );
    this.#load =
      InstalledProjectMediaInputRuntime.prototype.loadInputFromPluginUi.bind(
        fields.runtime,
      );
    this.#list =
      InstalledProjectMediaInputRuntime.prototype.listInputsFromPluginUi.bind(
        fields.runtime,
      );
    this.#options =
      InstalledProjectMediaInputRuntime.prototype.getOptionsFromPluginUi.bind(
        fields.runtime,
      );
    this.#assertRuntime =
      InstalledProjectMediaInputRuntime.prototype.assertAvailable.bind(
        fields.runtime,
      );
    this.#publications = captureCreativeProjectPluginUiConfig(
      fields.configuration,
    )!.publications;
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(context),
    });
    this.committedMetadata = Object.freeze({
      isOutcome: (value: unknown): value is PluginUiCommittedMetadataOutcome =>
        value !== null &&
        typeof value === "object" &&
        this.#outcomes.has(value),
      verify: (
        context: PluginUiActionContext,
        value: PluginUiCommittedMetadataOutcome,
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
            "plugin_ui_committed_metadata_invalid",
          );
        return outcome.output;
      },
    });
    Object.freeze(this);
  }
  supportsAction(action: string): boolean {
    return Object.values(PROJECT_MEDIA_INPUT_UI_ACTIONS).some(
      (a) => a === action,
    );
  }
  hostUiServices(
    fallback?: PluginUiHostServiceAvailabilityPort,
  ): PluginUiHostServiceAvailabilityPort {
    return appendProjectMediaInputUiServiceAvailability({
      mediaInputs: Object.freeze({
        isAvailable: ({ candidate, requirement }) => {
          try {
            this.#assertRuntime();
          } catch {
            return false;
          }
          return (
            !this.#lifetime.signal.aborted &&
            requirement.service === CREWON_PROJECT_MEDIA_INPUTS_SERVICE &&
            requirement.apiVersion ===
              CREWON_PROJECT_MEDIA_INPUTS_API_VERSION &&
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
    capturePluginProjectMediaInputInvocationAuthority(context);
    this.#assertRuntime();
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
    const save =
      captured.request.action === PROJECT_MEDIA_INPUT_UI_ACTIONS.saveInput;
    const value = save
      ? await this.#save(context, this.#lifetime.signal)
      : captured.request.action === PROJECT_MEDIA_INPUT_UI_ACTIONS.getOptions
        ? await this.#options(context, this.#lifetime.signal)
        : captured.request.action === PROJECT_MEDIA_INPUT_UI_ACTIONS.listInputs
          ? await this.#list(context, this.#lifetime.signal)
          : await this.#load(context, this.#lifetime.signal);
    const output = parsePluginUiJsonValue(
      parseProjectMediaInputUiResponse(captured.request, value),
      { maxBytes: MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES },
    );
    if (snapshot(context).fingerprint !== captured.fingerprint) unavailable();
    if (!save) {
      this.#assertRuntime();
      this.#lifetime.signal.throwIfAborted();
      await capturePluginProjectMediaInputInvocationAuthority(
        context,
      ).assertCurrent();
      this.#lifetime.signal.throwIfAborted();
      return output;
    }
    // No late policy recheck can turn a real durable commit/replay into a failed write.
    const outcome = Object.freeze(
      Object.create(outcomePrototype),
    ) as PluginUiCommittedMetadataOutcome;
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
    request = parseProjectMediaInputUiRequest({
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
        r.service === CREWON_PROJECT_MEDIA_INPUTS_SERVICE &&
        r.apiVersion === CREWON_PROJECT_MEDIA_INPUTS_API_VERSION,
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
    "project_media_input_ui_unavailable",
  );
}
