import { types } from "node:util";
import {
  captureProjectMediaInputAuthorization,
  projectMediaInputAuthority,
  assertProjectMediaInputCurrent,
  mediaInputSame,
  mediaInputDigest,
  projectMediaInputBound,
  materialPreparationFields,
  mediaGenerationFail as fail,
  MEDIA_GENERATION_ACTION,
  type ActorContext,
  type AuthorizationDecision,
  type ProjectMediaGenerationContext,
  type ProjectMediaGenerationReference,
  type ProjectMediaInputAuthorizationPort,
  type ProjectMediaWorkflow,
  type ProjectMediaRole,
  type ProjectMediaWorkflowReview,
} from "@crewon/application";
import type { PluginTaskAdmission } from "@crewon/domain";
import { SqliteExtensionStore, PostgresExtensionStore } from "@crewon/store";
import {
  InstalledPluginRunContext,
  type InstalledPluginRunSnapshot,
  type InstalledPluginRunPurpose,
} from "./plugins/installed-plugin-run-context.ts";
import { ProjectMediaMaterialPreparer } from "./project-media-material-preparer.ts";

/** Independent dispatch/recovery purposes; metadata reading alone never grants supplier IO. */
export type ProjectMediaRunPermission = Readonly<{
  actor: ActorContext;
  action: "projectMediaRun:submit" | "projectMediaRun:observe";
  resource: Readonly<{
    runId: string;
    projectId: string;
    mediaInputId: string;
    inputRevision: number;
    executionId: string;
  }>;
}>;
export interface ProjectMediaRunAuthorizationPort {
  authorize(input: ProjectMediaRunPermission): Promise<AuthorizationDecision>;
  assertActive(input: ProjectMediaRunPermission): void;
}
/** Host-owned token. A copied projection is never accepted by this reader. */
export type ProjectMediaRunSnapshot = Readonly<{
  reference: ProjectMediaGenerationReference;
  workflow: ProjectMediaWorkflow;
}>;
export type ProjectMediaRenderInput = Readonly<{
  workflow: ProjectMediaWorkflow;
  prompt: string;
  targetServiceOrigin: string;
  images: Readonly<
    Partial<
      Record<
        ProjectMediaRole,
        Readonly<{
          filename: string;
          subfolder: string;
          type: "output" | "input";
        }>
      >
    >
  >;
}>;
type Saved = Readonly<{
  installed: InstalledPluginRunSnapshot;
  admission: PluginTaskAdmission;
  context: ProjectMediaGenerationContext;
}>;

/** Private Worker context/preflight, not a plugin service or network dispatch authority.
 * Actual installed Run, accepted SQL history and current bytes have distinct roles.
 */
export class ProjectMediaRunContext {
  readonly #installedOwner: InstalledPluginRunContext;
  readonly #installedCurrent: InstalledPluginRunContext["assertCurrent"];
  readonly #admission: InstalledPluginRunContext["verifiedTaskAdmission"];
  readonly #read: SqliteExtensionStore["loadProjectMediaGenerationContext"];
  readonly #link: SqliteExtensionStore["loadProjectMediaGenerationLink"];
  readonly #observe: ProjectMediaMaterialPreparer["observeInput"];
  readonly #metadata: ProjectMediaInputAuthorizationPort;
  readonly #authorization: ProjectMediaRunAuthorizationPort;
  readonly #enabled: () => boolean;
  readonly #snapshots = new WeakMap<ProjectMediaRunSnapshot, Saved>();
  constructor(
    input: Readonly<{
      installed: InstalledPluginRunContext;
      extensions: SqliteExtensionStore | PostgresExtensionStore;
      materials: ProjectMediaMaterialPreparer;
      metadataAuthorization: ProjectMediaInputAuthorizationPort;
      authorization: ProjectMediaRunAuthorizationPort;
    }>,
  ) {
    const p =
      input.extensions instanceof SqliteExtensionStore
        ? SqliteExtensionStore.prototype
        : input.extensions instanceof PostgresExtensionStore
          ? PostgresExtensionStore.prototype
          : null;
    if (
      !p ||
      !(input.installed instanceof InstalledPluginRunContext) ||
      !(input.materials instanceof ProjectMediaMaterialPreparer) ||
      [input.extensions, input.installed, input.materials].some((v) =>
        types.isProxy(v),
      )
    )
      fail("dependency_invalid");
    this.#installedOwner = input.installed;
    this.#installedCurrent =
      InstalledPluginRunContext.prototype.assertCurrent.bind(input.installed);
    this.#admission =
      InstalledPluginRunContext.prototype.verifiedTaskAdmission.bind(
        input.installed,
      );
    this.#read = p.loadProjectMediaGenerationContext.bind(input.extensions);
    this.#link = p.loadProjectMediaGenerationLink.bind(input.extensions);
    const descriptor = Object.getOwnPropertyDescriptor(
      p,
      "projectMediaGenerationVersion",
    )!;
    this.#enabled = () =>
      Reflect.apply(descriptor.get!, input.extensions, []) ===
      "crewon.project-media-generation-link.v1";
    this.#observe = ProjectMediaMaterialPreparer.prototype.observeInput.bind(
      input.materials,
    );
    this.#metadata = captureProjectMediaInputAuthorization(
      input.metadataAuthorization,
    );
    this.#authorization = Object.freeze({
      authorize: projectMediaInputBound<
        ProjectMediaRunAuthorizationPort["authorize"]
      >(input.authorization, "authorize"),
      assertActive: projectMediaInputBound<
        ProjectMediaRunAuthorizationPort["assertActive"]
      >(input.authorization, "assertActive"),
    });
  }
  async load(
    installed: InstalledPluginRunSnapshot,
    options: Readonly<{
      purpose: InstalledPluginRunPurpose;
      signal: AbortSignal;
    }>,
  ): Promise<ProjectMediaRunSnapshot | null> {
    const { purpose, signal } = this.#options(options);
    await this.#installedCurrent(installed, purpose, signal);
    const admission = this.#admission(installed);
    if (
      admission.pluginId !== "crewon.short-drama" ||
      admission.action !== MEDIA_GENERATION_ACTION
    )
      return null;
    if (!this.#enabled()) fail("unavailable");
    const locator = {
      tenantId: admission.tenantId,
      spaceId: admission.spaceId,
      runId: admission.runId,
    };
    const link = await this.#link(locator);
    if (!link || !mediaInputSame(link.admission, admission))
      fail("history_invalid");
    // This lookup establishes only the original selectors, not supplier/path authority.
    await this.#authorize(link, purpose, signal);
    const context = await this.#read(locator);
    if (!context || !mediaInputSame(context.link, link))
      fail("history_invalid");
    const saved = Object.freeze({ installed, admission, context });
    await this.#current(saved, purpose, signal);
    const snapshot = Object.freeze({
      reference: link.reference,
      workflow: context.input.workflow,
    });
    this.#snapshots.set(snapshot, saved);
    return snapshot;
  }
  /** Only for a not-yet-sent supplier operation. The original execution owner must still authorize IO. */
  async prepareSubmit(
    snapshot: ProjectMediaRunSnapshot,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<ProjectMediaRenderInput> {
    const signal = this.#signal(options),
      saved = this.#saved(snapshot),
      r = saved.context.link.reference;
    await this.#current(saved, "submit", signal);
    const observed = await this.#observe(
      saved.context.link.actor,
      {
        projectId: r.projectId,
        mediaInputId: r.mediaInputId,
        inputRevision: r.inputRevision,
        expectedInputRevision: r.expectedInputRevision,
      },
      { signal },
    );
    if (
      observed.disposition !== "verified" ||
      observed.input.contentDigest !== r.mediaInputDigest ||
      observed.materials.length !== r.materials.length
    )
      fail("materials_unavailable");
    for (const [index, m] of observed.materials.entries()) {
      const expected = r.materials[index]!;
      if (
        m.role !== expected.role ||
        m.preparation.state.initial.intentId !== expected.intentId ||
        m.preparation.state.initial.contentDigest !== expected.initialDigest ||
        m.preparation.state.event.revision !== expected.eventRevision ||
        mediaInputDigest(m.preparation.state.event) !== expected.eventDigest
      )
        fail("material_changed");
    }
    await this.#current(saved, "submit", signal);
    return Object.freeze({
      workflow: saved.context.input.workflow,
      prompt: saved.context.input.prompt,
      targetServiceOrigin:
        saved.context.materials[0]!.preparation.initial.transfer.origin,
      images: Object.freeze(
        Object.fromEntries(
          saved.context.materials.map((m) => [
            m.role,
            m.preparation.initial.transfer.output,
          ]),
        ),
      ),
    });
  }
  /** Already accepted supplier operations recover with their original workflow; no upstream or byte IO. */
  async readObservation(
    snapshot: ProjectMediaRunSnapshot,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<ProjectMediaRunSnapshot> {
    const signal = this.#signal(options),
      saved = this.#saved(snapshot);
    await this.#current(saved, "observe", signal);
    return Object.freeze({
      reference: saved.context.link.reference,
      workflow: saved.context.input.workflow,
    });
  }
  /** Host-only current identity/history checks. Neither this nor its target projection grants IO. */
  async assertCurrent(
    snapshot: ProjectMediaRunSnapshot,
    options: Readonly<{
      purpose: InstalledPluginRunPurpose;
      signal: AbortSignal;
    }>,
  ): Promise<void> {
    const { purpose, signal } = this.#options(options);
    await this.#current(this.#saved(snapshot), purpose, signal);
  }
  verifiedExecutionTarget(
    snapshot: ProjectMediaRunSnapshot,
  ): ProjectMediaWorkflowReview["targetIdentity"] {
    const target = this.#saved(snapshot).context.input.target;
    return Object.freeze({
      pluginId: "crewon.short-drama",
      version: target.installation.version,
      publisherId: target.installation.publisherId,
      packageDigest: target.installation.packageDigest,
      manifestDigest: target.configuration.manifestDigest,
      implementationDigest: target.configuration.implementationDigest,
    });
  }
  assertInstalledReader(installed: InstalledPluginRunContext): void {
    if (installed !== this.#installedOwner) fail("dependency_invalid");
  }
  #saved(snapshot: ProjectMediaRunSnapshot) {
    const value = this.#snapshots.get(snapshot);
    if (!value) fail("snapshot_invalid");
    return value;
  }
  #options(input: unknown): {
    purpose: InstalledPluginRunPurpose;
    signal: AbortSignal;
  } {
    const r = materialPreparationFields(input, ["purpose", "signal"]);
    if (r.purpose !== "submit" && r.purpose !== "observe")
      fail("purpose_invalid");
    return { purpose: r.purpose, signal: this.#checkedSignal(r.signal) };
  }
  #signal(input: unknown) {
    return this.#checkedSignal(
      materialPreparationFields(input, ["signal"]).signal,
    );
  }
  #checkedSignal(signal: unknown) {
    if (!(signal instanceof AbortSignal) || types.isProxy(signal))
      fail("signal_invalid");
    signal.throwIfAborted();
    return AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
  }
  async #current(
    saved: Saved,
    purpose: InstalledPluginRunPurpose,
    signal: AbortSignal,
  ) {
    await this.#installedCurrent(saved.installed, purpose, signal);
    await this.#authorize(saved.context.link, purpose, signal);
    const context = await this.#read({
      tenantId: saved.admission.tenantId,
      spaceId: saved.admission.spaceId,
      runId: saved.admission.runId,
    });
    // Each accepted record is independently bounded and digest-verified by the real archive.
    // Three valid material records need not fit the legacy 64KiB single-record canonicalizer.
    if (
      !context ||
      context.input.contentDigest !== saved.context.input.contentDigest ||
      !mediaInputSame(context.link, saved.context.link) ||
      context.materials.length !== saved.context.materials.length ||
      context.materials.some((m, index) => {
        const previous = saved.context.materials[index]!;
        return (
          m.role !== previous.role ||
          m.preparation.initial.contentDigest !==
            previous.preparation.initial.contentDigest ||
          mediaInputDigest(m.preparation.event) !==
            mediaInputDigest(previous.preparation.event)
        );
      })
    )
      fail("history_invalid");
    await this.#installedCurrent(saved.installed, purpose, signal);
    await this.#authorize(saved.context.link, purpose, signal);
  }
  async #authorize(
    link: ProjectMediaGenerationContext["link"],
    purpose: InstalledPluginRunPurpose,
    signal: AbortSignal,
  ) {
    const r = link.reference,
      permission: ProjectMediaRunPermission = Object.freeze({
        actor: link.actor,
        action:
          purpose === "submit"
            ? "projectMediaRun:submit"
            : "projectMediaRun:observe",
        resource: Object.freeze({
          runId: link.binding.runId,
          projectId: r.projectId,
          mediaInputId: r.mediaInputId,
          inputRevision: r.inputRevision,
          executionId: r.executionId,
        }),
      });
    const metadata = projectMediaInputAuthority({
      actor: link.actor,
      projectId: r.projectId,
      mediaInputId: r.mediaInputId,
      inputRevision: r.inputRevision,
      action: "read",
      review: null,
      command: null,
      authorization: this.#metadata,
      signal,
    });
    const active = () => {
      signal.throwIfAborted();
      const result: unknown = this.#authorization.assertActive(permission);
      if (result !== undefined) {
        try {
          void Promise.prototype.then.call(
            result,
            () => undefined,
            () => undefined,
          );
        } catch {
          /* Never invoke arbitrary thenables. */
        }
        fail("authority_invalid");
      }
    };
    active();
    await assertProjectMediaInputCurrent(metadata, "before");
    const decision = await this.#authorization.authorize(permission);
    active();
    const outcome =
      !decision || typeof decision !== "object" || types.isProxy(decision)
        ? null
        : Object.getOwnPropertyDescriptor(decision, "outcome");
    if (
      !outcome?.enumerable ||
      !Object.hasOwn(outcome, "value") ||
      outcome.value !== "allow"
    )
      fail("denied");
    await assertProjectMediaInputCurrent(metadata, "before");
    active();
  }
}
