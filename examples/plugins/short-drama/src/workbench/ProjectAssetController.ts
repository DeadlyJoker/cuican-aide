import type {
  PluginProjectAssetUiClient,
  ProjectAssetContent,
  ProjectAssetKind,
} from "../project-assets-service";
import { parsePublicProjectAssetContent } from "../project-assets-codec.mjs";
import type { PluginProjectTextUiClient } from "../project-texts-ui-service";
import type { ProjectDetails } from "./creative-project-controller";
import {
  initialAssetSnapshot,
  type AssetSnapshot,
  type AssetDraft,
  type AssetIntent,
  type AssetScriptSource,
} from "./ProjectAssetController.types";
import { ProjectAssetRecoveryController } from "./ProjectAssetRecoveryController";
import { dispatchAssetMutation } from "./ProjectAssetMutationDispatch";
import type { PluginProjectAssetRecoveryClient } from "../project-asset-recovery-service";
import {
  assetDraftFromRevision,
  readAssetDraftScript,
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
    this.recovery.subscribe(() => this.#publish({}));
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
      this.#project?.project.state === "active" &&
      this.recovery.permitsNewWrite
    );
  }
  get canSave() {
    if (!this.canEdit || !this.#snapshot.draft || !this.#snapshot.dirty)
      return false;
    try {
      parsePublicProjectAssetContent(this.#snapshot.draft.content);
      return true;
    } catch {
      return false;
    }
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
      const assets = new Map(
        (more ? this.#snapshot.assets : []).map((asset) => [
          asset.assetId,
          asset,
        ]),
      );
      for (const asset of page.assets) assets.set(asset.assetId, asset);
      this.#publish({
        phase: "ready",
        assets: [...assets.values()],
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
    const { view } = await this.#client.getAsset(
      { projectId, assetId },
      { signal: request.signal },
    );
    if (!this.#current(epoch, projectId, request)) return;
    if (!view) throw new Error("project_asset_missing");
    let content = this.#snapshot.content;
    if (replaceDraft) {
      const result = await this.#client.getRevision(
        {
          projectId,
          assetId,
          contentRevision: revision ?? view.asset.latestContentRevision,
        },
        { signal: request.signal },
      );
      if (!this.#current(epoch, projectId, request)) return;
      content = result.contentRevision;
    }
    const assets = new Map(
      this.#snapshot.assets.map((asset) => [asset.assetId, asset]),
    );
    assets.set(view.asset.assetId, view.asset);
    this.#publish({
      view,
      assets: [...assets.values()],
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
      action: "crewon.project-assets.v1.saveCandidate",
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
      action: "crewon.project-assets.v1.selectRevision",
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
      action: "crewon.project-assets.v1.setLocked",
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
      action: "crewon.project-assets.v1.saveReferenceCandidate",
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
      action: "crewon.project-assets.v1.selectReference",
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
    try {
      const result = await dispatchAssetMutation(
        this.#client,
        intent,
        request.signal,
      );
      if (!this.#current(epoch, projectId, request)) return;
      const assets = new Map(
        this.#snapshot.assets.map((asset) => [asset.assetId, asset]),
      );
      assets.set(result.asset.assetId, result.asset);
      this.#publish({
        pending: null,
        saving: false,
        assets: [...assets.values()],
        notice: "资产版本已保存。",
        ...(intent.action === "crewon.project-assets.v1.saveCandidate" &&
        result.contentRevision
          ? {
              content: result.contentRevision,
              draft: assetDraftFromRevision(result.contentRevision),
              dirty: false,
            }
          : {}),
      });
      try {
        await this.#readAsset(
          result.asset.assetId,
          false,
          request,
          epoch,
          projectId,
        );
      } catch {
        if (this.#current(epoch, projectId, request))
          this.#publish({
            error: "保存已确认，当前选用暂时无法读取，请刷新。",
          });
      }
    } catch {
      if (this.#current(epoch, projectId, request))
        this.#publish({
          saving: false,
          error: "尚未确认保存结果。重试会使用同一项目、版本和原请求。",
        });
    } finally {
      if (this.#write === request) this.#write = null;
      if (this.#current(epoch, projectId, request))
        this.#publish({ saving: false });
      if (this.#current(epoch, projectId, request)) await this.recovery.check();
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
      const original = record.request;
      const assetId =
        record.phase === "accepted"
          ? record.confirmed.assetId
          : original.input.assetId;
      if (assetId !== null)
        await this.#readAsset(
          assetId,
          true,
          request,
          epoch,
          projectId,
          record.phase === "accepted"
            ? (record.confirmed.contentRevision ?? undefined)
            : undefined,
        );
      if (!this.#current(epoch, projectId, request)) return;
      if (original.action === "crewon.project-assets.v1.saveCandidate") {
        const script = await readAssetDraftScript({
          texts: this.#texts,
          projectId,
          source: original.input.request.script,
          signal: request.signal,
        });
        if (!this.#current(epoch, projectId, request)) return;
        this.#publish({
          draft: {
            kind: original.input.request.kind,
            briefRevision: original.input.request.briefRevision,
            script,
            content: { ...original.input.request.content },
          },
          dirty: record.phase === "refused",
          ...(assetId === null
            ? { view: null, content: null, history: [], references: [] }
            : {}),
        });
      }
      if (
        record.phase === "accepted" &&
        record.confirmed.referenceRevision !== null
      ) {
        const result = await this.#client.getReferenceRevision(
          {
            projectId,
            assetId: record.confirmed.assetId,
            referenceRevision: record.confirmed.referenceRevision,
          },
          { signal: request.signal },
        );
        if (!this.#current(epoch, projectId, request)) return;
        this.#publish({ references: [result.referenceRevision] });
      }
      this.#publish({
        phase: "ready",
        pending: record.phase === "pending" ? structuredClone(original) : null,
        presentedRecovery: `${record.intentId}:${record.revision}`,
        notice:
          record.phase === "accepted"
            ? "已找回原保存结果；这是历史回执，当前选用以重新读取的状态为准。"
            : record.phase === "refused"
              ? "原请求已明确拒绝，草稿保留。核对后可按当前版本继续编辑。"
              : "已找回原请求，请核对后用原请求重试。",
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
    await this.recovery.acknowledge(record);
  }
  dispose() {
    if (this.#disposed) return;
    this.#invalidate();
    this.recovery.dispose();
    this.#disposed = true;
    this.#listeners.clear();
  }
}
