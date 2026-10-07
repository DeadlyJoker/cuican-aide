import { mediaReferenceTarget } from "./ProjectAssetMediaAdoption";
import { reviewAssetRecovery } from "./ProjectAssetRecoveryReview";
import type { ProjectMediaResultSummary } from "../project-media-results-service";
import type {
  PluginProjectAssetUiClient,
  ProjectAssetContent,
  ProjectAssetKind,
} from "../project-assets-v2-service";
import type { PluginProjectTextUiClient } from "../project-texts-ui-service";
import type { ProjectDetails } from "./creative-project-controller";
import {
  initialAssetSnapshot,
  type AssetSnapshot,
  type AssetIntent,
} from "./ProjectAssetController.types";
import { ProjectAssetRecoveryController } from "./ProjectAssetRecoveryController";
import { readAssetVersion } from "./ProjectAssetRead";
import {
  assertAssetWarmRecord,
  assetViewWithoutRegression,
  executeWarmAssetMutation,
  mergeAssetHeads,
  type AssetWarmReceipt,
} from "./ProjectAssetWarmConfirmation";
import type { PluginProjectAssetRecoveryClient } from "../project-asset-recovery-v2-service";
import {
  assetDraftFromRevision,
  readAssetDraftScript,
  validAssetDraft,
} from "./ProjectAssetDraftSources";
export type {
  AssetSnapshot,
  AssetDraft,
  AssetScriptSource,
} from "./ProjectAssetController.types";

/** Metadata candidates and explicit choices. Reads, reconnect and navigation never execute media. */
export class ProjectAssetController {
  readonly recovery: ProjectAssetRecoveryController;
  readonly #client: PluginProjectAssetUiClient;
  readonly #texts: Pick<
    PluginProjectTextUiClient,
    "listArtifacts" | "getArtifact" | "getRevision"
  >;
  readonly #physicalWritesPending: () => boolean;
  readonly #listeners = new Set<() => void>();
  #snapshot = initialAssetSnapshot();
  #project: ProjectDetails | null = null;
  #ready = false;
  #hostReady = false;
  #activated = false;
  #disposed = false;
  #epoch = 0;
  #read: AbortController | null = null;
  #write: AbortController | null = null;
  #warmReceipt: AssetWarmReceipt | null = null;
  #warmAckReceipt: AssetWarmReceipt | null = null;
  constructor(input: {
    client: PluginProjectAssetUiClient;
    texts: Pick<
      PluginProjectTextUiClient,
      "listArtifacts" | "getArtifact" | "getRevision"
    >;
    recovery: PluginProjectAssetRecoveryClient;
    physicalWritesPending(): boolean;
  }) {
    this.#client = input.client;
    this.#texts = input.texts;
    this.#physicalWritesPending = input.physicalWritesPending;
    this.recovery = new ProjectAssetRecoveryController({
      client: input.recovery,
      physicalWritesPending: input.physicalWritesPending,
    });
    this.recovery.subscribe(() => {
      if (
        this.#warmReceipt &&
        this.#warmAckReceipt === this.#warmReceipt &&
        this.recovery.permitsNewWrite
      ) {
        this.#warmReceipt = null;
        this.#warmAckReceipt = null;
        this.#publish({ error: null });
      } else this.#publish({});
    });
  }
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly getSnapshot = () => this.#snapshot;
  get locked() {
    return (
      this.#snapshot.saving ||
      this.#snapshot.pending !== null ||
      this.recovery.getSnapshot().intent !== null
    );
  }
  get canRead() {
    return (
      this.#ready &&
      !this.#disposed &&
      this.#project !== null &&
      this.#snapshot.phase === "ready" &&
      !this.locked &&
      !this.#snapshot.opening &&
      !this.#physicalWritesPending()
    );
  }
  get canEdit() {
    return (
      this.canRead &&
      this.#warmReceipt === null &&
      this.#project?.project.state === "active" &&
      this.recovery.permitsNewWrite
    );
  }
  get canSave() {
    return (
      this.canEdit &&
      this.#snapshot.dirty &&
      validAssetDraft(this.#snapshot.draft)
    );
  }
  #publish(patch: Partial<AssetSnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #invalidate() {
    ++this.#epoch;
    this.#read?.abort();
    this.#write?.abort();
    this.#read = null;
    this.#write = null;
  }
  get activated() {
    return this.#activated;
  }
  activate() {
    if (this.#disposed || this.#activated) return;
    this.#activated = true;
    this.setReady(this.#hostReady);
    this.#publish({});
  }
  setReady(ready: boolean) {
    this.#hostReady = ready;
    if (!this.#activated) return;
    if (this.#disposed || ready === this.#ready) return;
    this.#ready = ready;
    this.#invalidate();
    this.recovery.setReady(ready);
    this.#publish({
      phase: ready ? "loading" : "waiting",
      opening: false,
      saving: false,
      ...(this.#snapshot.pending
        ? { error: "保存结果尚未确认，连接恢复后请重试原请求。" }
        : {}),
    });
    if (ready && this.#project) void this.refresh();
  }
  setProject(details: ProjectDetails | null) {
    if (this.#disposed) return;
    if (
      details &&
      this.#project &&
      details.project.projectId === this.#project.project.projectId &&
      details.project.revision < this.#project.project.revision
    )
      return;
    const changed =
      details?.project.projectId !== this.#project?.project.projectId;
    // An unresolved write stays associated with its original project and exact key.
    if (changed && this.#snapshot.pending !== null) return;
    const sourceChanged =
      details?.project.revision !== this.#project?.project.revision;
    this.#project = details;
    if (!changed && !sourceChanged) return;
    this.#invalidate();
    if (changed) this.#snapshot = initialAssetSnapshot();
    this.#publish({
      projectId: details?.project.projectId ?? null,
      phase: this.#ready && details ? "loading" : "waiting",
      opening: false,
      saving: false,
    });
    if (this.#ready && details) void this.refresh();
  }
  refreshWriteActivity() {
    this.#publish({});
  }
  #current(epoch: number, projectId: string, request: AbortController) {
    return (
      !this.#disposed &&
      this.#ready &&
      !request.signal.aborted &&
      epoch === this.#epoch &&
      projectId === this.#project?.project.projectId
    );
  }
  #beginRead() {
    this.#read?.abort();
    const request = new AbortController();
    this.#read = request;
    return request;
  }
  async refresh({ more = false }: { more?: boolean } = {}) {
    if (
      !this.#ready ||
      this.#disposed ||
      !this.#project ||
      this.#snapshot.saving
    )
      return;
    const projectId = this.#project.project.projectId,
      epoch = this.#epoch,
      request = this.#beginRead();
    this.#publish({ phase: "loading", error: null });
    try {
      const page = await this.#client.listAssets(
        {
          projectId,
          afterAssetId: more ? this.#snapshot.nextAssetId : null,
          limit: 8,
        },
        { signal: request.signal },
      );
      if (!this.#current(epoch, projectId, request)) return;
      this.#publish({
        phase: "ready",
        assets: mergeAssetHeads(
          more
            ? this.#snapshot.assets
            : this.#snapshot.assets.filter((asset) =>
                page.assets.some((next) => next.assetId === asset.assetId),
              ),
          page.assets,
        ),
        nextAssetId: page.nextAssetId,
      });
      if (this.#snapshot.view)
        await this.#readAsset(
          this.#snapshot.view.asset.assetId,
          false,
          request,
          epoch,
          projectId,
        );
    } catch {
      if (this.#current(epoch, projectId, request))
        this.#publish({
          phase: "unavailable",
          error: "共享资产暂时无法读取，请重新连接。",
        });
    } finally {
      if (this.#read === request) this.#read = null;
    }
  }
  async loadScripts({ more = false }: { more?: boolean } = {}) {
    if (!this.canRead || !this.#project) return;
    const projectId = this.#project.project.projectId,
      epoch = this.#epoch,
      request = this.#beginRead();
    this.#publish({ opening: true, error: null });
    try {
      const page = await this.#texts.listArtifacts(
        {
          projectId,
          afterArtifactId: more ? this.#snapshot.nextScriptArtifactId : null,
          limit: 8,
        },
        { signal: request.signal },
      );
      const candidates = page.artifacts.filter(
        (asset) =>
          asset.kind === "script" && asset.selectedContentRevision !== null,
      );
      const views = await Promise.all(
        candidates.map((asset) =>
          this.#texts.getArtifact(
            { projectId, artifactId: asset.artifactId },
            { signal: request.signal },
          ),
        ),
      );
      if (!this.#current(epoch, projectId, request)) return;
      const scripts = new Map(
        (more ? this.#snapshot.scripts : []).map((source) => [
          source.artifactId,
          source,
        ]),
      );
      for (const { view } of views) {
        if (
          !view?.selectedRevision ||
          view.artifact.kind !== "script" ||
          view.dependencyState !== "current"
        )
          continue;
        const source = view.selectedRevision;
        if (source.kind === "script" && source.episodeId !== null)
          scripts.set(source.artifactId, {
            artifactId: source.artifactId,
            episodeId: source.episodeId,
            contentRevision: source.contentRevision,
            title: source.content.title,
          });
      }
      this.#publish({
        scripts: [...scripts.values()],
        nextScriptArtifactId: page.nextArtifactId,
      });
    } catch {
      if (this.#current(epoch, projectId, request))
        this.#publish({
          error: "剧本来源暂时无法读取，可先按创作需求填写资产。",
        });
    } finally {
      if (this.#read === request) this.#read = null;
      if (this.#current(epoch, projectId, request))
        this.#publish({ opening: false });
    }
  }
  newAsset(kind: ProjectAssetKind) {
    if (!this.canEdit || !this.#project) return;
    this.#publish({
      view: null,
      content: null,
      draft: {
        kind,
        briefRevision: this.#project.brief.briefRevision,
        script: null,
        content: { name: "", setting: "", visualPrompt: "" },
      },
      dirty: true,
      history: [],
      references: [],
      nextContentRevision: null,
      nextReferenceRevision: null,
      error: null,
      notice: null,
    });
  }
  setDraft(content: ProjectAssetContent) {
    if (!this.canEdit || !this.#snapshot.draft) return;
    this.#publish({
      draft: { ...this.#snapshot.draft, content: { ...content } },
      dirty: true,
      notice: null,
    });
  }
  setScript(artifactId: string | null) {
    if (!this.canEdit || !this.#snapshot.draft) return;
    const source =
      artifactId === null
        ? null
        : this.#snapshot.scripts.find((item) => item.artifactId === artifactId);
    if (source === undefined) return;
    this.#publish({
      draft: { ...this.#snapshot.draft, script: source },
      dirty: true,
    });
  }
  useCurrentBrief() {
    if (!this.canEdit || !this.#snapshot.draft || !this.#project) return;
    this.#publish({
      draft: {
        ...this.#snapshot.draft,
        briefRevision: this.#project.brief.briefRevision,
      },
      dirty: true,
    });
  }
  async open(assetId: string, contentRevision?: number) {
    if (!this.canRead || !this.#project) return;
    const projectId = this.#project.project.projectId,
      epoch = this.#epoch,
      request = this.#beginRead();
    this.#publish({ opening: true, error: null, notice: null });
    try {
      await this.#readAsset(
        assetId,
        true,
        request,
        epoch,
        projectId,
        contentRevision,
      );
    } catch {
      if (this.#current(epoch, projectId, request))
        this.#publish({ error: "资产版本暂时无法读取，请重新读取。" });
    } finally {
      if (this.#read === request) this.#read = null;
      if (this.#current(epoch, projectId, request))
        this.#publish({ opening: false });
    }
  }
  async #readAsset(
    assetId: string,
    replaceDraft: boolean,
    request: AbortController,
    epoch: number,
    projectId: string,
    revision?: number,
  ) {
    const read = await readAssetVersion({
      client: this.#client,
      projectId,
      assetId,
      revision: replaceDraft ? (revision ?? "latest") : null,
      signal: request.signal,
      isCurrent: () => this.#current(epoch, projectId, request),
    });
    if (!read || !this.#current(epoch, projectId, request)) return;
    const { view, content } = read;
    this.#publish({
      view: assetViewWithoutRegression(
        this.#snapshot.view,
        this.#snapshot.assets,
        view,
      ),
      assets: mergeAssetHeads(this.#snapshot.assets, [view.asset]),
      ...(replaceDraft && content
        ? {
            content,
            draft: assetDraftFromRevision(content),
            dirty: false,
            history: [],
            references: [],
            nextContentRevision: null,
            nextReferenceRevision: null,
          }
        : {}),
    });
  }
  async loadHistory({ more = false }: { more?: boolean } = {}) {
    if (!this.canRead || !this.#project || !this.#snapshot.view) return;
    const projectId = this.#project.project.projectId,
      assetId = this.#snapshot.view.asset.assetId,
      epoch = this.#epoch,
      request = this.#beginRead();
    this.#publish({ opening: true, error: null });
    try {
      const [content, references] = await Promise.all([
        more && this.#snapshot.nextContentRevision === null
          ? Promise.resolve({ revisions: [], nextContentRevision: null })
          : this.#client.listRevisions(
              {
                projectId,
                assetId,
                afterContentRevision: more
                  ? (this.#snapshot.nextContentRevision ?? 0)
                  : 0,
                limit: 4,
              },
              { signal: request.signal },
            ),
        more && this.#snapshot.nextReferenceRevision === null
          ? Promise.resolve({ references: [], nextReferenceRevision: null })
          : this.#client.listReferences(
              {
                projectId,
                assetId,
                afterReferenceRevision: more
                  ? (this.#snapshot.nextReferenceRevision ?? 0)
                  : 0,
                limit: 4,
              },
              { signal: request.signal },
            ),
      ]);
      if (!this.#current(epoch, projectId, request)) return;
      const revisions = new Map(
        (more ? this.#snapshot.history : []).map((item) => [
          item.contentRevision,
          item,
        ]),
      );
      const refs = new Map(
        (more ? this.#snapshot.references : []).map((item) => [
          item.referenceRevision,
          item,
        ]),
      );
      for (const item of content.revisions)
        revisions.set(item.contentRevision, item);
      for (const item of references.references)
        refs.set(item.referenceRevision, item);
      this.#publish({
        history: [...revisions.values()],
        references: [...refs.values()],
        nextContentRevision: content.nextContentRevision,
        nextReferenceRevision: references.nextReferenceRevision,
      });
    } catch {
      if (this.#current(epoch, projectId, request))
        this.#publish({ error: "历史版本暂时无法读取。" });
    } finally {
      if (this.#read === request) this.#read = null;
      if (this.#current(epoch, projectId, request))
        this.#publish({ opening: false });
    }
  }
  async save() {
    if (!this.canSave || !this.#project || !this.#snapshot.draft) return;
    const draft = this.#snapshot.draft,
      asset = this.#snapshot.view?.asset;
    await this.#start({
      action: "crewon.project-assets.v2.saveCandidate",
      input: {
        projectId: this.#project.project.projectId,
        assetId: asset?.assetId ?? null,
        idempotencyKey: crypto.randomUUID(),
        request: {
          kind: draft.kind,
          expectedAssetRevision: asset?.revision ?? 0,
          briefRevision: draft.briefRevision,
          script: draft.script
            ? {
                artifactId: draft.script.artifactId,
                contentRevision: draft.script.contentRevision,
              }
            : null,
          content: { ...draft.content },
        },
      },
    });
  }
  async selectContent() {
    if (
      !this.canEdit ||
      !this.#project ||
      !this.#snapshot.view ||
      !this.#snapshot.content ||
      this.#snapshot.dirty ||
      this.#snapshot.view.asset.locked
    )
      return;
    await this.#start({
      action: "crewon.project-assets.v2.selectRevision",
      input: {
        projectId: this.#project.project.projectId,
        assetId: this.#snapshot.view.asset.assetId,
        idempotencyKey: crypto.randomUUID(),
        request: {
          expectedAssetRevision: this.#snapshot.view.asset.revision,
          contentRevision: this.#snapshot.content.contentRevision,
        },
      },
    });
  }
  async setLocked() {
    if (!this.canEdit || !this.#project || !this.#snapshot.view) return;
    await this.#start({
      action: "crewon.project-assets.v2.setLocked",
      input: {
        projectId: this.#project.project.projectId,
        assetId: this.#snapshot.view.asset.assetId,
        idempotencyKey: crypto.randomUUID(),
        request: {
          expectedAssetRevision: this.#snapshot.view.asset.revision,
          locked: !this.#snapshot.view.asset.locked,
        },
      },
    });
  }
  async attachReference(source: {
    conceptAssetId: string;
    selectionRevision: number;
  }) {
    if (
      !this.canEdit ||
      !this.#project ||
      !this.#snapshot.view?.selectedContentRevision ||
      this.#snapshot.dirty
    )
      return;
    await this.#start({
      action: "crewon.project-assets.v2.saveReferenceCandidate",
      input: {
        projectId: this.#project.project.projectId,
        assetId: this.#snapshot.view.asset.assetId,
        idempotencyKey: crypto.randomUUID(),
        request: {
          expectedAssetRevision: this.#snapshot.view.asset.revision,
          assetContentRevision:
            this.#snapshot.view.selectedContentRevision.contentRevision,
          ...source,
        },
      },
    });
  }
  async selectReference(referenceRevision: number) {
    if (
      !this.canEdit ||
      !this.#project ||
      !this.#snapshot.view ||
      this.#snapshot.view.asset.locked
    )
      return;
    await this.#start({
      action: "crewon.project-assets.v2.selectReference",
      input: {
        projectId: this.#project.project.projectId,
        assetId: this.#snapshot.view.asset.assetId,
        idempotencyKey: crypto.randomUUID(),
        request: {
          expectedAssetRevision: this.#snapshot.view.asset.revision,
          referenceRevision,
        },
      },
    });
  }
  canAdoptMediaReference(candidate: ProjectMediaResultSummary) {
    return (
      this.canEdit &&
      !this.#snapshot.dirty &&
      mediaReferenceTarget(
        this.#snapshot.view,
        candidate,
        this.#snapshot.projectId,
      ) !== null
    );
  }
  async reviewMediaReference(candidate: ProjectMediaResultSummary) {
    if (
      this.#disposed ||
      this.#snapshot.dirty ||
      this.#snapshot.pending ||
      this.#snapshot.saving ||
      this.#snapshot.opening ||
      candidate.projectId !== this.#project?.project.projectId ||
      candidate.workflowId !== "krea2-reference-four-view" ||
      candidate.item.kind !== "character-reference"
    )
      return;
    this.activate();
    const epoch = this.#epoch;
    await this.refresh();
    if (
      epoch !== this.#epoch ||
      candidate.projectId !== this.#project?.project.projectId
    )
      return;
    await this.open(candidate.item.assetId);
  }
  async adoptMediaReference(candidate: ProjectMediaResultSummary) {
    const target = mediaReferenceTarget(
      this.#snapshot.view,
      candidate,
      this.#snapshot.projectId,
    );
    if (!target || !this.canAdoptMediaReference(candidate)) return;
    await this.#start({
      action: "crewon.project-assets.v2.adoptMediaReference",
      input: { ...target, idempotencyKey: crypto.randomUUID() },
    });
  }
  async cancelPendingRecovery() {
    const record = this.recovery.getSnapshot().intent;
    if (
      !record ||
      record.phase !== "pending" ||
      this.#snapshot.saving ||
      this.#snapshot.opening ||
      this.#snapshot.presentedRecovery !==
        `${record.intentId}:${record.revision}`
    )
      return;
    await this.recovery.cancelPending();
    await this.restoreRecovery();
  }
  async #start(intent: AssetIntent) {
    if (!this.canEdit) return;
    this.#publish({ pending: structuredClone(intent) });
    await this.#execute(intent);
  }
  async retry() {
    const intent = this.#snapshot.pending;
    if (
      !intent ||
      !this.#ready ||
      this.#disposed ||
      this.#snapshot.saving ||
      this.#physicalWritesPending() ||
      intent.input.projectId !== this.#project?.project.projectId ||
      this.recovery.getSnapshot().phase !== "ready" ||
      this.recovery.getSnapshot().cancelling ||
      (this.recovery.getSnapshot().intent !== null &&
        this.recovery.getSnapshot().intent?.phase !== "pending")
    )
      return;
    await this.#execute(intent);
  }
  async #execute(intent: AssetIntent) {
    this.#read?.abort();
    this.#read = null;
    const request = new AbortController(),
      epoch = this.#epoch,
      projectId = intent.input.projectId;
    this.#write = request;
    this.#publish({ saving: true, error: null, notice: null });
    const isCurrent = () => this.#current(epoch, projectId, request);
    try {
      await executeWarmAssetMutation({
        intent,
        client: this.#client,
        recovery: this.recovery,
        signal: request.signal,
        isCurrent,
        snapshot: this.getSnapshot,
        publish: (patch) => {
          if (isCurrent()) this.#publish(patch);
        },
        confirmed: (receipt) => {
          this.#warmReceipt = receipt;
          this.#warmAckReceipt = null;
        },
        acknowledged: (receipt) => {
          this.#warmAckReceipt = receipt;
        },
      });
    } finally {
      if (this.#write === request) this.#write = null;
      if (isCurrent()) this.#publish({ saving: false });
    }
  }
  /** Restore exact journal input for review. Only an explicit retry executes a pending request. */
  async restoreRecovery() {
    const record = this.recovery.getSnapshot().intent;
    if (
      !record ||
      !this.#ready ||
      this.#disposed ||
      this.#snapshot.saving ||
      this.#physicalWritesPending() ||
      record.request.input.projectId !== this.#project?.project.projectId
    )
      return;
    const projectId = record.request.input.projectId,
      epoch = this.#epoch,
      request = this.#beginRead();
    this.#publish({ opening: true, error: null, presentedRecovery: null });
    try {
      await reviewAssetRecovery({
        record,
        client: this.#client,
        texts: this.#texts,
        signal: request.signal,
        isCurrent: () => this.#current(epoch, projectId, request),
        readAsset: (assetId, revision) =>
          this.#readAsset(assetId, true, request, epoch, projectId, revision),
        publish: (patch) => {
          if (this.#current(epoch, projectId, request)) this.#publish(patch);
        },
      });
    } catch {
      if (this.#current(epoch, projectId, request))
        this.#publish({
          error: "原保存记录的来源暂时无法恢复，请重新读取，尚未重复执行。",
        });
    } finally {
      if (this.#read === request) this.#read = null;
      if (this.#current(epoch, projectId, request))
        this.#publish({ opening: false });
    }
  }
  async acknowledgeRecovery() {
    const record = this.recovery.getSnapshot().intent;
    if (
      !record ||
      record.phase === "pending" ||
      this.#snapshot.presentedRecovery !==
        `${record.intentId}:${record.revision}` ||
      this.#snapshot.opening ||
      this.#snapshot.saving
    )
      return;
    if (this.#warmReceipt) {
      try {
        assertAssetWarmRecord(this.#warmReceipt, record);
      } catch {
        return;
      }
    }
    const epoch = this.#epoch,
      projectId = record.request.input.projectId,
      request = this.#beginRead();
    if (
      await this.recovery.acknowledge(record, {
        signal: request.signal,
        isCurrent: () => this.#current(epoch, projectId, request),
        onAcknowledged: () => {
          this.#warmAckReceipt = this.#warmReceipt;
        },
      })
    )
      this.#warmReceipt = null;
    if (this.#read === request) this.#read = null;
    this.#publish({});
  }
  dispose() {
    if (this.#disposed) return;
    this.#invalidate();
    this.recovery.dispose();
    this.#disposed = true;
    this.#listeners.clear();
  }
}
