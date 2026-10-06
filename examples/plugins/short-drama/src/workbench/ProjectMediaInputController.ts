import type {
  PluginMediaInputUiClient,
  MediaInputWorkflowId,
  MediaInputRole,
  SaveMediaInputRequest,
  PublicMediaInput,
  MediaInputSummary,
  MediaInputOptionsResponse,
} from "../project-media-inputs-ui-client";
import { projectMediaInputsUiCodec } from "../project-media-inputs-ui-codec.mjs";
import type { PluginProjectAssetUiClient } from "../project-assets-service";
import type { PluginProjectTextUiClient } from "../project-texts-ui-service";
import type { ProjectDetails } from "./creative-project-controller";
import {
  readMediaInputSources,
  type MediaAssetChoice,
  type MediaScriptChoice,
} from "./ProjectMediaInputSources";

export type MediaInputDraft = Readonly<{
  workflowId: MediaInputWorkflowId;
  prompt: string;
  briefRevision: number;
  configurationRevision: number | null;
  characters: Readonly<Partial<Record<MediaInputRole, string>>>;
  references: SaveMediaInputRequest["references"];
  scriptId: string;
  script: SaveMediaInputRequest["script"];
}>;
type Snapshot = Readonly<{
  phase: "waiting" | "loading" | "ready" | "unavailable";
  inputs: readonly MediaInputSummary[];
  nextMediaInputId: string | null;
  assets: readonly MediaAssetChoice[];
  scripts: readonly MediaScriptChoice[];
  nextAssetId: string | null;
  nextArtifactId: string | null;
  configuration: MediaInputOptionsResponse["configuration"];
  draft: MediaInputDraft | null;
  input: PublicMediaInput | null;
  latestInputRevision: number;
  saving: boolean;
  reading: boolean;
  pending: SaveMediaInputRequest | null;
  dirty: boolean;
  error: string | null;
  notice: string | null;
}>;
const initial = (): Snapshot => ({
  phase: "waiting",
  inputs: [],
  nextMediaInputId: null,
  assets: [],
  scripts: [],
  nextAssetId: null,
  nextArtifactId: null,
  configuration: null,
  draft: null,
  input: null,
  latestInputRevision: 0,
  saving: false,
  reading: false,
  pending: null,
  dirty: false,
  error: null,
  notice: null,
});
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Logical input confirmation only. Activation, navigation and reconnect never create an input or Run. */
export class ProjectMediaInputController {
  readonly #client: PluginMediaInputUiClient;
  readonly #assets: Pick<PluginProjectAssetUiClient, "listAssets" | "getAsset">;
  readonly #texts: Pick<
    PluginProjectTextUiClient,
    "listArtifacts" | "getArtifact"
  >;
  readonly #physicalWritesPending: () => boolean;
  readonly #listeners = new Set<() => void>();
  #snapshot = initial();
  #project: ProjectDetails | null = null;
  #ready = false;
  #activated = false;
  #disposed = false;
  #epoch = 0;
  #read: AbortController | null = null;
  #write: AbortController | null = null;
  constructor(input: {
    client: PluginMediaInputUiClient;
    assets: Pick<PluginProjectAssetUiClient, "listAssets" | "getAsset">;
    texts: Pick<PluginProjectTextUiClient, "listArtifacts" | "getArtifact">;
    physicalWritesPending(): boolean;
  }) {
    this.#client = input.client;
    this.#assets = input.assets;
    this.#texts = input.texts;
    this.#physicalWritesPending = input.physicalWritesPending;
  }
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly getSnapshot = () => this.#snapshot;
  get locked() {
    return this.#snapshot.saving || this.#snapshot.pending !== null;
  }
  get canRead() {
    return (
      this.#ready &&
      !this.#disposed &&
      this.#project !== null &&
      !this.locked &&
      !this.#snapshot.reading &&
      !this.#physicalWritesPending()
    );
  }
  get canEdit() {
    return (
      this.canRead &&
      this.#snapshot.phase === "ready" &&
      this.#project?.project.state === "active"
    );
  }
  get canSave() {
    return (
      this.canEdit &&
      this.#snapshot.dirty &&
      this.#command("validation") !== null
    );
  }
  get stale() {
    const d = this.#snapshot.draft;
    return (
      d !== null &&
      (d.briefRevision !== this.#project?.brief.briefRevision ||
        d.configurationRevision !== this.#snapshot.configuration?.revision)
    );
  }
  activate() {
    if (this.#activated || this.#disposed) return;
    this.#activated = true;
    if (this.#ready && this.#project) void this.refresh();
  }
  setReady(ready: boolean) {
    if (this.#disposed || ready === this.#ready) return;
    this.#ready = ready;
    this.#invalidate();
    this.#publish({
      phase: ready ? "loading" : "waiting",
      reading: false,
      saving: false,
    });
    if (ready && this.#activated && this.#project) void this.refresh();
  }
  setProject(project: ProjectDetails | null) {
    if (
      this.#disposed ||
      (this.locked &&
        project?.project.projectId !== this.#project?.project.projectId)
    )
      return;
    if (
      project &&
      this.#project &&
      project.project.projectId === this.#project.project.projectId &&
      project.project.revision < this.#project.project.revision
    )
      return;
    const changed =
      project?.project.projectId !== this.#project?.project.projectId;
    const revisionChanged =
      project?.project.revision !== this.#project?.project.revision;
    this.#project = project;
    if (!changed && !revisionChanged) return;
    this.#invalidate();
    if (changed) this.#snapshot = initial();
    this.#publish({ reading: false, saving: false });
    if (this.#ready && this.#activated && project) void this.refresh();
  }
  refreshWriteActivity() {
    this.#publish({});
  }
  #publish(patch: Partial<Snapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const f of this.#listeners) f();
  }
  #invalidate() {
    this.#epoch++;
    this.#read?.abort();
    this.#write?.abort();
    this.#read = null;
    this.#write = null;
  }
  #current(epoch: number, request: AbortController) {
    return (
      !this.#disposed &&
      this.#ready &&
      epoch === this.#epoch &&
      !request.signal.aborted
    );
  }
  async refresh({
    moreInputs = false,
    moreSources = false,
  }: { moreInputs?: boolean; moreSources?: boolean } = {}) {
    if (
      !this.#project ||
      !this.#ready ||
      !this.#activated ||
      this.#disposed ||
      this.locked
    )
      return;
    const project = this.#project,
      epoch = this.#epoch,
      request = new AbortController();
    this.#read?.abort();
    this.#read = request;
    this.#publish({ phase: "loading", reading: true, error: null });
    try {
      const options = { signal: request.signal };
      const [page, configuration, sources, currentInput] = await Promise.all([
        this.#client.listInputs(
          {
            projectId: project.project.projectId,
            afterMediaInputId: moreInputs
              ? this.#snapshot.nextMediaInputId
              : null,
            limit: 8,
          },
          options,
        ),
        this.#client.getOptions(
          { projectId: project.project.projectId },
          options,
        ),
        readMediaInputSources({
          projectId: project.project.projectId,
          briefRevision: project.brief.briefRevision,
          afterAssetId: moreSources ? this.#snapshot.nextAssetId : null,
          afterArtifactId: moreSources ? this.#snapshot.nextArtifactId : null,
          assets: this.#assets,
          texts: this.#texts,
          signal: request.signal,
        }),
        this.#snapshot.input
          ? this.#client.loadInput(
              {
                projectId: project.project.projectId,
                mediaInputId: this.#snapshot.input.mediaInputId,
                inputRevision: null,
              },
              options,
            )
          : Promise.resolve(null),
      ]);
      if (!this.#current(epoch, request)) return;
      this.#publish({
        phase: "ready",
        reading: false,
        inputs: merge(
          moreInputs ? this.#snapshot.inputs : [],
          page.inputs,
          (x) => x.mediaInputId,
        ),
        nextMediaInputId: page.nextMediaInputId,
        configuration: configuration.configuration,
        assets: merge(
          moreSources ? this.#snapshot.assets : [],
          sources.assets,
          (x) => x.reference.assetId,
        ),
        scripts: merge(
          moreSources ? this.#snapshot.scripts : [],
          sources.scripts,
          (x) => x.artifactId,
        ),
        nextAssetId: sources.nextAssetId,
        nextArtifactId: sources.nextArtifactId,
        ...(currentInput?.state
          ? { latestInputRevision: currentInput.state.latestInputRevision }
          : {}),
      });
    } catch {
      if (this.#current(epoch, request))
        this.#publish({
          phase: "unavailable",
          reading: false,
          error: "确认输入或已采用素材暂不可用，请重新连接。",
        });
    } finally {
      if (this.#read === request) this.#read = null;
    }
  }
  newInput(workflowId: MediaInputWorkflowId) {
    if (!this.canEdit || !this.#project) return;
    this.#publish({
      input: null,
      latestInputRevision: 0,
      dirty: true,
      notice: null,
      error: null,
      draft: {
        workflowId,
        prompt: "",
        briefRevision: this.#project.brief.briefRevision,
        configurationRevision: this.#snapshot.configuration?.revision ?? null,
        characters: {},
        references: {},
        scriptId: "",
        script: null,
      },
    });
  }
  setPrompt(prompt: string) {
    if (this.canEdit && this.#snapshot.draft)
      this.#publish({
        draft: { ...this.#snapshot.draft, prompt },
        dirty: true,
        notice: null,
      });
  }
  chooseReference(role: MediaInputRole, assetId: string) {
    const draft = this.#snapshot.draft;
    if (!this.canEdit || !draft) return;
    const choice = this.#snapshot.assets.find(
      (x) => x.reference.assetId === assetId,
    );
    const references = { ...draft.references };
    if (choice) references[role] = choice.reference;
    else delete references[role];
    this.#publish({
      draft: {
        ...draft,
        characters: { ...draft.characters, [role]: assetId },
        references,
      },
      dirty: true,
      notice: null,
    });
  }
  chooseScript(scriptId: string) {
    const draft = this.#snapshot.draft,
      choice = this.#snapshot.scripts.find((x) => x.artifactId === scriptId);
    if (this.canEdit && draft)
      this.#publish({
        draft: {
          ...draft,
          scriptId,
          script: choice
            ? {
                artifactId: choice.artifactId,
                contentRevision: choice.contentRevision,
              }
            : null,
        },
        dirty: true,
        notice: null,
      });
  }
  useCurrentSources() {
    const draft = this.#snapshot.draft;
    if (!this.canEdit || !draft || !this.#project) return;
    const references = Object.fromEntries(
      Object.entries(draft.characters).flatMap(([role, id]) => {
        const choice = this.#snapshot.assets.find(
          (x) => x.reference.assetId === id,
        );
        return choice ? [[role, choice.reference]] : [];
      }),
    );
    const script = this.#snapshot.scripts.find(
      (x) => x.artifactId === draft.scriptId,
    );
    this.#publish({
      draft: {
        ...draft,
        briefRevision: this.#project.brief.briefRevision,
        configurationRevision: this.#snapshot.configuration?.revision ?? null,
        references,
        script: script
          ? {
              artifactId: script.artifactId,
              contentRevision: script.contentRevision,
            }
          : null,
      },
      dirty: true,
      notice: "已切换到当前需求、配置和采用版本，请核对后保存。",
    });
  }
  async open(mediaInputId: string, inputRevision: number | null = null) {
    if (!this.canRead || !this.#project) return;
    const epoch = this.#epoch,
      request = new AbortController();
    this.#read?.abort();
    this.#read = request;
    this.#publish({ reading: true, error: null, notice: null });
    try {
      const { state } = await this.#client.loadInput(
        {
          projectId: this.#project.project.projectId,
          mediaInputId,
          inputRevision,
        },
        { signal: request.signal },
      );
      if (!this.#current(epoch, request)) return;
      if (!state) {
        this.#publish({ reading: false, error: "该输入版本不存在。" });
        return;
      }
      const r = state.input;
      this.#publish({
        reading: false,
        input: r,
        latestInputRevision: state.latestInputRevision,
        dirty: false,
        draft: {
          workflowId: r.workflowId,
          prompt: r.prompt,
          briefRevision: r.briefRevision,
          configurationRevision: r.configurationRevision,
          characters: Object.fromEntries(
            Object.entries(r.references).map(([role, ref]) => [
              role,
              ref!.assetId,
            ]),
          ),
          references: r.references,
          scriptId: r.script?.artifactId ?? "",
          script: r.script,
        },
      });
    } catch {
      if (this.#current(epoch, request))
        this.#publish({
          reading: false,
          error: "输入暂时无法读取，请重新读取原版本。",
        });
    } finally {
      if (this.#read === request) this.#read = null;
    }
  }
  #command(key: string): SaveMediaInputRequest | null {
    const d = this.#snapshot.draft,
      p = this.#project,
      c = this.#snapshot.configuration;
    if (!d || !p || !c || this.stale || !c.workflows.includes(d.workflowId))
      return null;
    if (
      !d.prompt.trim() ||
      new TextEncoder().encode(d.prompt).byteLength > 8192 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(
        d.prompt,
      )
    )
      return null;
    const roles: MediaInputRole[] =
      d.workflowId === "krea2-reference-four-view"
        ? ["character"]
        : ["scene", "characterOne", "characterTwo"];
    const references: SaveMediaInputRequest["references"] = {};
    const entries = [];
    for (const role of roles) {
      const choice = this.#snapshot.assets.find(
        (x) =>
          x.reference.assetId === d.characters[role] &&
          x.reference.kind === (role === "scene" ? "scene" : "character"),
      );
      if (!choice || !same(choice.reference, d.references[role])) return null;
      entries.push([role, d.references[role]!]);
    }
    if (
      new Set(
        entries.map(([, r]) => (r as MediaAssetChoice["reference"]).assetId),
      ).size !== roles.length
    )
      return null;
    Object.assign(references, Object.fromEntries(entries));
    const script = d.scriptId
      ? this.#snapshot.scripts.find((x) => x.artifactId === d.scriptId)
      : null;
    if (
      (d.workflowId === "flux2-three-reference-storyboard" && !script) ||
      (d.scriptId &&
        (!script ||
          !same(d.script, {
            artifactId: script.artifactId,
            contentRevision: script.contentRevision,
          })))
    )
      return null;
    // An existing confirmed input keeps exact references until the user explicitly chooses a current version.
    const previous = this.#snapshot.input;
    if (previous && !this.#snapshot.dirty) return null;
    const command: SaveMediaInputRequest = {
      projectId: p.project.projectId,
      mediaInputId: previous?.mediaInputId ?? null,
      expectedInputRevision: previous ? this.#snapshot.latestInputRevision : 0,
      item:
        d.workflowId === "krea2-reference-four-view"
          ? { kind: "character-reference", assetId: d.characters.character! }
          : {
              kind: "storyboard-frame-exploration",
              episodeId: script!.episodeId,
            },
      briefRevision: d.briefRevision,
      script: script
        ? {
            artifactId: script.artifactId,
            contentRevision: script.contentRevision,
          }
        : null,
      workflowId: d.workflowId,
      configurationRevision: c.revision,
      prompt: d.prompt,
      references,
      idempotencyKey: key,
    };
    try {
      const parsed = projectMediaInputsUiCodec.parseRequest({
        action: "crewon.project-media-inputs.v1.saveInput",
        input: command,
      });
      return parsed.action === "crewon.project-media-inputs.v1.saveInput"
        ? parsed.input
        : null;
    } catch {
      return null;
    }
  }
  async save() {
    if (!this.canSave) return;
    const command = this.#command(crypto.randomUUID());
    if (command) {
      this.#publish({ pending: command });
      await this.#submit(command);
    }
  }
  async retry() {
    const command = this.#snapshot.pending;
    if (
      command &&
      this.#ready &&
      !this.#disposed &&
      !this.#snapshot.saving &&
      !this.#physicalWritesPending()
    )
      await this.#submit(command);
  }
  async #submit(command: SaveMediaInputRequest) {
    const epoch = this.#epoch,
      request = new AbortController();
    this.#write = request;
    this.#publish({ saving: true, error: null, notice: null });
    try {
      const result = await this.#client.saveInput(command, {
        signal: request.signal,
      });
      if (!this.#current(epoch, request)) return;
      const r = result.input;
      this.#publish({
        phase: "ready",
        saving: false,
        pending: null,
        input: r,
        latestInputRevision: r.inputRevision,
        dirty: false,
        notice: `确认输入 v${r.inputRevision} 已保存`,
        draft: { ...this.#snapshot.draft!, prompt: r.prompt },
        inputs: merge(
          this.#snapshot.inputs,
          [
            {
              projectId: r.projectId,
              mediaInputId: r.mediaInputId,
              latestInputRevision: r.inputRevision,
              item: r.item,
              workflowId: r.workflowId,
              createdAt: r.createdAt,
            },
          ],
          (x) => x.mediaInputId,
        ),
      });
      void this.refresh();
    } catch (error) {
      if (!this.#current(epoch, request)) return;
      const code = error instanceof Error ? error.message : "";
      const refused =
        /^project_media_input_(revision_conflict|idempotency_conflict|brief_stale|target_changed|item_changed|source_changed|script_episode_mismatch|workflow_unreviewed|project_archived)$/u.test(
          code,
        );
      this.#publish({
        saving: false,
        ...(refused ? { pending: null } : {}),
        error: refused
          ? "来源或输入版本已变化，请重新读取后确认。"
          : "保存结果尚未确认，请用原请求确认保存。",
      });
    } finally {
      if (this.#write === request) this.#write = null;
    }
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#invalidate();
    this.#listeners.clear();
  }
}
function merge<T>(a: readonly T[], b: readonly T[], key: (value: T) => string) {
  const out = new Map(a.map((x) => [key(x), x]));
  for (const x of b) out.set(key(x), x);
  return [...out.values()];
}
