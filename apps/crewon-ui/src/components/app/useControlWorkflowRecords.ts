import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CrewonWorkflowRecord } from "../../lib/workflow/crewonWorkflow";
import {
  ControlDurableWorkflowRuntime,
  workflowRecordExecution,
  type WorkflowReadScope,
  type WorkflowObservation,
} from "../../lib/control-runtime/controlDurableWorkflowRuntime";
import type { WorkflowIntent } from "../../lib/control-runtime/controlWorkflowIntentJournal";
import type { WorkflowCommandRequestOptions } from "../../lib/control-runtime/controlWorkflowCommands";
import type { ControlWorkflowCreateInput } from "../../lib/control-runtime/controlWorkflowDefinition";

type Availability = Awaited<
  ReturnType<ControlDurableWorkflowRuntime["availability"]>
>;
type RecordState = {
  records: CrewonWorkflowRecord[];
  status: "loading" | "ready" | "unavailable";
  availability: Availability | null;
  notice: string | null;
  mode: "catalog" | "legacy";
  cursor: string | null;
  nextCursor: string | null;
  previous: (string | null)[];
  busy: boolean;
};
const initial = (): RecordState => ({
  records: [],
  status: "loading",
  availability: null,
  notice: null,
  mode: "catalog",
  cursor: null,
  nextCursor: null,
  previous: [],
  busy: false,
});

/** One source-bound record owner. Directory reads never advance execution and
 * periodic selected-root reads never reload the entire catalog/history.
 */
export function useControlWorkflowRecords(input: {
  runtime: ControlDurableWorkflowRuntime | null;
  enabled: boolean;
  refreshNonce: number;
}) {
  const owner = useMemo(
    () => ({
      runtime: input.runtime,
      data: initial(),
      abort: new AbortController(),
      live: false,
      generation: 0,
      availabilityEpoch: 0,
      versions: new Map<string, number>(),
      targets: new Map<string, string | null>(),
      tail: Promise.resolve(),
      pending: new Map<string, Promise<void>>(),
    }),
    [input.runtime, input.enabled],
  );
  const current = useRef(owner);
  current.current = owner;
  const [rendered, setRendered] = useState({ owner, data: owner.data });
  const live = useCallback(
    (generation = owner.generation) =>
      current.current === owner &&
      owner.live &&
      owner.generation === generation &&
      !owner.abort.signal.aborted,
    [owner],
  );
  const publish = useCallback(() => {
    if (live()) setRendered({ owner, data: { ...owner.data } });
  }, [owner, live]);
  const assertLive = useCallback(
    (generation: number) => {
      if (!live(generation))
        throw new DOMException("Workflow source changed", "AbortError");
    },
    [live],
  );
  const options = (): WorkflowCommandRequestOptions => ({
    signal: owner.abort.signal,
  });

  const apply = useCallback(
    (record: CrewonWorkflowRecord) => {
      const previous = owner.data.records.find(
        (item) => item.config.workflowId === record.config.workflowId,
      );
      const control = record.control
        ? { ...previous?.control, ...record.control }
        : undefined;
      const unavailable = owner.data.availability;
      if (control?.source === "durable") {
        // A scoped snapshot must not discard another root visited/accepted in
        // this room. Explicit directory pages still replace their own window.
        const previousRoot = previous?.control?.root;
        if (previousRoot && !Object.hasOwn(record.control!, "roots"))
          control.roots = [
            previousRoot,
            ...(previous?.control?.roots ?? []).filter(
              (run) => run.runId !== previousRoot.runId,
            ),
          ].slice(0, 20);
        control.canStart = Boolean(
          unavailable?.execution.admission && unavailable.contextId,
        );
        control.canReview = Boolean(
          unavailable?.execution.humanGates && unavailable.contextId,
        );
        if (!unavailable?.execution.snapshots || !unavailable.contextId)
          control.readOnlyReason = "当前服务尚未启用持久协作流执行，记录可查看";
      }
      const next = { ...record, ...(control ? { control } : {}) };
      owner.data.records = previous
        ? owner.data.records.map((item) =>
            item.config.workflowId === record.config.workflowId ? next : item,
          )
        : [next, ...owner.data.records].slice(0, 20);
      owner.data.status = "ready";
      publish();
    },
    [owner, publish],
  );

  const availability = useCallback(
    async (generation: number) => {
      if (!owner.runtime) return;
      const epoch = ++owner.availabilityEpoch;
      const result = await owner.runtime.availability(options());
      assertLive(generation);
      if (epoch !== owner.availabilityEpoch) return;
      if (
        owner.data.availability &&
        owner.data.availability.contextId !== result.contextId
      ) {
        owner.data.records = [];
        owner.data.status = "unavailable";
        owner.targets.clear();
        owner.versions.clear();
        owner.data.notice = "身份或执行配置已变化，请重新读取目录";
      }
      owner.data.availability = result;
      publish();
    },
    [owner, assertLive, publish],
  );

  const enqueue = useCallback(
    (key: string, read: (generation: number) => Promise<void>) => {
      const generation = owner.generation;
      const identity = `${generation}:${key}`;
      const existing = owner.pending.get(identity);
      if (existing) return existing;
      const task = owner.tail.then(async () => {
        if (!live(generation)) return;
        owner.data.busy = true;
        publish();
        try {
          await read(generation);
        } catch (error) {
          if (live(generation)) {
            owner.data.notice =
              error instanceof Error ? error.message : "状态同步暂不可用";
            owner.data.status = owner.data.records.length
              ? "ready"
              : "unavailable";
            publish();
          }
        } finally {
          if (live(generation)) {
            owner.data.busy = false;
            publish();
          }
        }
      });
      const tracked = task.finally(() => {
        if (owner.pending.get(identity) === tracked)
          owner.pending.delete(identity);
      });
      owner.pending.set(identity, tracked);
      owner.tail = tracked.catch(() => {});
      return tracked;
    },
    [owner, live, publish],
  );

  const directory = useCallback(
    (mode: "catalog" | "legacy", cursor: string | null) =>
      enqueue(`directory:${mode}:${cursor}`, async (generation) => {
        if (!owner.runtime) return;
        if (mode === "catalog") await availability(generation);
        const page =
          mode === "catalog"
            ? await owner.runtime.catalog(cursor, options())
            : await owner.runtime.legacy(
                cursor ? Number(cursor.slice("legacy:".length)) : 0,
              );
        assertLive(generation);
        const old = new Map(
          owner.data.records.map((record) => [
            record.config.workflowId,
            record,
          ]),
        );
        owner.data.records = page.records.map((record) =>
          old.get(record.config.workflowId)?.control?.loaded
            ? old.get(record.config.workflowId)!
            : record,
        );
        owner.data.mode = mode;
        owner.data.cursor = cursor;
        owner.data.nextCursor = page.nextCursor;
        owner.data.status = "ready";
        owner.data.notice = null;
        publish();
      }),
    [owner, enqueue, availability, assertLive, publish],
  );

  const reload = useCallback(
    (scope?: WorkflowReadScope) => {
      if (!scope) return directory(owner.data.mode, owner.data.cursor);
      if (scope.workflowVersionId.startsWith("legacy:"))
        return Promise.resolve();
      const matchesTarget = () =>
        scope.runId === null ||
        !owner.targets.has(scope.workflowVersionId) ||
        owner.targets.get(scope.workflowVersionId) === scope.runId;
      if (!matchesTarget()) return Promise.resolve();
      const versionEpoch = owner.versions.get(scope.workflowVersionId) ?? 0;
      const contextId = owner.data.availability?.contextId;
      return enqueue(
        `root:${scope.workflowVersionId}:${scope.runId}:${scope.cursor ?? ""}:${versionEpoch}`,
        async (generation) => {
          if (
            !owner.runtime ||
            !matchesTarget() ||
            contextId !== owner.data.availability?.contextId ||
            versionEpoch !== (owner.versions.get(scope.workflowVersionId) ?? 0)
          )
            return;
          const record = owner.data.availability?.execution.snapshots
            ? await owner.runtime.read(scope, options())
            : await owner.runtime.definition(
                scope.workflowVersionId,
                options(),
              );
          assertLive(generation);
          if (
            !matchesTarget() ||
            contextId !== owner.data.availability?.contextId ||
            versionEpoch !== (owner.versions.get(scope.workflowVersionId) ?? 0)
          )
            return;
          owner.targets.set(
            scope.workflowVersionId,
            record.control?.knownRunId ?? null,
          );
          apply(record);
          owner.data.notice = null;
          publish();
        },
      );
    },
    [owner, directory, enqueue, assertLive, apply, publish],
  );

  const inspect = useCallback(
    (scope: WorkflowReadScope) => {
      owner.targets.set(scope.workflowVersionId, scope.runId);
      owner.versions.set(
        scope.workflowVersionId,
        (owner.versions.get(scope.workflowVersionId) ?? 0) + 1,
      );
      return reload(scope);
    },
    [owner, reload],
  );

  useEffect(() => {
    if (!input.enabled || !owner.runtime) return;
    owner.abort = new AbortController();
    owner.live = true;
    owner.generation++;
    void directory("catalog", null);
    return () => {
      owner.live = false;
      owner.generation++;
      owner.abort.abort();
    };
  }, [input.enabled, owner, directory]);
  const previousRefresh = useRef(input.refreshNonce);
  useEffect(() => {
    if (previousRefresh.current === input.refreshNonce) return;
    previousRefresh.current = input.refreshNonce;
    if (input.enabled) void directory(owner.data.mode, owner.data.cursor);
  }, [input.enabled, input.refreshNonce, directory, owner]);

  const mutate = useCallback(
    async (
      workflowId: string,
      perform: (
        runtime: ControlDurableWorkflowRuntime,
        requestOptions: ReturnType<typeof options>,
      ) => Promise<CrewonWorkflowRecord>,
    ) => {
      const generation = owner.generation;
      assertLive(generation);
      if (!owner.runtime) throw Error("Control 协作流暂不可用");
      const expectedRecoveryContext = owner.data.availability?.contextId;
      if (!expectedRecoveryContext)
        throw Error("workflow_durable_execution_unavailable");
      const versionEpoch = (owner.versions.get(workflowId) ?? 0) + 1;
      owner.versions.set(workflowId, versionEpoch);
      try {
        const record = await perform(owner.runtime, {
          ...options(),
          expectedRecoveryContext,
        });
        assertLive(generation);
        if (versionEpoch !== owner.versions.get(workflowId)) return record;
        owner.targets.set(workflowId, record.control?.knownRunId ?? null);
        apply(record);
        if (record.control?.knownRunId)
          void reload({
            workflowVersionId: record.control.workflowVersionId,
            runId: record.control.knownRunId,
          });
        return record;
      } finally {
        if (live(generation))
          void availability(generation).catch((error) => {
            if (live(generation)) {
              owner.data.notice =
                error instanceof Error ? error.message : "恢复记录暂不可用";
              publish();
            }
          });
      }
    },
    [owner, assertLive, apply, reload, live, availability, publish],
  );

  const data = rendered.owner === owner ? rendered.data : owner.data;
  return {
    ...data,
    pending: data.availability?.pending ?? [],
    reload,
    inspect,
    draft(workflowVersionId: string) {
      assertLive(owner.generation);
      const record = owner.data.records.find(
        (record) => record.config.workflowId === workflowVersionId,
      );
      if (
        !record?.control ||
        record.control.source !== "durable" ||
        !record.control.loaded
      )
        return;
      owner.versions.set(
        workflowVersionId,
        (owner.versions.get(workflowVersionId) ?? 0) + 1,
      );
      owner.targets.set(workflowVersionId, null);
      const roots = record.control.root
        ? [
            record.control.root,
            ...(record.control.roots ?? []).filter(
              (run) => run.runId !== record.control!.root!.runId,
            ),
          ].slice(0, 20)
        : record.control.roots;
      apply({
        ...record,
        config: { ...record.config, status: "ready", runs: [] },
        control: {
          ...record.control,
          root: undefined,
          roots,
          knownRunId: null,
          awaitingSnapshot: false,
        },
      });
    },
    async *observe(scope: WorkflowObservation, signal: AbortSignal) {
      const generation = owner.generation,
        contextId = owner.data.availability?.contextId;
      assertLive(generation);
      if (!owner.runtime) return;
      if (owner.targets.get(scope.workflowVersionId) !== scope.runId) return;
      const combined = AbortSignal.any([owner.abort.signal, signal]);
      for await (const event of owner.runtime.events(scope, combined)) {
        assertLive(generation);
        if (
          contextId !== owner.data.availability?.contextId ||
          owner.targets.get(scope.workflowVersionId) !== scope.runId
        )
          return;
        yield event;
      }
    },
    async evidence(input: {
      workflowVersionId: string;
      runId: string;
      nodeId: string;
      signal: AbortSignal;
    }) {
      const generation = owner.generation,
        contextId = owner.data.availability?.contextId;
      assertLive(generation);
      if (!owner.runtime) throw Error("Control 协作流暂不可用");
      const { signal, ...scope } = input;
      const result = await owner.runtime.verificationEvidence(scope, {
        signal: AbortSignal.any([owner.abort.signal, signal]),
      });
      assertLive(generation);
      if (contextId !== owner.data.availability?.contextId)
        throw new DOMException("Workflow source changed", "AbortError");
      return result;
    },
    async run(input: {
      workflowVersionId: string;
      threadId: string;
      prompt: string;
    }) {
      return workflowRecordExecution(
        await mutate(input.workflowVersionId, (runtime, opts) =>
          runtime.runWorkflow(input, opts),
        ),
      );
    },
    async cancel(input: { workflowVersionId: string; executionId: string }) {
      return workflowRecordExecution(
        await mutate(input.workflowVersionId, (runtime, opts) =>
          runtime.cancelWorkflow(input, opts),
        ),
      );
    },
    async review(input: {
      workflowVersionId: string;
      executionId: string;
      nodeId: string;
      decision: "approve" | "reject";
      comment: string | null;
    }) {
      return workflowRecordExecution(
        await mutate(input.workflowVersionId, (runtime, opts) =>
          runtime.resolveGate(input, opts),
        ),
      );
    },
    async recover(intent: WorkflowIntent) {
      return mutate(intent.workflowVersionId, (runtime, opts) =>
        runtime.recover(intent, opts),
      );
    },
    async create(input: ControlWorkflowCreateInput) {
      const generation = owner.generation;
      assertLive(generation);
      if (!owner.runtime) throw Error("Control 协作流暂不可用");
      const record = await owner.runtime.createWorkflow(input, options());
      assertLive(generation);
      apply(record);
      return record;
    },
    async browse(mode: "catalog" | "legacy") {
      owner.data.previous = [];
      await directory(mode, null);
    },
    async next() {
      if (!owner.data.nextCursor) return;
      if (owner.data.previous.length >= 100) {
        owner.data.notice = "目录分页已达本次浏览上限，请返回首页";
        publish();
        return;
      }
      owner.data.previous = [...owner.data.previous, owner.data.cursor];
      await directory(owner.data.mode, owner.data.nextCursor);
    },
    async previousPage() {
      const previous = [...owner.data.previous];
      if (!previous.length) return;
      const cursor = previous.pop()!;
      owner.data.previous = previous;
      await directory(owner.data.mode, cursor);
    },
  };
}
