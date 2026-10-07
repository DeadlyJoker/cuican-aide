import {
  ApplicationError,
  capturePluginUiInvocationCommitAuthority,
  type PluginUiActionContext,
  type PluginUiActionPort,
} from "@crewon/application";
import {
  parsePluginUiLease,
  parsePluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  CREWON_PROJECT_MEDIA_RESULTS_SERVICE,
  CREWON_PROJECT_MEDIA_RESULTS_API_VERSION,
  PROJECT_MEDIA_RESULT_UI_ACTIONS,
  parseProjectMediaResultUiRequest,
  parseProjectMediaResultUiResponse,
} from "@crewon/contracts/project-media-results-ui";
import { MAX_MEDIA_RESULT_CATALOG_BYTES } from "@crewon/contracts/project-media-results";
import {
  parsePluginProfileScope,
  parsePluginSelection,
  parseInstalledPluginPackage,
} from "@crewon/domain";
import {
  appendProjectMediaResultUiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import {
  InstalledProjectMediaResultRuntime,
  isInstalledProjectMediaResultRuntime,
} from "./installed-project-media-result-runtime.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

/** Borrows the original result reader. Never submits a Run, publishes bytes, or adopts an asset. */
export class ProjectMediaResultPluginUiOwner {
  readonly actions: PluginUiActionPort;
  readonly #read: InstalledProjectMediaResultRuntime["readFromPluginUi"];
  readonly #assertRuntime: InstalledProjectMediaResultRuntime["assertAvailable"];
  readonly #publications: CreativeProjectPluginUiConfig["publications"];
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closing?: Promise<void>;
  constructor(
    input: Readonly<{
      runtime: InstalledProjectMediaResultRuntime;
      configuration: CreativeProjectPluginUiConfig;
    }>,
  ) {
    const f = pluginSecurityRecord(input, ["runtime", "configuration"]);
    if (!isInstalledProjectMediaResultRuntime(f.runtime)) unavailable();
    this.#read =
      InstalledProjectMediaResultRuntime.prototype.readFromPluginUi.bind(
        f.runtime,
      );
    this.#assertRuntime =
      InstalledProjectMediaResultRuntime.prototype.assertAvailable.bind(
        f.runtime,
      );
    this.#publications = captureCreativeProjectPluginUiConfig(
      f.configuration,
    )!.publications;
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(context),
    });
    Object.freeze(this);
  }
  supportsAction(action: string): boolean {
    return (
      action === PROJECT_MEDIA_RESULT_UI_ACTIONS.listCandidates ||
      action === PROJECT_MEDIA_RESULT_UI_ACTIONS.preview
    );
  }
  hostUiServices(
    fallback?: PluginUiHostServiceAvailabilityPort,
  ): PluginUiHostServiceAvailabilityPort {
    return appendProjectMediaResultUiServiceAvailability({
      mediaResults: {
        isAvailable: ({ candidate, requirement }) => {
          try {
            this.#assertRuntime();
          } catch {
            return false;
          }
          return (
            !this.#lifetime.signal.aborted &&
            requirement.service === CREWON_PROJECT_MEDIA_RESULTS_SERVICE &&
            requirement.apiVersion ===
              CREWON_PROJECT_MEDIA_RESULTS_API_VERSION &&
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
      },
      ...(fallback === undefined ? {} : { fallback }),
    });
  }
  #invoke(context: PluginUiActionContext) {
    this.#lifetime.signal.throwIfAborted();
    const authority = capturePluginUiInvocationCommitAuthority(context);
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
    if (this.#pending.size >= 16)
      throw new ApplicationError("conflict", "project_media_result_busy");
    const pending = (async () => {
      await authority.assertCurrent();
      const value = await this.#read(context, this.#lifetime.signal);
      const output = parsePluginUiJsonValue(
        parseProjectMediaResultUiResponse(captured.request, value),
        { maxBytes: MAX_MEDIA_RESULT_CATALOG_BYTES },
      );
      if (snapshot(context).fingerprint !== captured.fingerprint) unavailable();
      await authority.assertCurrent();
      this.#lifetime.signal.throwIfAborted();
      this.#assertRuntime();
      return output;
    })();
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }
  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= Promise.allSettled([...this.#pending]).then(
      () => {},
    ));
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
    request = parseProjectMediaResultUiRequest({
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
        r.service === CREWON_PROJECT_MEDIA_RESULTS_SERVICE &&
        r.apiVersion === CREWON_PROJECT_MEDIA_RESULTS_API_VERSION,
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
    "project_media_result_ui_unavailable",
  );
}
