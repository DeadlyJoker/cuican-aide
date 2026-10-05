import type {
  PluginProjectTextRecoveryClient,
  ProjectTextRecoveryPendingResponse,
} from "../project-text-recovery-service";
import type { TextIntent } from "./ProjectTextController.types";

export type TextRecoveryRecord = NonNullable<
  ProjectTextRecoveryPendingResponse["intent"]
>;
export type TextRecoverySnapshot = Readonly<{
  phase:
    | "disabled"
    | "unchecked"
    | "checking"
    | "ready"
    | "blocked"
    | "unavailable";
  intent: TextRecoveryRecord | null;
  acknowledging: boolean;
  error: string | null;
}>;

export function textRecoveryRequest(
  intent: TextIntent,
): TextRecoveryRecord["request"] {
  switch (intent.kind) {
    case "save-outline":
      return {
        action: "crewon.project-texts.v1.saveOutlineCandidate",
        input: intent.input,
      };
    case "save-script":
      return {
        action: "crewon.project-texts.v1.saveScriptCandidate",
        input: intent.input,
      };
    case "select-revision":
      return {
        action: "crewon.project-texts.v1.selectRevision",
        input: intent.input,
      };
    case "set-lock":
      return {
        action: "crewon.project-texts.v1.setLocked",
        input: intent.input,
      };
  }
}

export function textRecoveryIntent(record: TextRecoveryRecord): TextIntent {
  switch (record.request.action) {
    case "crewon.project-texts.v1.saveOutlineCandidate":
      return { kind: "save-outline", input: record.request.input };
    case "crewon.project-texts.v1.saveScriptCandidate":
      return { kind: "save-script", input: record.request.input };
    case "crewon.project-texts.v1.selectRevision":
      return { kind: "select-revision", input: record.request.input };
    case "crewon.project-texts.v1.setLocked":
      return { kind: "set-lock", input: record.request.input };
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/** Reads a durable original request; a recovery record never grants execution authority. */
export class ProjectTextRecoveryController {
  readonly #client: PluginProjectTextRecoveryClient | undefined;
  readonly #changed: () => void;
  readonly #physicalWritesPending: () => boolean;
  #projectId: string | null = null;
  #ready = false;
  #disposed = false;
  #epoch = 0;
  #read: AbortController | null = null;
  #ack: AbortController | null = null;
  #snapshot: TextRecoverySnapshot;
  constructor(ports: {
    client?: PluginProjectTextRecoveryClient;
    changed(): void;
    physicalWritesPending(): boolean;
  }) {
    this.#client = ports.client;
    this.#changed = ports.changed;
    this.#physicalWritesPending = ports.physicalWritesPending;
    this.#snapshot = this.#initial();
  }
  #initial(): TextRecoverySnapshot {
    return {
      phase: this.#client ? "unchecked" : "disabled",
      intent: null,
      acknowledging: false,
      error: null,
    };
  }
  getSnapshot = (): TextRecoverySnapshot => this.#snapshot;
  get blocksWrites() {
    return Boolean(this.#client) && this.#snapshot.phase !== "ready";
  }
  get navigationLocked() {
    return (
      this.#snapshot.intent !== null ||
      this.#snapshot.phase === "checking" ||
      this.#snapshot.acknowledging
    );
  }
  setProject(projectId: string | null) {
    if (this.#disposed || projectId === this.#projectId) return;
    this.#invalidate();
    this.#projectId = projectId;
    this.#snapshot = this.#initial();
    this.#changed();
  }
  setReady(ready: boolean) {
    if (this.#disposed || ready === this.#ready) return;
    this.#ready = ready;
    if (!ready) {
      this.#invalidate();
      if (this.#client)
        this.#update({
          phase: "unchecked",
          acknowledging: false,
          error: "连接已中断，未完成请求仍保存在项目中。",
        });
    }
  }
  #available() {
    return this.#ready && !this.#disposed && this.#projectId !== null;
  }
  #invalidate() {
    ++this.#epoch;
    this.#read?.abort();
    this.#ack?.abort();
    this.#read = null;
    this.#ack = null;
  }
  #update(update: Partial<TextRecoverySnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...update };
    if (!this.#disposed) this.#changed();
  }
  async check(): Promise<TextRecoveryRecord | null> {
    if (!this.#client || !this.#available() || this.#snapshot.acknowledging)
      return this.#snapshot.intent;
    this.#read?.abort();
    const controller = new AbortController(),
      epoch = this.#epoch,
      projectId = this.#projectId!;
    this.#read = controller;
    const current = () =>
      this.#available() &&
      epoch === this.#epoch &&
      this.#read === controller &&
      !controller.signal.aborted;
    this.#update({ phase: "checking", error: null });
    try {
      const response = await this.#client.getPending(
        { projectId },
        { signal: controller.signal },
      );
      if (!current()) return this.#snapshot.intent;
      this.#update({
        phase: response.intent ? "blocked" : "ready",
        intent: response.intent,
        error: null,
      });
    } catch {
      if (current())
        this.#update({
          phase: "unavailable",
          error: "未完成请求读取失败。重新读取后再保存新内容。",
        });
    }
    return this.#snapshot.intent;
  }
  matches(intent: TextIntent) {
    return (
      this.#snapshot.intent !== null &&
      canonical(this.#snapshot.intent.request) ===
        canonical(textRecoveryRequest(intent))
    );
  }
  beforeWrite() {
    if (this.#client && !this.#snapshot.intent)
      this.#update({ phase: "unchecked" });
  }
  async acknowledge(): Promise<boolean> {
    const record = this.#snapshot.intent;
    if (
      !this.#client ||
      !this.#available() ||
      !record ||
      record.phase === "pending" ||
      this.#snapshot.acknowledging ||
      this.#physicalWritesPending()
    )
      return false;
    const controller = new AbortController(),
      epoch = this.#epoch;
    this.#ack = controller;
    const current = () =>
      this.#available() &&
      epoch === this.#epoch &&
      this.#ack === controller &&
      !controller.signal.aborted;
    this.#update({ acknowledging: true, error: null });
    try {
      await this.#client.acknowledge(
        {
          projectId: this.#projectId!,
          intentId: record.intentId,
          expectedRevision: record.revision,
        },
        { signal: controller.signal },
      );
      if (!current()) return false;
      this.#update({ acknowledging: false, intent: null, phase: "unchecked" });
      await this.check();
      return this.#snapshot.phase === "ready";
    } catch {
      if (current())
        this.#update({
          acknowledging: false,
          error: "内容结果已知；恢复记录确认尚未完成。请重新读取记录。",
        });
      return false;
    }
  }
  async afterConfirmed(intent: TextIntent) {
    if (!this.#client) return;
    await this.check();
    if (this.matches(intent) && this.#snapshot.intent?.phase === "accepted")
      await this.acknowledge();
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    this.#invalidate();
  }
}
