import type { ProjectDetails } from "./creative-project-controller";
import { ConceptGenerationController } from "./ConceptGenerationController";
import { ConceptQueryController } from "./ConceptQueryController";
import { ConceptImageSelectionController } from "./ConceptImageSelectionController";
import { bindConceptCapabilities } from "./ConceptCapabilityBinding";
import { ConceptGenerationIntentController } from "./ConceptGenerationIntentController";
import type { PublicConceptAsset } from "@crewon/plugin-sdk/contracts";
import type {
  ConceptDraft,
  ConceptIntent,
  ConceptPorts,
  ConceptSnapshot,
  ConceptSelection,
} from "./ConceptController.types";

export function validConceptPrompt(prompt: string): boolean {
  return (
    Boolean(prompt.trim()) &&
    prompt.length <= 2000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(prompt)
  );
}
export function validConceptName(name: string): boolean {
  return (
    Boolean(name.trim()) &&
    [...name.trim()].length <= 160 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(name)
  );
}
function code(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return error instanceof Error ? error.message : "";
}
const initial = (): ConceptSnapshot => ({
  phase: "idle",
  assets: [],
  nextAfterAssetId: null,
  selection: null,
  opening: false,
  editing: false,
  draft: null,
  confirmedOldBrief: false,
  saving: false,
  pendingKind: null,
  failure: null,
  conflictRefreshed: false,
  error: null,
  notice: null,
  revisions: [],
  nextAfterAssetRevision: null,
  loadingHistory: false,
});

/** Owns confirmed concept inputs only; asset identity and input revision remain distinct. */
export class ConceptController {
  readonly generations: ConceptGenerationController;
  readonly submissions: ConceptGenerationIntentController;
  readonly queries: ConceptQueryController;
  readonly images: ConceptImageSelectionController;
  #ports: ConceptPorts;
  #details: ProjectDetails | null = null;
  #ready = false;
  #disposed = false;
  #epoch = 0;
  #snapshot = initial();
  #listeners = new Set<() => void>();
  #reads = new Map<
    "assets" | "selection" | "history" | "refresh",
    AbortController
  >();
  #write: AbortController | null = null;
  #intent: ConceptIntent | null = null;
  #drafts = new Map<string, ConceptDraft>();
  constructor(ports: ConceptPorts) {
    this.#ports = ports;
    this.generations = new ConceptGenerationController(ports.generationClient);
    this.submissions = new ConceptGenerationIntentController({
      client: ports.submissionClient,
      contexts: ports.contextClient,
      lockChanged: () => {
        this.#ports.lockChanged(this.locked);
        for (const listener of this.#listeners) listener();
      },
      accepted: (request, receipt) =>
        this.generations.expectReceipt(request.reference, receipt),
      restore: (request) => ports.restoreGenerationSource(request),
      restored: () => {
        if (!this.submissions.locked) void this.loadAssets();
      },
    });
    this.queries = new ConceptQueryController({
      client: ports.queryClient,
      lockChanged: () => {
        this.#ports.lockChanged(this.locked);
        for (const listener of this.#listeners) listener();
      },
      accepted: () => {
        if (this.#ready) void this.generations.refresh();
      },
      restore: (request) => ports.restoreQuerySource(request),
      restored: () => {
        if (!this.queries.locked) void this.loadAssets();
      },
    });
    this.images = new ConceptImageSelectionController({
      client: ports.selectionClient,
      restore: (request) => ports.restoreSelectionSource(request),
      lockChanged: () => {
        this.#ports.lockChanged(this.locked);
        for (const listener of this.#listeners) listener();
      },
    });
    this.generations.subscribe(() => {
      this.submissions.setRecord(this.generations.getSnapshot());
      this.queries.setRecord(this.generations.getSnapshot());
      this.images.setRecord(this.generations.getSnapshot());
    });
  }
  getSnapshot = (): ConceptSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  get locked(): boolean {
    return (
      this.#snapshot.saving ||
      this.#snapshot.pendingKind !== null ||
      this.submissions.locked ||
      this.queries.locked ||
      this.images.locked ||
      this.#ports.recovery.conflict
    );
  }
  #update(change: Partial<ConceptSnapshot>) {
    if (this.#disposed) return;
    const locked = this.locked;
    this.#snapshot = { ...this.#snapshot, ...change };
    const selection = this.#snapshot.selection;
    this.generations.bind(
      selection && !this.#snapshot.editing
        ? {
            projectId: selection.asset.projectId,
            assetId: selection.asset.assetId,
            assetRevision: selection.revision.assetRevision,
          }
        : null,
      this.#ready,
    );
    this.#bindSubmission();
    if (locked !== this.locked) this.#ports.lockChanged(this.locked);
    for (const listener of this.#listeners) listener();
  }
  bindProject(details: ProjectDetails | null, ready: boolean) {
    if (this.#disposed) return;
    const changed =
      details?.project.projectId !== this.#details?.project.projectId;
    const latestChanged =
      details?.project.latestBriefRevision !==
      this.#details?.project.latestBriefRevision;
    const activated = ready && !this.#ready;
    this.#details = details;
    this.#ready = ready;
    if (changed || !ready) {
      ++this.#epoch;
      this.#abortReads();
      this.#write?.abort();
      this.#write = null;
      this.#intent = null;
      this.#update(initial());
    } else if (latestChanged) this.#update({ confirmedOldBrief: false });
    if (
      ready &&
      details &&
      (changed || activated || this.#snapshot.phase === "idle")
    )
      void this.loadAssets();
    this.#bindSubmission();
  }
  #bindSubmission() {
    bindConceptCapabilities({
      selection: this.#snapshot.selection,
      project: this.#details?.project,
      editing: this.#snapshot.editing,
      ready: this.#ready,
      blocked: this.#ports.projectBlocked(),
      metadataPending:
        this.#snapshot.saving || this.#snapshot.pendingKind !== null,
      submissions: this.submissions,
      queries: this.queries,
      images: this.images,
      recovery: this.#ports.recovery,
    });
  }
  adoptGenerationSelection(selection: ConceptSelection) {
    if (
      !this.#ready ||
      this.#disposed ||
      selection.asset.projectId !== this.#details?.project.projectId
    )
      return;
    this.#remember();
    this.#abortReads();
    this.#update({
      ...initial(),
      phase: "ready",
      assets: this.#assetsWith(selection.asset),
      selection,
      draft: {
        name: selection.asset.name,
        prompt: selection.revision.prompt,
        source: selection.source,
      },
      editing: false,
    });
  }
  preserveGenerationDraft() {
    this.#remember();
  }
  #abortReads() {
    for (const controller of this.#reads.values()) controller.abort();
    this.#reads.clear();
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    ++this.#epoch;
    this.#abortReads();
    this.#write?.abort();
    this.#listeners.clear();
    this.generations.dispose();
    this.submissions.dispose();
    this.queries.dispose();
    this.images.dispose();
  }
  #reading(kind: "assets" | "selection" | "history" | "refresh") {
    this.#reads.get(kind)?.abort();
    const controller = new AbortController();
    this.#reads.set(kind, controller);
    const epoch = this.#epoch;
    return {
      controller,
      current: () =>
        this.#ready &&
        !this.#disposed &&
        epoch === this.#epoch &&
        !controller.signal.aborted &&
        this.#reads.get(kind) === controller,
    };
  }
  #cacheKey(
    assetId: string | null = this.#snapshot.selection?.asset.assetId ?? null,
  ): string {
    return JSON.stringify([this.#details?.project.projectId, assetId ?? null]);
  }
  #remember() {
    if (this.#snapshot.editing && this.#snapshot.draft)
      this.#drafts.set(this.#cacheKey(), this.#snapshot.draft);
  }
  #available(): boolean {
    return (
      this.#ready &&
      !this.#disposed &&
      Boolean(this.#details) &&
      !this.#ports.projectBlocked()
    );
  }
  #assetsWith(asset: PublicConceptAsset) {
    const assets = new Map(
      this.#snapshot.assets.map((entry) => [entry.assetId, entry]),
    );
    const previous = assets.get(asset.assetId);
    if (!previous || previous.revision <= asset.revision)
      assets.set(asset.assetId, asset);
    return [...assets.values()];
  }
  async loadAssets(more = false) {
    if (!this.#available() || this.locked) return;
    const projectId = this.#details!.project.projectId;
    const afterAssetId = more ? this.#snapshot.nextAfterAssetId : null;
    if (more && afterAssetId === null) return;
    const read = this.#reading("assets");
    this.#update({ phase: "loading", error: null });
    try {
      const result = await this.#ports.client.listConceptAssets(
        { projectId, query: { afterAssetId, limit: 20 } },
        { signal: read.controller.signal },
      );
      if (!read.current()) return;
      const assets = new Map(
        (more ? this.#snapshot.assets : []).map((asset) => [
          asset.assetId,
          asset,
        ]),
      );
      for (const asset of result.assets) {
        const old = assets.get(asset.assetId);
        if (!old || old.revision <= asset.revision)
          assets.set(asset.assetId, asset);
      }
      this.#update({
        phase: "ready",
        assets: [...assets.values()],
        nextAfterAssetId: result.nextAfterAssetId,
      });
    } catch {
      if (read.current())
        this.#update({
          phase: "unavailable",
          error: "概念输入读取失败，请重试。",
        });
    }
  }
  startNew() {
    if (
      !this.#available() ||
      this.locked ||
      this.#details!.project.state === "archived"
    )
      return;
    this.#remember();
    this.#reads.get("selection")?.abort();
    this.#reads.get("history")?.abort();
    const saved = this.#drafts.get(this.#cacheKey(null));
    const draft = saved ?? {
      name: "概念图",
      prompt: "",
      source: this.#details!.brief,
    };
    this.#update({
      selection: null,
      editing: true,
      draft,
      confirmedOldBrief: false,
      error: null,
      notice: null,
      revisions: [],
      nextAfterAssetRevision: null,
      opening: false,
      loadingHistory: false,
    });
  }
  close() {
    if (this.locked) return;
    this.#remember();
    this.#reads.get("selection")?.abort();
    this.#reads.get("history")?.abort();
    this.#update({
      selection: null,
      editing: false,
      opening: false,
      loadingHistory: false,
      error: null,
      notice: null,
      draft: null,
      revisions: [],
      nextAfterAssetRevision: null,
    });
  }
  async openAsset(assetId: string, assetRevision?: number) {
    if (!this.#available() || this.locked) return;
    this.#remember();
    const projectId = this.#details!.project.projectId;
    const read = this.#reading("selection");
    this.#reads.get("history")?.abort();
    this.#update({
      opening: true,
      error: null,
      selection: null,
      editing: false,
      draft: null,
      revisions: [],
      nextAfterAssetRevision: null,
      loadingHistory: false,
    });
    try {
      const { asset } = await this.#ports.client.getConceptAsset(
        { projectId, assetId },
        { signal: read.controller.signal },
      );
      if (!read.current()) return;
      const { assetRevision: revision } =
        await this.#ports.client.getConceptRevision(
          {
            projectId,
            assetId,
            assetRevision: assetRevision ?? asset.latestAssetRevision,
          },
          { signal: read.controller.signal },
        );
      if (!read.current()) return;
      const { brief: source } = await this.#ports.client.getBrief(
        { projectId, briefRevision: revision.briefRevision },
        { signal: read.controller.signal },
      );
      if (!read.current()) return;
      const cached =
        assetRevision === undefined
          ? this.#drafts.get(this.#cacheKey(assetId))
          : undefined;
      this.#update({
        opening: false,
        selection: { asset, revision, source },
        assets: this.#assetsWith(asset),
        draft: cached ?? { name: asset.name, prompt: revision.prompt, source },
        editing: Boolean(cached),
        confirmedOldBrief: false,
        notice: cached ? "未保存的概念描述已保留" : null,
      });
    } catch {
      if (read.current())
        this.#update({ opening: false, error: "概念修订读取失败，请重试。" });
    }
  }
  editRevision() {
    if (
      !this.#available() ||
      this.locked ||
      !this.#snapshot.selection ||
      this.#details!.project.state === "archived"
    )
      return;
    this.#update({ editing: true, confirmedOldBrief: false, notice: null });
  }
  setPrompt(prompt: string) {
    this.#edit({ prompt });
  }
  setName(name: string) {
    if (!this.#snapshot.selection) this.#edit({ name });
  }
  #edit(change: Partial<ConceptDraft>) {
    if (
      !this.#available() ||
      this.locked ||
      !this.#snapshot.editing ||
      !this.#snapshot.draft ||
      this.#details!.project.state === "archived"
    )
      return;
    this.#update({
      draft: { ...this.#snapshot.draft, ...change },
      notice: null,
    });
    this.#remember();
  }
  useLatestBrief() {
    if (
      !this.#available() ||
      this.locked ||
      !this.#snapshot.editing ||
      !this.#snapshot.draft ||
      this.#details!.project.state === "archived"
    )
      return;
    this.#update({
      draft: { ...this.#snapshot.draft, source: this.#details!.brief },
      confirmedOldBrief: false,
      notice: null,
    });
    this.#remember();
  }
  confirmOldBrief(confirmedOldBrief: boolean) {
    if (
      !this.#available() ||
      this.#snapshot.saving ||
      this.submissions.locked ||
      this.images.locked ||
      !this.#snapshot.draft ||
      this.#details!.project.state === "archived"
    )
      return;
    this.#update({ confirmedOldBrief });
  }
  get canSave(): boolean {
    const draft = this.#snapshot.draft;
    return (
      this.#available() &&
      !this.submissions.locked &&
      !this.images.locked &&
      !this.#snapshot.saving &&
      Boolean(draft) &&
      this.#snapshot.editing &&
      this.#details!.project.state === "active" &&
      validConceptPrompt(draft!.prompt) &&
      validConceptName(draft!.name) &&
      (draft!.source.briefRevision ===
        this.#details!.project.latestBriefRevision ||
        this.#snapshot.confirmedOldBrief) &&
      (!this.#intent ||
        (this.#snapshot.failure === "conflict" &&
          this.#snapshot.conflictRefreshed))
    );
  }
  async save() {
    if (!this.canSave) return;
    const draft = this.#snapshot.draft!;
    const project = this.#details!.project;
    const selection = this.#snapshot.selection;
    const common = {
      briefRevision: draft.source.briefRevision,
      prompt: draft.prompt,
      expectedProjectRevision: project.revision,
    };
    const intent: ConceptIntent = selection
      ? {
          kind: "append",
          input: {
            projectId: project.projectId,
            assetId: selection.asset.assetId,
            request: {
              ...common,
              expectedAssetMetadataRevision: selection.asset.revision,
            },
            idempotencyKey: crypto.randomUUID(),
          },
        }
      : {
          kind: "create",
          input: {
            projectId: project.projectId,
            request: { ...common, name: draft.name.trim() },
            idempotencyKey: crypto.randomUUID(),
          },
        };
    await this.#commit(intent);
  }
  async retry() {
    if (this.#intent && !this.#snapshot.saving && this.#available())
      await this.#commit(this.#intent);
  }
  async refreshConflict() {
    if (
      !this.#intent ||
      this.#snapshot.failure !== "conflict" ||
      !this.#available()
    )
      return;
    const intent = this.#intent;
    const read = this.#reading("refresh");
    this.#update({ opening: true, error: null, conflictRefreshed: false });
    try {
      const details = await this.#ports.refreshProject(
        intent.input.projectId,
        read.controller.signal,
      );
      if (!read.current() || !details)
        throw new Error("concept_refresh_unavailable");
      if (intent.kind === "append") {
        const { asset } = await this.#ports.client.getConceptAsset(
          { projectId: intent.input.projectId, assetId: intent.input.assetId },
          { signal: read.controller.signal },
        );
        if (!read.current()) return;
        if (
          !this.#snapshot.selection ||
          this.#snapshot.selection.asset.assetId !== asset.assetId
        )
          return;
        this.#update({
          selection: { ...this.#snapshot.selection, asset },
          assets: this.#assetsWith(asset),
        });
      }
      if (read.current())
        this.#update({
          opening: false,
          conflictRefreshed: true,
          notice: "当前版本已重新读取，确认输入后再保存新修订",
        });
    } catch {
      if (read.current())
        this.#update({
          opening: false,
          error: "当前版本读取失败，概念草稿已保留。",
        });
    }
  }
  dismissConflict() {
    if (this.#snapshot.failure !== "conflict" || this.#snapshot.saving) return;
    this.#intent = null;
    this.#update({
      pendingKind: null,
      failure: null,
      conflictRefreshed: false,
      error: null,
      notice: "本次保存已取消，概念草稿仍保留",
    });
  }
  async loadHistory(more = false) {
    if (!this.#available() || !this.#snapshot.selection) return;
    const { asset } = this.#snapshot.selection;
    const afterAssetRevision = more ? this.#snapshot.nextAfterAssetRevision : 0;
    if (afterAssetRevision === null) return;
    const read = this.#reading("history");
    this.#update({ loadingHistory: true, error: null });
    try {
      const result = await this.#ports.client.listConceptRevisions(
        {
          projectId: asset.projectId,
          assetId: asset.assetId,
          query: { afterAssetRevision, limit: 20 },
        },
        { signal: read.controller.signal },
      );
      if (
        !read.current() ||
        this.#snapshot.selection?.asset.assetId !== asset.assetId
      )
        return;
      const revisions = new Map(
        (more ? this.#snapshot.revisions : []).map((revision) => [
          revision.assetRevision,
          revision,
        ]),
      );
      for (const revision of result.revisions)
        revisions.set(revision.assetRevision, revision);
      this.#update({
        loadingHistory: false,
        revisions: [...revisions.values()].sort(
          (a, b) => b.assetRevision - a.assetRevision,
        ),
        nextAfterAssetRevision: result.nextAfterAssetRevision,
      });
    } catch {
      if (read.current())
        this.#update({
          loadingHistory: false,
          error: "概念历史读取失败，请重试。",
        });
    }
  }
  async #commit(intent: ConceptIntent) {
    if (
      !this.#available() ||
      this.#write ||
      this.submissions.locked ||
      this.images.locked
    )
      return;
    this.#intent = Object.freeze({
      ...intent,
      input: Object.freeze({
        ...intent.input,
        request: Object.freeze({ ...intent.input.request }),
      }),
    }) as ConceptIntent;
    this.#abortReads();
    const controller = new AbortController();
    const epoch = this.#epoch;
    this.#write = controller;
    const current = () =>
      this.#ready &&
      !this.#disposed &&
      epoch === this.#epoch &&
      !controller.signal.aborted &&
      this.#write === controller;
    this.#update({
      saving: true,
      pendingKind: intent.kind,
      failure: null,
      conflictRefreshed: false,
      error: null,
      notice: null,
      opening: false,
      loadingHistory: false,
    });
    try {
      const result =
        intent.kind === "create"
          ? await this.#ports.client.createConcept(intent.input, {
              signal: controller.signal,
            })
          : await this.#ports.client.appendConceptRevision(intent.input, {
              signal: controller.signal,
            });
      if (!current()) return;
      this.#ports.projectCommitted(result.project);
      this.#intent = null;
      this.#drafts.delete(
        this.#cacheKey(intent.kind === "append" ? intent.input.assetId : null),
      );
      const asset = this.#snapshot.selection?.asset;
      const committedAsset =
        asset &&
        asset.assetId === result.asset.assetId &&
        asset.revision > result.asset.revision
          ? asset
          : result.asset;
      const assets = new Map(
        this.#snapshot.assets.map((entry) => [entry.assetId, entry]),
      );
      const existing = assets.get(result.asset.assetId);
      if (!existing || existing.revision <= result.asset.revision)
        assets.set(result.asset.assetId, result.asset);
      this.#update({
        pendingKind: null,
        selection: {
          asset: committedAsset,
          revision: result.assetRevision,
          source: this.#snapshot.draft!.source,
        },
        assets: [...assets.values()],
        editing: false,
        confirmedOldBrief: false,
        revisions: [],
        nextAfterAssetRevision: null,
        notice: `概念输入 v${result.assetRevision.assetRevision} 已保存`,
      });
      if (result.disposition === "replayed") {
        // The receipt is a confirmed historical save, not permission to regress current state.
        const read = this.#reading("refresh");
        await this.#ports.refreshProject(
          result.project.projectId,
          read.controller.signal,
        );
        if (!read.current()) return;
        const { asset: latest } = await this.#ports.client.getConceptAsset(
          { projectId: result.asset.projectId, assetId: result.asset.assetId },
          { signal: read.controller.signal },
        );
        if (
          read.current() &&
          this.#snapshot.selection?.asset.assetId === latest.assetId &&
          latest.revision >= this.#snapshot.selection.asset.revision
        ) {
          this.#update({
            selection: { ...this.#snapshot.selection, asset: latest },
            assets: this.#assetsWith(latest),
          });
        }
      }
    } catch (error) {
      if (!current()) return;
      if (!this.#intent) {
        this.#update({
          error: "输入已保存；当前状态刷新失败，请重新打开查看。",
        });
        return;
      }
      const conflict = [
        "creative_project_revision_conflict",
        "creative_project_asset_revision_conflict",
        "creative_project_archived",
      ].includes(code(error));
      this.#update({
        saving: false,
        failure: conflict ? "conflict" : "uncertain",
        error: conflict
          ? "项目或概念已有新版本。草稿已保留，请重新读取并确认后保存。"
          : "概念保存结果尚未确认，请重试原请求。",
      });
    } finally {
      if (this.#write === controller) {
        const alive = current();
        this.#write = null;
        if (alive) this.#update({ saving: false });
      }
    }
  }
}
