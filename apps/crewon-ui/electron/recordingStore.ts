import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  RECORDING_BUDGETS,
  sealRecordingExport,
  validateRecordingExport,
  type RecordingExport,
  type RecordingStep,
} from "@crewon/contracts/recording";

export type ObservedStep = Omit<
  RecordingStep,
  "stepId" | "sequence" | "occurredAt" | "evidenceIds"
>;
const digest = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` as const;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const terminal = (s: RecordingExport["status"]) =>
  s === "completed" || s === "budget-exceeded";
const validId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value);

/** Local desktop source authority. It never grants a remote tenant or filesystem access. */
export class RecordingStore {
  #selected: RecordingExport | null = null;
  #catalog = new Map<string, RecordingExport>();
  #ownerId = "";
  #queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly now = () => new Date(),
  ) {}
  get current(): RecordingExport | null {
    return this.#selected ? structuredClone(this.#selected) : null;
  }
  list() {
    return [...this.#catalog.values()]
      .map(({ recordingId, status, startedAt }) => ({
        recordingId,
        status,
        startedAt,
      }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const ownerPath = join(this.directory, "owner.json");
    try {
      this.#ownerId = JSON.parse(await readFile(ownerPath, "utf8")).ownerId;
      if (!validId(this.#ownerId)) throw new Error("recording_owner_invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#ownerId = `desktop-${randomUUID()}`;
      await writeFile(ownerPath, JSON.stringify({ ownerId: this.#ownerId }), {
        flag: "wx",
        mode: 0o600,
      });
    }
    const directories = (
      await readdir(this.directory, { withFileTypes: true })
    ).filter((e) => e.isDirectory());
    if (directories.length > 20) throw new Error("recording_catalog_limit");
    for (const entry of directories) {
      if (!validId(entry.name)) throw new Error("recording_directory_invalid");
      const path = join(this.directory, entry.name, "recording.json");
      let value: RecordingExport;
      try {
        if ((await stat(path)).size > RECORDING_BUDGETS.maxTotalBytes)
          throw new Error("recording_bytes_exceeded");
        value = await validateRecordingExport(
          JSON.parse(await readFile(path, "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        value.recordingId !== entry.name ||
        value.scope.ownerId !== this.#ownerId
      )
        throw new Error("recording_scope_mismatch");
      if (value.status === "recording" || value.status === "paused") {
        const { contentDigest: _digest, ...body } = value;
        value = await sealRecordingExport({
          ...body,
          status: "interrupted",
          revision: value.revision + 1,
          updatedAt: this.now().toISOString(),
        });
        await this.#write(value);
      }
      this.#catalog.set(value.recordingId, value);
    }
    const newest = this.list()[0];
    this.#selected = newest ? this.#catalog.get(newest.recordingId)! : null;
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
  #require(): RecordingExport {
    if (!this.#selected) throw new Error("recording_not_started");
    return this.#selected;
  }
  #revision(expected: number) {
    const value = this.#require();
    if (expected !== value.revision)
      throw new Error("recording_revision_conflict");
    return value;
  }
  #expired(value: RecordingExport) {
    return (
      this.now().getTime() - Date.parse(value.startedAt) >=
      RECORDING_BUDGETS.maxDurationMs
    );
  }
  async #write(value: RecordingExport) {
    const dir = join(this.directory, value.recordingId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, "recording.tmp");
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, join(dir, "recording.json"));
  }
  async #save(body: RecordingExport): Promise<RecordingExport> {
    const { contentDigest: _previous, ...rest } = body;
    const value = await sealRecordingExport(rest);
    await this.#write(value);
    this.#catalog.set(value.recordingId, value);
    this.#selected = value;
    return structuredClone(value);
  }
  #change(
    value: RecordingExport,
    patch: Partial<RecordingExport>,
  ): RecordingExport {
    return {
      ...value,
      ...patch,
      revision: value.revision + 1,
      updatedAt: this.now().toISOString(),
    };
  }
  start(origin: string): Promise<RecordingExport> {
    return this.#serial(async () => {
      if (this.#selected && !terminal(this.#selected.status))
        throw new Error("recording_finish_current_first");
      if (this.#catalog.size >= 20) throw new Error("recording_catalog_limit");
      if (new URL(origin).origin !== origin || !/^https?:/.test(origin))
        throw new Error("recording_origin_invalid");
      const at = this.now().toISOString();
      return this.#save({
        schemaVersion: 1,
        recordingId: `rec-${randomUUID()}`,
        revision: 1,
        contentDigest: "sha256:",
        scope: { ownerId: this.#ownerId, workspaceId: null },
        authorization: {
          source: "desktop-user-start",
          authorizedAt: at,
          allowedOrigins: [origin],
        },
        startedAt: at,
        updatedAt: at,
        status: "recording",
        steps: [],
        evidence: [],
        edits: [],
      });
    });
  }
  control(
    command: "pause" | "resume" | "finish",
    expected: number,
    origin?: string,
    recordingId?: string,
  ): Promise<RecordingExport> {
    return this.#serial(async () => {
      const value =
        recordingId === undefined ? this.#revision(expected) : this.#require();
      if (recordingId !== undefined && value.recordingId !== recordingId)
        throw new Error("recording_identity_conflict");
      if (terminal(value.status)) throw new Error("recording_already_finished");
      if (command === "finish")
        return this.#save(this.#change(value, { status: "completed" }));
      if (this.#expired(value))
        return this.#save(this.#change(value, { status: "budget-exceeded" }));
      if (command === "pause") {
        if (value.status !== "recording")
          throw new Error("recording_transition_invalid");
        return this.#save(this.#change(value, { status: "paused" }));
      }
      if (value.status !== "paused" && value.status !== "interrupted")
        throw new Error("recording_transition_invalid");
      if (
        !origin ||
        new URL(origin).origin !== origin ||
        !/^https?:/.test(origin)
      )
        throw new Error("recording_origin_invalid");
      const allowedOrigins = [
        ...new Set([...value.authorization.allowedOrigins, origin]),
      ];
      return this.#save(
        this.#change(value, {
          status: "recording",
          authorization: { ...value.authorization, allowedOrigins },
        }),
      );
    });
  }
  interrupt(): Promise<RecordingExport | null> {
    return this.#serial(async () => {
      const value = this.#selected;
      if (!value || terminal(value.status) || value.status === "interrupted")
        return this.current;
      return this.#save(this.#change(value, { status: "interrupted" }));
    });
  }
  checkBudget(): Promise<RecordingExport | null> {
    return this.#serial(async () => {
      const value = this.#selected;
      if (!value || terminal(value.status) || !this.#expired(value))
        return this.current;
      return this.#save(this.#change(value, { status: "budget-exceeded" }));
    });
  }
  append(event: ObservedStep, svg?: string | Buffer): Promise<RecordingExport> {
    return this.#serial(async () => {
      const value = this.#require();
      if (value.status !== "recording") return structuredClone(value);
      const priorSequence = Math.max(
        0,
        ...value.steps.map((s) => s.sequence),
        ...value.edits.map((e) => Number(e.stepId.split("-").at(-1)) || 0),
      );
      const sequence = priorSequence + 1;
      const stepId = `step-${sequence}`;
      const evidenceId = `evidence-${sequence}`;
      const step: RecordingStep = {
        ...event,
        stepId,
        sequence,
        occurredAt: this.now().toISOString(),
        evidenceIds: svg ? [evidenceId] : [],
      };
      const evidence = svg
        ? {
            evidenceId,
            kind:
              typeof svg === "string"
                ? ("redacted-layout" as const)
                : ("redacted-screenshot" as const),
            mediaType:
              typeof svg === "string"
                ? ("image/svg+xml" as const)
                : ("image/png" as const),
            byteLength: Buffer.byteLength(svg),
            contentDigest: digest(svg),
          }
        : null;
      const next = this.#change(value, {
        steps: [...value.steps, step],
        evidence: evidence ? [...value.evidence, evidence] : value.evidence,
      });
      const evidenceBytes = next.evidence.reduce((n, e) => n + e.byteLength, 0);
      if (
        this.#expired(value) ||
        sequence > RECORDING_BUDGETS.maxSteps ||
        bytes(step) > RECORDING_BUDGETS.maxStepBytes ||
        (evidence &&
          evidence.byteLength > RECORDING_BUDGETS.maxEvidenceBytes) ||
        bytes(next) + evidenceBytes > RECORDING_BUDGETS.maxTotalBytes - 32768
      )
        return this.#save(this.#change(value, { status: "budget-exceeded" }));
      const { contentDigest: _digest, ...body } = next;
      await sealRecordingExport(body);
      const evidencePath = join(
        this.directory,
        value.recordingId,
        `${evidenceId}.bin`,
      );
      if (svg) await writeFile(evidencePath, svg, { mode: 0o600 });
      try {
        return await this.#save(next);
      } catch (error) {
        if (svg) await rm(evidencePath, { force: true });
        throw error;
      }
    });
  }
  updateDownload(
    recordingId: string,
    stepId: string,
    outcome: "completed" | "cancelled" | "unknown",
  ): Promise<RecordingExport | null> {
    return this.#serial(async () => {
      const value = this.#selected;
      if (!value || value.recordingId !== recordingId || terminal(value.status))
        return this.current;
      const index = value.steps.findIndex(
        (s) => s.stepId === stepId && s.kind === "download",
      );
      if (index < 0) return this.current;
      const steps = value.steps.map((s) =>
        s.stepId === stepId ? { ...s, outcome } : s,
      );
      return this.#save(this.#change(value, { steps }));
    });
  }
  edit(request: {
    stepId: string;
    operation: "delete" | "annotate";
    note: string | null;
    expectedRevision: number;
  }): Promise<RecordingExport> {
    return this.#serial(async () => {
      const value = this.#revision(request.expectedRevision);
      if (value.status === "recording")
        throw new Error("recording_pause_before_edit");
      if (!value.steps.some((s) => s.stepId === request.stepId))
        throw new Error("recording_step_missing");
      if (value.edits.length >= RECORDING_BUDGETS.maxEdits)
        throw new Error("recording_edit_limit");
      const steps =
        request.operation === "delete"
          ? value.steps
              .filter((s) => s.stepId !== request.stepId)
              .map((s) =>
                s.relatedStepId === request.stepId
                  ? { ...s, relatedStepId: null }
                  : s,
              )
          : value.steps.map((s) =>
              s.stepId === request.stepId ? { ...s, note: request.note } : s,
            );
      const evidence = value.evidence.filter((e) =>
        steps.some((s) => s.evidenceIds.includes(e.evidenceId)),
      );
      const edits = [
        ...value.edits,
        {
          revision: value.revision + 1,
          stepId: request.stepId,
          operation: request.operation,
          at: this.now().toISOString(),
        },
      ];
      const saved = await this.#save(
        this.#change(value, { steps, evidence, edits }),
      );
      // Unreferenced geometry is not retained as a hidden copy of a deleted step.
      await Promise.all(
        value.evidence
          .filter((e) => !evidence.includes(e))
          .map((e) =>
            rm(join(this.directory, value.recordingId, `${e.evidenceId}.bin`), {
              force: true,
            }),
          ),
      );
      return saved;
    });
  }
  select(recordingId: string): Promise<RecordingExport> {
    return this.#serial(async () => {
      if (
        this.#selected &&
        !terminal(this.#selected.status) &&
        this.#selected.status !== "interrupted"
      )
        throw new Error("recording_finish_current_first");
      const value = this.#catalog.get(recordingId);
      if (!value) throw new Error("recording_missing");
      this.#selected = value;
      return structuredClone(value);
    });
  }
  remove(recordingId: string): Promise<void> {
    return this.#serial(async () => {
      if (
        this.#selected?.recordingId === recordingId &&
        this.#selected.status === "recording"
      )
        throw new Error("recording_pause_before_delete");
      if (!this.#catalog.has(recordingId)) throw new Error("recording_missing");
      await rm(join(this.directory, recordingId), { recursive: true });
      this.#catalog.delete(recordingId);
      if (this.#selected?.recordingId === recordingId) this.#selected = null;
    });
  }
  async evidence(evidenceId: string): Promise<string> {
    const value = this.#require();
    const evidence = value.evidence.find((e) => e.evidenceId === evidenceId);
    if (!evidence || !validId(evidenceId))
      throw new Error("recording_evidence_missing");
    const path = join(this.directory, value.recordingId, `${evidenceId}.bin`);
    if ((await stat(path)).size !== evidence.byteLength)
      throw new Error("recording_evidence_mismatch");
    const data = await readFile(path);
    if (digest(data) !== evidence.contentDigest)
      throw new Error("recording_evidence_mismatch");
    return `data:${evidence.mediaType};base64,${data.toString("base64")}`;
  }
}
