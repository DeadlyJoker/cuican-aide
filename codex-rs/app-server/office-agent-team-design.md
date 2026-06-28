# Office Agent Team Execution Design

Date: 2026-06-20

This document designs the backend execution mode for Crewon Office Agent teams and records the first backend slice implemented in this change.

## Goal

An Office is not just a saved group-chat JSON blob. It is a persistent team workspace that can start real agent execution, stream progress through existing thread/turn events, and keep a durable office-level view of members, tasks, runs, approvals, and artifacts.

The backend should:

- Run real model turns, not fake office replies.
- Reuse existing Crewon thread, turn, permission, approval, sandbox, and multi-agent tooling.
- Keep office state bounded and frontend-friendly.
- Allow the frontend to render office runs without learning core rollout internals.
- Leave room for richer supervisor graphs, background runs, and sub-agent result reducers.

## External Architecture Review

The current multi-agent landscape converges on a hybrid model:

- Deterministic orchestration for state, limits, routing, persistence, and human-in-loop checkpoints.
- Agentic behavior inside bounded steps where the model can plan, call tools, hand off, or delegate.

Relevant references:

- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents) distinguishes predictable workflows from open-ended agents and recommends the simplest pattern that solves the task.
- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) describes a planner that creates parallel specialist agents, and highlights coordination, evaluation, and reliability as the hard production problems.
- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) treats context as a finite resource that must be curated on each loop iteration, not a transcript that grows forever.
- [Anthropic: Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) argues for stable managed-agent interfaces while the harness changes underneath as models improve.
- [LangGraph workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) emphasizes graphs, durable state, interrupts, and controllable multi-agent flows.
- [LangGraph multi-agent systems](https://docs.langchain.com/oss/python/langgraph/multi-agent) documents supervisor and handoff patterns.
- [Microsoft AutoGen AgentChat teams](https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/tutorial/teams.html) models multi-agent execution as teams with group-chat managers and termination conditions.
- [CrewAI crews](https://docs.crewai.com/concepts/crews) and [CrewAI flows](https://docs.crewai.com/concepts/flows) separate collaborative agent crews from more deterministic flow orchestration.
- [OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/) treats handoff as a first-class operation where one agent delegates control to another specialized agent.
- [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-python/sessions/) separates per-session conversation history from the orchestration layer. This reinforces the Office split between manager thread history, member runtime history, and bounded shared memory.
- [OpenAI Agents SDK running agents](https://openai.github.io/openai-agents-python/running_agents/) now documents durable-agent integrations with human approval, handoffs, and session management as a runtime concern, which matches the need for Office scheduling to survive UI lifecycle boundaries.
- [OpenAI Swarm](https://github.com/openai/swarm) was an educational handoff/routine reference and is useful as a minimal conceptual baseline, not as a production runtime.
- [Multica](https://github.com/multica-ai/multica) is a managed-agents platform that turns coding agents into board-visible teammates. Its product framing emphasizes task lifecycle management, autonomous execution on a local or owned runtime, blocker reporting, and real-time progress streaming over WebSocket.
- [Loop Engineering](https://addyosmani.com/blog/loop-engineering/) frames effective AI-assisted engineering as an explicit loop: define goal and acceptance criteria, provide context, act, observe evidence, correct, and stop when the result is verified. For Office this maps to run-level loop metadata, bounded memory retrieval, and explicit verification evidence rather than a single fire-and-forget chat turn.

Design implications for Crewon:

- Use existing thread/turn runtime as the durable execution substrate.
- Keep Office orchestration in app-server rather than adding more behavior to `crewon-core`.
- Make each office run explicit and persistent.
- Bound all office context injected into the model.
- Let the model use existing multi-agent tools for delegation only when useful.
- Keep human approvals and sandbox escapes on the existing core path.
- Expose office-level run state directly to clients so they do not need to reconstruct a task lifecycle from raw rollout events.
- Treat long-term memory as a bounded retrieval layer with evidence references, not as unbounded history injection.

## Local Architecture Review

Existing Crewon pieces:

- `codex-rs/app-server-protocol`: v2 JSON-RPC API schema and TypeScript generation.
- `codex-rs/app-server`: JSON-RPC request routing, thread lifecycle, turn start, domain config persistence.
- `codex-rs/core`: thread runtime, model loop, tools, `AgentControl`, multi-agent v1/v2 handlers.
- `apps/crewon-ui`: office UI and demo state models, currently ahead of backend execution.

Existing Office APIs before this change:

- `office/list`, `office/save`, `office/create`, `office/read`, `office/message/send`, `office/member/add`, `office/approval/decide`, `office/artifact/upsert`, `office/delete`.
- These persist office config under `.crewon/offices/*.json`.
- `office/message/send` can append messages and demo-style task replies, but does not run a model turn.

Existing multi-agent runtime:

- Core already has `AgentControl` and multi-agent tool handlers: `spawn_agent`, `wait_agent`, `send_input`, `resume_agent`, `close_agent`, and v2 variants.
- App-server already streams thread, turn, item, tool, approval, and status notifications.
- The office backend should call into this existing path instead of creating a parallel runtime.

`multica` note:

- Local repository search does not contain a Multica implementation, but the public Multica project is relevant as an external comparison.
- The strongest applicable idea is not another model loop. It is a managed-agent harness: explicit task identity, queued/running/completed/failed transitions, progress streaming, blocker/status reporting, and a team-visible board.
- Crewon's closest local building blocks are `core/src/tools/handlers/multi_agents*`, `core/src/agent/control*`, `rollout-trace`, and the frontend Office workspace model. The Office backend should compose those pieces rather than importing a separate runtime.

## Execution Model

### Core Concepts

- Office: persistent team workspace config.
- Office member: saved agent persona and UI metadata; may reference `agentId`.
- Office run: one explicit user-driven execution attempt within an office.
- Office main thread: the bound Crewon thread stored at `workspace.threadId`.
- Team execution turn: a normal `turn/start` on the office main thread, seeded with bounded office context and execution instructions.
- Sub-agent delegation: optional model-chosen use of existing multi-agent tools from inside the office main thread.

### V1 Flow

1. Frontend ensures the office is bound to a thread.
2. Frontend calls `office/run` with `cwd`, current office `config`, user `message`, and user `text`.
3. Backend validates the office and thread binding.
4. Backend appends the user message, creates `workspace.activity.runs[0]`, and saves the office config with status `queued`.
5. Backend calls existing `turn/start` on `workspace.threadId`.
6. Backend marks the office run `running`, attaches `turnId`, saves the office config again, and returns `{ filePath, config, threadId, runId, turn }`.
7. Frontend renders office state from the response and streams progress from normal thread/turn/item notifications.
8. When the thread emits a terminal completion or interruption event, app-server scans the same cwd's saved offices for a matching `workspace.threadId` and run `turnId`, then writes the terminal run/task/message state.
9. Frontend can still call `office/run/sync` with the latest `Turn` for in-progress refreshes, missed notifications, or explicit recovery. The sync is idempotent.
   When a matching saved run exists, the backend applies the reducer to the latest persisted Office record instead of blindly trusting the client-supplied snapshot.

### Member Delegation Flow

1. The office run snapshots a bounded `delegationRoutes[]` list from resolved member runtimes.
2. The supervisor turn may report planned delegations in `officeUpdate.delegations`; sync enriches those rows with the matching route target when the model only reports `member` or `agentId`.
3. A client can call `office/delegation/dispatch` with `runId`, `task`, and either `member` or `agentId`, or call `office/delegation/dispatch/next` to let the backend choose the next eligible planned delegation for that run.
4. Backend resolves the latest saved Office record, validates the source run, finds the matching route, claims an existing planned delegation row when the `member`/`agentId` and `task` match, or appends a new queued delegation record when no planned row exists.
5. If member turn startup succeeds, the delegation is marked `running` with the member `turnId`. If startup fails, the delegation is marked `failed` with a bounded error.
6. Re-dispatching the same already queued/running/completed member task is rejected server-side, so multi-client clicks or retries cannot start duplicate member turns. A startup failure that never received a `turnId` can be retried by claiming the same delegation row back to `queued`. The backend `dispatch/next` scheduler resolves the latest saved Office state while holding the dispatch claim lock, then skips started, terminal, blocked, skipped, and unroutable rows so stale clients do not duplicate dispatch eligibility logic.
7. When the member turn reaches a terminal state, app-server scans saved Offices for a matching delegation `turnId`, marks that delegation `completed`, `failed`, or `interrupted`, stores a bounded `resultPreview` or `error`, updates the delegated task, and appends one deduplicated Office system message.
8. A client can call `office/delegation/retry` for one failed or interrupted delegation. The backend keeps the source row immutable, appends a new queued delegation with `retryOf`, starts a fresh member turn, and seeds the prompt with bounded previous status/error/result context.
9. A client can call `office/delegation/cancel` for one active delegation. The backend validates the saved delegation `threadId`/`turnId`, interrupts only that member turn, and marks only that delegation `canceling`; the manager run and sibling child turns continue.
10. The member thread remains the authoritative private transcript for that member. The Office run keeps only the shared delegation ledger and bounded summaries/evidence.

### Why This Shape

- It is real execution because the app-server starts a normal turn.
- It is low risk because permissions, approvals, sandboxing, tools, retries, and streaming stay in the existing runtime.
- It keeps Office out of `crewon-core`.
- It avoids inventing a second event bus.
- It gives the frontend a stable office-level run id while preserving the canonical thread/turn id.

## State Model

Office config remains JSON for compatibility with current UI domain types.

New run state lives under:

```json
{
  "workspace": {
    "activity": {
      "runs": [
        {
          "id": "office-run-...",
          "title": "Short request title",
          "status": "queued | running | canceling | completed | failed | interrupted",
          "threadId": "thread-id",
          "turnId": "turn-id",
          "createdAt": "2026-06-17T00:00:00Z",
          "updatedAt": "2026-06-17T00:00:01Z",
          "completedAt": "2026-06-17T00:00:02Z",
          "cancelRequestedAt": "2026-06-17T00:00:03Z",
          "requestText": "bounded original request",
          "promptPreview": "bounded preview",
          "resultPreview": "bounded final agent message",
          "goal": "bounded goal snapshot",
          "retryOf": "office-run-parent",
          "loop": {
            "mode": "officeLoopEngineering",
            "iteration": 1,
            "maxIterations": 4,
            "phase": "frame | observe | verify | correct | summarize",
            "status": "continue | ready | blocked | iterationLimit",
            "cycle": ["frame", "plan", "delegate", "act", "observe", "verify", "summarize"],
            "memoryPolicy": "boundedRetrieval",
            "metrics": { "iteration": 1, "maxIterations": 4, "retryBudgetRemaining": 3, "acceptance": {}, "verification": {}, "evidence": {}, "risks": {}, "delegations": {} },
            "stopConditions": [{ "condition": "acceptanceCriteriaDefined", "met": false }, { "condition": "hasRetryBudget", "met": true }],
            "review": { "status": "incomplete | needsReview | blocked | passed", "nextAction": "bounded next action", "acceptance": {}, "verification": {}, "evidence": {}, "risks": {} }
          },
          "memoryRefs": [{ "id": "office-memory-...", "scope": "office", "kind": "decision", "content": "bounded memory preview", "confidence": "high", "importance": "high" }],
          "delegationRoutes": [{ "member": "Reviewer", "agentId": "agent-reviewer", "target": "member-runtime-thread", "targetKind": "runtimeThread", "tool": "followup_task" }],
          "plan": [{ "step": "bounded step", "status": "pending | inProgress | completed" }],
          "delegations": [{ "id": "office-delegation-...", "member": "Reviewer", "agentId": "agent-reviewer", "task": "bounded task", "status": "queued | running | canceling | completed | failed | interrupted", "threadId": "child-thread", "turnId": "turn-id", "target": "member-runtime-thread", "tool": "followup_task", "dispatchMethod": "turnStart", "memoryRefs": [{ "id": "office-memory-...", "scope": "member", "kind": "preference", "content": "bounded memory preview" }] }],
          "verificationChecks": [{ "check": "bounded check", "status": "pending | passed | failed", "dispatchStatus": "queued | running | canceling | completed | failed", "automationStatus": "queued | running | canceling | completed | failed", "command": "optional bounded command", "automationId": "optional automation id", "automationThreadId": "automation thread", "automationTurnId": "automation turn", "criterion": "optional matching acceptance criterion", "criterionId": "optional acceptance criterion id", "evidence": "optional bounded proof" }],
          "error": "bounded failure message"
        }
      ]
    }
  }
}
```

Run statuses:

- `queued`: office state was saved before turn start.
- `running`: turn was accepted and `turnId` is known.
- `canceling`: the user requested cancellation and app-server submitted an interrupt.
- `completed`: turn finished successfully.
- `failed`: turn start failed or the terminal turn reported failure.
- `interrupted`: terminal turn was interrupted.

The app-server also maintains `.crewon/office-runs/index.json` as a bounded lookup table from office `runId` / `threadId` / `turnId` to the persisted office file. Terminal sync and retry/cancel resolution prefer this index before falling back to a bounded scan of saved offices.

## Prompt Context Boundaries

The office execution prompt is intentionally bounded:

- User text: 4,000 chars.
- Office title: 80 chars.
- Office fields: 160 chars.
- Members: 8 max.
- Tasks: 12 max.
- Retrieved accepted memories: 6 max.
- Memory content in prompt: 360 chars per item.
- Error messages saved to office state: 320 chars.

The prompt includes:

- Office title and goal.
- Bounded member list with saved `agentId`, optional runtime `threadId`, `contextPolicy`, and `memoryScope` when available.
- Bounded task list.
- Bounded accepted long-term memories from `.crewon/office-memory/index.json`.
- Current user request.
- Loop Engineering execution contract requiring frame -> plan -> delegate -> act -> observe -> verify -> summarize.
- Optional final fenced `officeUpdate` JSON with bounded `summary`, `goalUpdate`, `plan`, `acceptanceCriteria`, `verificationChecks`, `evidence`, `risks`, `tasks`, `artifacts`, `delegations`, and `memories`.

The prompt does not include unbounded message history. The canonical conversation history remains the bound thread's rollout.

## Context Ownership

Office execution uses three context layers:

- Shared run context: the Office main thread and `workspace.activity.runs[]` own the user request, run status, task state, delegation summary, artifacts, and verification evidence.
- Member private context: each saved Office member can reference an `agentId`; the backend resolves that `agentId` to the saved Agent config and merges `runtime.threadId`, `contextPolicy`, and `memoryScope` onto the member before `office/run` or `office/run/retry` builds the prompt. This lets the supervisor prefer a durable member runtime instead of treating the member as a stateless role label.
- Long-term memory context: accepted memory facts are retrieved separately from `.crewon/office-memory/index.json` and cited through run-level `memoryRefs`.

The model prompt receives only a bounded digest of these layers. It never receives every member's full private transcript. Member thread rollout remains private and authoritative for that member, while the Office run stores only shared summaries, delegation records, and evidence references.

State ownership is intentionally asymmetric:

- App-server is the source of truth for the Office run graph, scheduler claims, verification dispatch, memory decisions, and reducer-written provenance.
- The Office JSON is a bounded shared ledger, not a transcript store. It records ids, statuses, summaries, evidence, hashes, and provenance needed by the team board.
- The supervisor thread is the authoritative transcript for manager reasoning. Member runtime threads are the authoritative private transcripts for member execution. Automation runtime threads are the authoritative transcripts for automation verification runs.
- Member `contextPolicy` controls only the bounded shared Office digest injected into a member prompt. `sharedDigest` includes run-level task, acceptance, verification, evidence, risk, and delegation summaries; `forkLastN` adds a small bounded slice of recent Office messages; `isolated` omits shared Office digest entirely. None of these policies copy manager or member rollout transcripts into the member prompt.
- `office/run/updated` is a state-snapshot notification. Clients should apply the matching `config`, but should not infer new `OfficeRunTurnRecord` entries or become responsible for auto-dispatched child turn completion from this notification alone.
- Visible `turn/completed` handling and frontend fallback sync are latency and UX accelerators for turns the client already knows about. Backend terminal listeners, persisted-history recovery, scheduler-intent replay, and non-consuming completion monitors are the authority for automatically dispatched member and automation turns.
- Long-term memory is never promoted by model text alone. Model-authored memories are pending candidates until `office/memory/decide` accepts them, and prompt retrieval only uses accepted bounded memories.
- Run and delegation `memoryRefs` are bounded governance pointers rather than raw memory records. Each ref includes the memory id, scope, kind, bounded content preview, confidence, importance, current status, optional member/agent identity, and bounded evidence refs so clients can show whether a cited memory is a pending candidate or an accepted retrieval without opening the full memory index.

Current backend behavior:

- `office/member/add` attaches the selected `agentId` and, when a matching saved Agent exists, fills missing member runtime defaults from that Agent's `threadId`.
- `office/member/add` and runtime resolution also attach a bounded `agentProfile` summary from the saved Agent's role, instructions, policy, skills, and tools when present. This gives member dispatch a stable persona/capability summary without copying the Agent's private transcript into the Office prompt.
- `office/run` and `office/run/retry` resolve saved member runtimes before prompt construction, so older Office configs with only `agentId` still become runtime-aware and profile-aware.
- `prompt_members` emits `agentId`, `runtimeThreadId`, `contextPolicy`, `memoryScope`, and bounded `agentProfile`, giving the supervisor concrete routing metadata plus a compact capability/persona hint.
- `office/run` snapshots `delegationRoutes` on each run and the prompt lists exact `followup_task`/`send_message` targets for members with durable runtime threads, including the bounded `agentProfile` used by deterministic member dispatch.
- Member dispatch prompts now apply the saved route `contextPolicy`: default `sharedDigest` injects a bounded Office ledger digest, `forkLastN` adds a bounded recent-message slice, and `isolated` omits shared digest context so the member works from the direct task, its own thread history, and allowed memories only.
- `office/member/context/preview` exposes the same resolved member context boundary without starting a member turn, claiming a delegation, or writing Office state. It returns the route identity, context policy, memory scope, bounded agent profile, bounded shared digest, and bounded long-term memory context so clients can audit "what this member will see" before dispatch.
- `office/run` and `office/run/retry` retrieve only accepted `office`, `project`, and `user` scoped memories for the manager/supervisor prompt. Member-scoped memories are not injected into the manager prompt by default.
- Retrieved or newly produced memory refs carry `status`, `confidence`, `importance`, and bounded `evidenceRefs` on the run/delegation row. Model-authored memories are still saved as `pending` even when the model asks for `accepted`; a later `office/memory/decide` call is the only path that makes future retrieval refs show `accepted`.
- Each run starts with first-class Loop Engineering metadata: `loop.iteration`, `maxIterations`, current `phase`, aggregate `metrics`, and explicit `stopConditions`. `office/run/retry` increments the source run iteration so retries are visible as the next loop cycle instead of an unrelated repeated request, and rejects retries once the source run has exhausted `maxIterations`.
- `office/run/sync` enriches structured `officeUpdate.delegations` with the matching route target when the model reports only `member` or `agentId`, stores bounded `acceptanceCriteria`, `verificationChecks`, `evidence`, and `risks` as first-class run fields, and derives deterministic `loop.review`, `loop.phase`, `loop.status`, `loop.metrics`, and `loop.stopConditions` from those signals.
- Verification checks are the explicit Loop Engineering bridge between acceptance criteria and observed evidence. The reducer accepts `officeUpdate.verificationChecks`, `verification_checks`, `checks`, `testChecks`, and `verification.checks`, normalizes each check to `pending`, `passed`, or `failed`, and preserves optional `command`, `automationId`, `artifact`, `criterion`, `criterionId`, `acceptanceId`, and bounded `evidence` fields with reducer-written provenance. When the same turn contains a completed or failed `commandExecution` whose command matches a verification check's `command` or `itemId`, the reducer automatically marks the check `passed` or `failed` and copies the command item id, exit code, duration, output preview, and output hash onto the check. If a passed check explicitly references an acceptance criterion by `criterion`, `criterionId`, or `acceptanceId`, the reducer marks that criterion `passed`, writes `verifiedByCheck`, and copies reducer provenance onto the criterion. A failed check blocks the run review. An unclaimed pending check with `command` or `automationId` contributes to `review.verification.runnablePending` and keeps the review in `needsReview` with `nextAction: "runVerificationChecks"`; text-only or already queued/running/canceling/completed pending checks contribute to `missingRunnablePending` and keep the next action on evidence collection instead of pretending they can be auto-run. `office/run/retry` turns `runVerificationChecks` into a check-running prompt instead of a generic repair prompt, carrying bounded `command` / `automationId` hints while still executing through the normal turn sandbox, approval, and tool-evidence path. This lets the Office board and retry prompts distinguish "the goal is framed" from "the checks have actually run."
- `automationId` is still an executable reference, not proof by itself. The app-server exposes `automation/run/start` as the real automation execution primitive: it starts a turn on the automation config's existing `threadId`, creates the run record with the returned `turnId`, and terminal turn handling updates that run record to `completed`, `failed`, or `interrupted`. Office now bridges verification checks to that primitive through `office/verification/dispatch/next`: it claims the next pending check with an `automationId`, resolves the id to a saved automation config, starts the automation turn, records `automationRunId` / `automationThreadId` / `automationTurnId` on the check, and later reduces the automation terminal turn back into the Office run as `evidenceKind: "automationRun"` with backend provenance. If a saved automation runtime route points at a missing, unmaterialized, or no-rollout thread, the Office dispatch path creates a replacement durable automation runtime thread, writes the new `threadId` plus `runtimeRepairSourceThreadId` / `runtimeRepairedAt` back to the automation config, and carries that repair provenance onto the verification check. Backend auto-dispatch startup failures that are likely repairable, such as `thread not found`, `no rollout found`, or `agent loop died unexpectedly`, keep the check pending with bounded error text so the next scheduler tick can repair and retry instead of permanently sealing the check as failed. `office/verification/retry` uses the same automation start path for failed or interrupted automation-backed checks, archives the previous bounded attempt, and reuses the same semantic check row instead of duplicating verification criteria. The safe scheduler uses this same deterministic claim/start path after terminal manager, member, or automation-verification sync: it tries safe member delegation first, then pending automation verification, skipping verification checks marked `approvalRequired`, `requiresApproval`, `manualDispatch`, manual dispatch mode, or high risk. Explicit user-triggered verification dispatch may still run those checks. Already queued/running/canceling/completed automation checks are excluded from runnable-pending counts so stale clients and repeated scheduler ticks cannot dispatch the same verification repeatedly.
- The same sync reducer also records bounded evidence from real `commandExecution` and `fileChange` turn items. Completed commands and applied file changes become verified evidence; failed or declined commands/file changes become blocked evidence. These rows include command status, exit code, duration, output preview, `outputSha256`, touched paths, `changesSha256`, item id, and reducer-written provenance. Full stdout and full diffs stay in the authoritative turn history; Office state keeps short previews plus hashes.
- Structured `officeUpdate.artifacts` are merged with reducer-written provenance. Manager-originated artifacts carry manager thread/turn source fields; member-originated artifacts also carry `delegationId`, `member`, and `agentId`, so the Office board can show who produced an artifact without opening that member's private transcript.
- `office/run/retry` is review-aware and budget-aware: when the source run has a non-passing `loop.review` and the caller does not supply explicit text, the backend generates the next Loop iteration from failed or pending acceptance criteria, blocked or unverified evidence, open high risks, and `review.nextAction` instead of blindly repeating the original request. The backend is still the final retry gate; stale or custom clients receive `office loop iteration limit reached` after `hasRetryBudget` becomes false, while the UI shows the limit state before sending the request.
- `office/delegation/dispatch` enforces deterministic dispatch for an approved or client-selected member task by matching `member` or `agentId` against the saved run route and starting a real turn on the member runtime thread. The member prompt retrieves shared-scope memories plus memories matching that exact member or `agentId`; other members' `member` scoped memories are excluded.
- `office/delegation/dispatch/next` moves the "which planned delegation should run now" decision into app-server. It resolves the latest persisted Office config under the claim lock, selects the first planned delegation that has a task, a member or agent id, and a valid saved route, skips rows that are already started, terminal, blocked, skipped, or unroutable, then delegates through the same member runtime path as explicit dispatch.
- `office/delegation/retry` makes member failure recovery a backend primitive instead of a frontend copy action. It only accepts `failed` or `interrupted` source rows, rejects a second active retry for the same source delegation, writes a new delegation with `retryOf`, and reuses the member runtime route/memory/context path while adding bounded previous status, turn, error, and result evidence to the member prompt.
- Delegation startup status writes also re-read the latest persisted Office config before saving. This prevents a member turn's `running` or startup `failed` update from overwriting another delegation that was queued by a concurrent client or scheduler tick.
- Completed manager/member syncs persist pending scheduler intents in `.crewon/office-runs/scheduler.json` before dispatch is attempted. The queue is idempotent by source `threadId`/`turnId`; successful auto-dispatch marks the intent `dispatched` with run, delegation, member thread, and member turn ids, while no-dispatch ticks clear only pending records. This closes the crash/listener gap between terminal Office sync and safe member dispatch.
- App-server terminal turn handling now acts as the first backend scheduler tick: after a manager, member, or automation-verification turn is reconciled into a saved Office run, the listener attempts the same safe scheduler path. It first tries `office/delegation/dispatch/next` semantics with `dispatchPolicy: "auto"` for safe member work, then falls through to pending automation verification checks, and finally starts an automatic manager re-plan when the run's `loop.review` still requires another iteration. Successful member dispatch starts a real member runtime turn, marks the delegation `running`, and emits `office/run/updated` with `reason: "autoDispatchStarted"`; successful automation verification dispatch starts the saved automation turn, records `automationRunId` / `automationThreadId` / `automationTurnId`, and emits `office/run/updated` with `reason: "autoVerificationStarted"`; successful auto re-plan starts a normal manager retry run, records `retryOf`, increments `loop.iteration`, marks it `running`, and emits `office/run/updated` with `reason: "autoReplanStarted"`. Startup failures are written back as bounded delegation, verification, or retry errors.
- `office/delegation/cancel` and `office/verification/cancel` provide per-child control without canceling the whole manager run. Each method resolves the latest saved Office state by `runId`, validates the stored child identity and `threadId`/`turnId`, interrupts only that target turn, marks only the target delegation or verification check `canceling`, refreshes the run index, and emits `office/run/updated`. This keeps the Office control plane useful when one member or automation check stalls while the rest of the team can continue.
- Auto-dispatched member, automation verification, and manager re-plan turns also register a backend completion monitor that does not consume `next_event()` and does not require a visible frontend subscription. The monitor is target-turn driven: it first looks for the specific `turnId` in persisted thread history and only syncs after that turn is terminal, then emits `office/run/updated` with `reason: "autoDispatchCompletion"` and triggers the next safe scheduler tick. If the target turn cannot be loaded but the thread reaches a terminal `AgentStatus`, the monitor waits a short grace window before falling back to a terminal `Turn` derived from status, preserving final assistant text for completed turns and bounded error text for failed turns. Recovery scans re-register this monitor for non-terminal Office rows with a known `threadId` / `turnId`, using a process-local `(cwd, threadId, turnId)` registry so repeated read/list/startup recovery cannot create duplicate monitors. This avoids treating a previous turn's terminal status as completion of the newly submitted turn while still letting restarted app-server processes reconnect to in-flight Office work.
- `office/list` and `office/read` also perform best-effort persisted-history and scheduler recovery. When a saved Office run, delegation, or automation verification check still has a non-terminal status but has a known `threadId`/`turnId`, app-server reads the persisted thread history, reconciles terminal turns through the same reducer, emits `office/run/updated` with `reason: "historyRecovery"`, updates the response config, and triggers the same safe auto-dispatch tick. If the terminal turn is not persisted yet, recovery re-loads the target thread and re-registers the non-consuming completion monitor so in-flight work can finish and sync without a visible frontend subscription. They drain pending `.crewon/office-runs/scheduler.json` intents before falling back to scanning terminal Office JSON rows with unstarted safe delegations, pending automation verification checks, or review-gated manager re-plan work. `thread/list` and `thread/read` now also trigger a bounded cwd-based Office scheduler recovery for returned thread cwd values, so opening the normal thread surfaces can resume missed Office scheduler work before the Office panel is opened. App-server initialization runs the same recovery in the background over a bounded workspace index at `$CODEX_HOME/office-scheduler/workspaces.json` plus recently updated thread cwds. Dispatch recovery cold-loads target member runtime threads with persisted rollouts; if a saved member runtime thread was not already loaded in the current process and has no readable rollout yet, app-server repairs the member route by creating a replacement durable runtime thread from the saved Agent config, rebinding the Agent config and Office `members` / `delegationRoutes` / pending delegation row, and emitting `office/run/updated` with `reason: "runtimeRepair"` before dispatch. The same recovery pass repairs automation verification runtime routes by rebinding the saved automation config before starting the verification turn, and check rows record `runtimeRepairSourceThreadId` / `runtimeRepairedAt` when a repaired runtime is used. Recovery also cold-loads persisted Office manager threads that need auto re-plan before starting the retry turn, so restart recovery can continue a review-gated manager loop instead of failing with `thread not found`. Already-loaded member runtime threads keep their live private context and are not replaced just because they have not yet written a rollout item; automation runtime threads created by the same repair tick are also preserved so they can immediately run their first verification turn. Dispatch start always emits `office/run/updated`; clients should apply that notification even when the read/list response is based on the earlier snapshot. This covers app-server restart or listener-miss cases where terminal state was persisted before the scheduler could start the next member, automation task, or manager re-plan, and where the next child turn was started but its completion monitor needs to be reattached after recovery.
- Explicit `office/run/sync` now also performs the same safe scheduler tick after visible reconciliation. This keeps foreground clients responsive without requiring a second client-side dispatch call; no-op dispatch results are ignored, while real dispatch failures are persisted as bounded delegation errors.
- Terminal member turns are automatically reduced back into the parent Office run by matching delegation `turnId`, without rewriting the parent run's main `turnId` or copying the member private transcript into Office JSON. The reducer stores bounded result/error summaries, updates the delegated task, applies bounded member `officeUpdate.tasks`, `officeUpdate.artifacts`, `officeUpdate.acceptanceCriteria`, `officeUpdate.verificationChecks`, `officeUpdate.evidence`, and `officeUpdate.risks`, refreshes the parent run's `loop.review`, and persists member `officeUpdate.memories` as cited long-term Office memory.
- Manager and member acceptance/evidence/risk items receive backend provenance fields: `sourceType`, `sourceThreadId`, `sourceTurnId`, and `observedAt`. Member-originated items also carry the matching `delegationId`, `member`, and `agentId` when available. The model may still provide a human-readable `source`, but the source thread and turn are written by the reducer, not trusted from model text. This provenance is also attached to tool-derived evidence, so the Office can share auditable outcomes without sharing member-private transcripts.
- Artifact rows receive the same source fields as reducer signals and may include bounded `path`/`url` values from the structured update. `office/artifact/upsert` records `contentSource`, `contentStatus`, `contentObservedAt`, `contentSha256`, and `contentBytes` when the client explicitly supplies string inline `content`, `body`, or `text`, then strips those inline content fields before saving the artifact row. For file-backed artifacts, app-server writes `contentSource: "file"` and a best-effort `contentStatus` (`fingerprinted`, `missing`, `outsideWorkspace`, `notFile`, `tooLarge`, or `unreadable`). Successful regular files inside the workspace and under the artifact fingerprint size cap receive `contentSha256` and `contentBytes`; failed observations clear stale fingerprints and may include bounded `contentError`. Full artifact contents remain in their own files or turn history; Office JSON stores only the display row, provenance, and content observation.

Remaining gap: the evidence/risk/artifact schema is still intentionally compact, and the scheduler is app-server driven rather than a separate durable queue service. App-server startup now performs a bounded best-effort scheduler recovery over the Office workspace index and recently updated thread cwds, so terminal Office work can resume after a restart without waiting for the frontend to open `office/read`, `office/list`, `thread/read`, or `thread/list`. Startup recovery can cold-load dispatch target threads that already have persisted rollout history and can repair saved member runtime routes whose target thread never produced a readable rollout by creating and rebinding a replacement runtime thread before starting the next member turn. It also repairs missing or unmaterialized automation verification runtime routes by rebinding the saved automation config before dispatch. Active automatic re-planning is now implemented as the scheduler's final stage and is guarded by review status, retry budget, no existing retry from the same source run, no active child work, no runnable automation verification, no missing acceptance frame, no high open risk, and no manual/approval gates. A later stage should add a first-class durable worker/index that is not tied to app-server process lifetime, but the current run model already has bounded fields for acceptance criteria, explicit verification checks that auto-link matching command evidence or automation-run evidence, safe scheduler-driven automation verification, safe review-driven re-planning, a real automation execution primitive, tool-derived evidence with output/diff hashes, artifacts with reducer-written source provenance and inline/file content observations, risks, and a deterministic review gate.

## Long-Term Memory

The first memory slice is intentionally conservative and app-server local:

- Persist accepted memory items under `.crewon/office-memory/index.json`.
- Scope memory by `officeKey`, using `config.id`, else `workspace.threadId`, else a title slug.
- Store memory fields as structured data: `scope`, optional `member`, optional `agentId`, `kind`, `content`, `confidence`, `importance`, `status`, `evidenceRefs`, `keywords`, timestamps, and usage counters.
- Retrieve only `accepted` memory items for prompts. `pending` and `rejected` items can be stored as audit state but are not injected. Model-authored candidate memories always enter as `pending`, even when the model labels them `accepted`; only `office/memory/decide` can promote a memory into accepted prompt context.
- Expose `office/memory/list` and `office/memory/decide` so clients can review pending model-authored memory candidates and move each item between `accepted`, `pending`, and `rejected` without editing the JSON index by hand.
- Memory governance views should show the same bounded provenance that prompts use: scope, kind, member/agent identity, confidence, evidence run/thread/turn refs, usage count, last-used timestamp, and keywords. This keeps long-term memory auditable instead of becoming an invisible prompt-injection channel.
- Select memories with a composite score that keeps keyword overlap with the current user request or delegated task as the dominant signal, then applies audience relevance, model-provided importance, confidence, bounded usage count, and recency as tie-breakers. Keyword extraction supports ASCII words plus compact-script bigrams for Chinese/Japanese/Korean text, and duplicate identity normalization is Unicode-aware, so non-English Office memory does not degrade to pure recency ranking or collapse unrelated facts.
- For manager prompts, inject only shared scopes: `office`, `project`, and `user`.
- For member prompts, inject shared scopes plus `member` scoped memories whose `member` or `agentId` matches the dispatched member. `sharedOnly`/`officeOnly` style member runtime policies suppress member-private memory injection while still allowing shared memories.
- Attach selected or newly written memories to the Office run or delegation as `memoryRefs` so clients can show why a run or member task had prior context.
- Do not persist full child-agent transcripts in Office config. Child thread rollout remains the authoritative private execution history.

This is not the final semantic memory system. It is a production-usable stage that proves the closed loop:

1. A run can use bounded prior memory.
2. A run can produce structured candidate memory through `officeUpdate.memories`.
3. Backend sync can persist and cite that memory without growing `crewon-core` or the Office JSON transcript.
4. A client can list and decide memory status explicitly, which gives the product a review surface before relying on model-authored facts.

Future memory storage can replace the JSON index with the existing state DB or a vector-backed retrieval layer without changing the run-level semantics.

## API

### `office/run`

Params:

```ts
{
  cwd: string;
  config: JsonValue;
  message: JsonValue;
  text: string;
  locale?: string | null;
  threadId?: string | null;
  clientUserMessageId?: string | null;
}
```

Response:

```ts
{
  filePath: string;
  config: JsonValue;
  threadId: string;
  runId: string;
  turn: Turn;
}
```

Validation:

- `config.workspace` must exist.
- `text` must not be empty.
- `message` must be an object.
- `workspace.threadId` or `params.threadId` must be set.
- If both are set, they must match.

### `office/run/sync`

Params:

```ts
{
  cwd: string;
  config: JsonValue;
  runId?: string | null;
  turn: Turn;
  locale?: string | null;
}
```

Response:

```ts
{
  filePath: string;
  config: JsonValue;
}
```

Behavior:

- Finds the run by `runId`, or by `turn.id` matching a saved run `turnId`.
- Reads the latest saved Office record for the matching thread/run before applying the reducer, so a stale client snapshot does not erase newer Office members, artifacts, or messages.
- Rejects mismatched `turn.id` when the run already has a different `turnId`.
- If `turn.id` matches a member delegation under the requested run instead of the manager run `turnId`, applies the member delegation reducer rather than failing the parent run turn check. This lets clients reconcile member-thread completion notifications through the same `office/run/sync` API.
- Maps turn status into durable office state:
  - `Completed` -> run `completed`, task `done`.
  - `Failed` -> run `failed`, task `todo`.
  - `Interrupted` -> run `interrupted`, task `todo`.
  - `InProgress` -> run `running`, task `doing`.
- Extracts the last loaded agent message as a bounded `resultPreview`.
- Appends one terminal Office system message per run, deduped by `runId`.
- The app-server terminal-turn listener calls the same reducer automatically for saved Office configs in the thread cwd, with a hard scan cap.

Structured reducer:

- Reads the last agent message and extracts a fenced JSON object under `officeUpdate`, `office_update`, or `office`.
- Updates `workspace.goal` from `goal`, `goalUpdate`, or `goal_update`.
- Upserts bounded tasks and artifacts, preserving the office JSON model the frontend already consumes.
- Stores run-level `plan` either from turn plan items or structured JSON.
- Stores run-level `acceptanceCriteria`, `evidence`, and `risks` from structured JSON, with bounded item counts and duplicate suppression.
- Stores bounded evidence from real command and file-change turn items, so `loop.review` can use observed tool facts in addition to model-authored `officeUpdate.evidence`.
- Refreshes `loop.review` after signal changes. The review summarizes acceptance, evidence, and high-risk counts, and assigns one of `passed`, `blocked`, `needsReview`, or `incomplete` plus a `nextAction` such as `readyToSummarize`, `repairFailedCriteria`, `collectVerificationEvidence`, `mitigateHighRisks`, or `frameAcceptanceCriteria`.
- Stores run-level `delegationRoutes` as the bounded member-runtime routing contract for each run.
- Stores run-level `delegations` either from structured JSON or observed multi-agent/sub-agent turn items, and enriches structured delegations with matching route targets.
- Stores model-authored long-term memory candidates from `officeUpdate.memories` in `.crewon/office-memory/index.json`; every model-authored candidate is stored as `pending` regardless of the requested status, and only `office/memory/decide` can move it to `accepted` or `rejected`.
- Attaches new memory citations to `workspace.activity.runs[].memoryRefs`.

### `office/run/cancel`

Params:

```ts
{
  cwd: string;
  config: JsonValue;
  runId: string;
  threadId?: string | null;
  turnId?: string | null;
  locale?: string | null;
}
```

Response:

```ts
{
  filePath: string;
  config: JsonValue;
}
```

Behavior:

- Resolves the latest saved office config by run index before trusting client state.
- Rejects terminal runs and runs without a known `turnId`.
- Submits interrupts without borrowing the JSON-RPC response path used by `turn/interrupt`.
- Interrupts the manager run turn plus any known active member delegation turns and active automation verification turns under the same run.
- Marks the run `canceling` and matching child rows `canceling` only after interrupt submission succeeds. Later terminal manager/member/automation sync writes `interrupted`.

### `office/delegation/cancel`

Params:

```ts
{
  cwd: string;
  config: JsonValue;
  runId: string;
  delegationId: string;
  threadId?: string | null;
  turnId?: string | null;
  locale?: string | null;
}
```

Response:

```ts
{
  filePath: string;
  config: JsonValue;
}
```

Behavior:

- Resolves the latest saved office config by run index before trusting client state.
- Requires a matching `delegationId` under the requested run.
- Rejects terminal delegation states and delegations without a saved `threadId` and `turnId`.
- If the caller supplies `threadId` or `turnId`, validates them against the saved delegation binding.
- Interrupts only the target member delegation turn.
- Marks only that delegation `canceling`; the parent manager run and sibling child rows keep their current status until their own turns terminally sync.

### `office/verification/cancel`

Params:

```ts
{
  cwd: string;
  config: JsonValue;
  runId: string;
  verificationCheckId: string;
  threadId?: string | null;
  turnId?: string | null;
  locale?: string | null;
}
```

Response:

```ts
{
  filePath: string;
  config: JsonValue;
}
```

Behavior:

- Resolves the latest saved office config by run index before trusting client state.
- Matches `verificationCheckId` against the verification check `itemId`, `automationRunId`, `automationId`, or check text.
- Requires an active automation verification dispatch with saved `automationThreadId` and `automationTurnId`.
- If the caller supplies `threadId` or `turnId`, validates them against the saved automation binding.
- Interrupts only the target automation verification turn.
- Marks only that verification check `dispatchStatus: "canceling"` and `automationStatus: "canceling"`; the parent manager run, sibling delegations, and sibling verification checks keep their current status.

### `office/verification/retry`

Params:

```ts
{
  cwd: string;
  config: JsonValue;
  runId: string;
  verificationCheckId: string;
  locale?: string | null;
  clientUserMessageId?: string | null;
}
```

Response:

```ts
{
  filePath: string;
  config: JsonValue;
  runId: string;
  verificationCheckId: string;
  automationId: string;
  automationRunFilePath: string;
  automationRunId: string;
  retryOfAutomationTurnId: string | null;
  threadId: string;
  turn: Turn;
}
```

Behavior:

- Resolves the latest saved office config by the run index while holding the Office dispatch claim lock.
- Requires a source verification check with an `automationId` and a failed or interrupted `status`, `dispatchStatus`, or `automationStatus`.
- Rejects active queued, running, or canceling automation verification checks so multi-client clicks cannot start duplicate automation turns.
- Archives the previous bounded automation run file, run id, thread id, turn id, status, dispatch status, automation status, error, and evidence into `attempts`, capped at 6 entries.
- Resets the same semantic check row to `status: "pending"` and `dispatchStatus: "queued"` instead of appending a duplicate check that would skew acceptance/verification counts.
- Starts the saved automation through `automation/run/start` with a retry note that includes bounded previous status, dispatch status, turn id, error, and evidence summary.
- Marks the same check `running` with the new `automationRunId`, `automationThreadId`, and `automationTurnId`, or `failed` with a bounded startup error if automation startup fails.

### `office/run/retry`

Params:

```ts
{
  cwd: string;
  config: JsonValue;
  runId: string;
  message?: JsonValue | null;
  text?: string | null;
  locale?: string | null;
  clientUserMessageId?: string | null;
}
```

Response:

```ts
{
  filePath: string;
  config: JsonValue;
  threadId: string;
  runId: string;
  turn: Turn;
}
```

Behavior:

- Resolves the latest saved office config by the run index.
- Uses supplied `text` when present.
- Otherwise, if the source run has a `loop.review` status other than `passed`, generates a Loop continuation prompt from `review.nextAction`, failed or pending acceptance criteria, blocked or unverified evidence, and open high risks.
- Falls back to the original run `requestText`, else `promptPreview`.
- Creates a new run with `retryOf`, indexes it, starts a fresh turn, and returns the new turn.

### `office/delegation/dispatch`

Params:

```ts
{
  cwd: string;
  config: JsonValue;
  runId: string;
  task: string;
  member?: string | null;
  agentId?: string | null;
  locale?: string | null;
  clientUserMessageId?: string | null;
}
```

Response:

```ts
{
  filePath: string;
  config: JsonValue;
  runId: string;
  delegationId: string;
  threadId: string;
  turn: Turn;
}
```

Behavior:

- Resolves the latest saved office config by the run index.
- Requires non-empty `runId`, non-empty `task`, and either `member` or `agentId`.
- Matches the target against the run's bounded `delegationRoutes`; routes are generated from saved Office members with durable runtime threads.
- Claims a matching planned delegation row into a queued record with `dispatchMethod: "turnStart"`, or appends a new queued delegation record when no matching planned row exists.
- Rejects duplicate dispatch when the matching delegation is already queued, running, completed, or otherwise tied to an existing `turnId`; a startup-failed delegation without `turnId` can be re-queued for another start attempt.
- Serializes the claim against the latest saved Office config, so stale clients and multi-clicks cannot start duplicate turns for the same planned member task.
- Starts a normal `turn/start` on the member runtime thread, preserving existing permissions, approvals, sandbox, and streaming semantics.
- Marks the delegation `running` with the returned member `turnId`, or `failed` with a bounded startup error if member turn start fails. These writes re-read the latest saved Office config before saving so unrelated delegation updates are preserved.
- Terminal member turn events are auto-synced back into the saved Office config by matching delegation `turnId`; the parent run remains active or terminal according to its own manager turn. Member `officeUpdate.tasks`, `officeUpdate.artifacts`, `officeUpdate.acceptanceCriteria`, `officeUpdate.evidence`, `officeUpdate.risks`, and `officeUpdate.memories` are merged through the same bounded reducer used by manager runs, while `goalUpdate` and delegation-list ownership stay with the manager turn.

### `office/delegation/dispatch/next`

Params:

```ts
{
  cwd: string;
  config: JsonValue;
  runId: string;
  dispatchPolicy?: "interactive" | "auto" | null;
  locale?: string | null;
  clientUserMessageId?: string | null;
}
```

Response:

```ts
{
  filePath: string;
  config: JsonValue;
  runId: string;
  delegationId: string;
  threadId: string;
  turn: Turn;
}
```

Behavior:

- Resolves the latest saved office config by the run index.
- Scans the requested run's planned `delegations` in order.
- Skips delegations that already have a `turnId`, are already `turnStart` queued/running/completed, are terminal, blocked, skipped, or lack a non-empty task.
- Defaults to `dispatchPolicy: "interactive"` for user-triggered controls.
- When `dispatchPolicy: "auto"` is supplied for background scheduler ticks, additionally skips delegations marked `approvalRequired`, `requiresApproval`, `manualDispatch`, `dispatchMode: "manual"`, or high risk via `riskSeverity`, `severity`, or `risk`.
- Requires either `member` or `agentId` and a matching route in the run's bounded `delegationRoutes`.
- Selects while holding the dispatch claim lock, so a stale client snapshot skips rows already claimed by another request and can move on to the next eligible delegation.
- Starts the selected delegation through the same prompt construction, memory retrieval, `turn/start`, and failure-marking path as explicit `office/delegation/dispatch`.
- Returns `invalid_params` when no dispatchable delegation exists, so clients can show the run as up to date rather than guessing from stale state.

### `office/delegation/retry`

Params:

```ts
{
  cwd: string;
  config: JsonValue;
  runId: string;
  delegationId: string;
  locale?: string | null;
  clientUserMessageId?: string | null;
}
```

Response:

```ts
{
  filePath: string;
  config: JsonValue;
  runId: string;
  delegationId: string;
  retryOfDelegationId: string;
  threadId: string;
  turn: Turn;
}
```

Behavior:

- Resolves the latest saved office config by the run index while holding the Office dispatch claim lock.
- Requires a source delegation with status `failed` or `interrupted`; active, completed, queued, running, canceling, blocked, skipped, or unroutable rows are not retryable through this API.
- Rejects duplicate active retry rows for the same source delegation when a previous retry is still `queued`, `running`, or `canceling`.
- Resolves the saved member route again by `member` or `agentId`, retrieves the same bounded member memory context, and appends a new queued delegation row with `retryOf`.
- Starts a normal member runtime `turn/start` using a retry prompt that includes the original task plus bounded previous status, `turnId`, error, and result preview. The source row remains unchanged for auditability.
- Marks the new delegation `running` with the returned member `turnId`, or `failed` with a bounded startup error if member turn start fails.

## Frontend Integration Plan

Recommended frontend flow:

1. If an office has no `workspace.threadId`, call `thread/start` for the office and persist the returned thread id via `office/create` or `office/save`.
2. When the user sends an office message, call `office/run` instead of `office/message/send` for executable messages.
3. Update local office state with `OfficeRunResponse.config`.
4. Subscribe to `office/run/updated` and replace the local Office record for the matching `cwd`/`filePath` with the notification `config`. The Office panel retains the saved `configPath`, so notification matching should prefer the exact `filePath`, then fall back to `workspace.threadId`. Title/subtitle matching is only a compatibility fallback for pre-bound or legacy panels and should not become the long-term identity model for executable Offices.
5. Open or subscribe to `OfficeRunResponse.threadId`.
6. Track `OfficeRunResponse.turn.id` through existing `turn/started`, `item/*`, and `turn/completed` notifications.
7. The backend will sync terminal states automatically and emit `office/run/updated`. `office/read`, `office/list`, `thread/read`, and `thread/list` also recover stale non-terminal Office rows or pending scheduler work from persisted thread history before or alongside normal responses. The frontend may still call `office/run/sync` on `turn/started` for active state refresh and after client refresh; use `thread/read(includeTurns=true)` or `thread/turns/list`, match saved run `turnId`s, and call `office/run/sync` again.
   Do not treat `office/run/updated` as a request to register new frontend-owned turn tracking for backend auto-dispatched child turns. Those child turns already carry `threadId` / `turnId` in the Office config for display and deep links; their completion lifecycle is backend-owned through the listener, recovery, and completion monitor paths.
8. Render `workspace.activity.runs[0]` as the office run banner and link it to the turn transcript.
9. Call `office/run/cancel` for active run rows with a known `turnId`; show `canceling` until terminal sync updates the row.
10. Call `office/delegation/cancel` or `office/verification/cancel` for active child rows with known child `threadId`/`turnId`; show only that row as canceling and keep the parent run visible as running unless the manager turn itself is canceled.
11. Call `office/run/retry` for failed, interrupted, or completed rows; register the returned turn just like `office/run`.
12. Call `office/delegation/dispatch` for a specific planned delegation row when the user chooses a member task directly.
13. Call `office/delegation/dispatch/next` from a run-level "dispatch next" control or scheduler tick when the client wants the backend to pick the next eligible member task.
14. Call `office/delegation/retry` from failed or interrupted delegation rows; register the returned member turn like dispatch, keep the original delegation row visible, and render the new retry row with `retryOf` provenance.
15. Call `office/member/context/preview` from member details, dispatch confirmation, or troubleshooting panes when the UI needs to show the exact bounded shared context and memory context a member route would receive. Treat this as a read-only audit path; it should not register a turn or mutate local run state.
16. When `loop.review.nextAction` is `runVerificationChecks` and the run has a pending check with `automationId`, call `office/verification/dispatch/next` for an explicit user-triggered run before falling back to `office/run/retry`, or let the backend safe scheduler start it after terminal manager/member/verification sync. For command-only checks, fall back to `office/run/retry` so the manager can run the command through the normal tool/approval path. The client should label this path as "Run checks" / "Running checks" rather than a generic retry so users can distinguish verification execution from repair.
17. Call `office/verification/retry` from failed or interrupted automation-backed verification check rows; register the returned automation turn like verification dispatch, keep the same check row visible, and render `retryOfAutomationTurnId` / bounded `attempts` as retry provenance instead of creating duplicate check rows.
18. Backend auto re-plan does not require a new frontend request. Apply `office/run/updated` with `reason: "autoReplanStarted"` as the latest Office config snapshot; the new manager retry run carries `retryOf`, `threadId`, `turnId`, and incremented `loop.iteration`. Visible clients may register the notification source turn for UX refresh, but completion remains backend-owned through the listener, recovery, and completion monitor paths.
19. Register the returned member or automation `turn.id` through the normal thread event stream.
19. Use `office/memory/list` to render pending/accepted/rejected long-term memory rows and `office/memory/decide` to accept or reject pending model-authored candidates.
20. Keep `office/message/send` for non-executing local workspace updates or backward compatibility.

Suggested UI mapping:

- `queued`: optimistic pending row.
- `running`: active run row with spinner and `turnId`.
- `canceling`: disabled cancel button and pending terminal sync.
- `completed`: done row with `resultPreview`.
- `failed` or `interrupted`: retryable row with error/status detail.
- `plan`: compact checklist under the run row.
- `delegations`: compact member/agent/task chips under the run row, with a child cancel control only when the delegation has a real `threadId` and `turnId`, and a retry control for failed or interrupted rows with a stable `delegationId`.
- `verificationChecks`: compact check rows under the run row, with a child cancel control only for active automation-backed checks with real `automationThreadId` and `automationTurnId`, and a retry control for failed or interrupted automation-backed checks with a stable `itemId`.
- `memoryRefs`: compact memory chips or an expandable "used memory" section under the run row.
- `loop.review`: compact review chip showing pass/block/review state, acceptance pass count, verified evidence count, open high-risk count, and next action.
- `loop.stopConditions`: compact completion-gate chips showing which deterministic stop conditions are met and which still block a verified finish.
- `evidence`: compact evidence rows. For model-authored rows, show status, summary, and source. For tool-derived rows with `evidenceKind`, also show command/file-change kind, command text or touched paths, exit code, duration, output preview, short `outputSha256` / `changesSha256` fingerprints, `sourceTurnId`, and member/delegation identity when present.
- `artifacts`: compact artifact rows with title/kind/meta plus optional path or URL, inline content fingerprint, source turn, and member/delegation provenance when present.
- turn stream: transcript panel, task activity, tool call timeline.
- failure from `office/run`: show the saved failed run if response error occurs after queue save.
- missing notifications: terminal state should already be server-synced; re-read thread turns and call `office/run/sync` to reconcile any client-visible gaps. Terminal messages are deduplicated by `runId`.

Implemented frontend slice:

- `ActivityBoard` renders `workspace.activity.runs` as a team-run panel with status, `turnId`, result/error preview, and update time.
- `ActivityBoard` renders structured reducer output: run goal, plan, evidence, delegations, cancel/retry actions.
- Tool-derived evidence rows expose command/file-change metadata and reducer provenance without opening member-private transcripts.
- Artifact rows expose path/URL, short content fingerprint, and reducer provenance without loading full artifact contents into the Office board. Opening an artifact also shows the backend content record alongside the current file metadata: content status/source, full `contentSha256`, byte count, observed time, path/URL, producer, delegation, source thread, and source turn when present. For file reads, the frontend computes the current file SHA-256 from the returned bytes and flags whether it matches or differs from the backend record, so users can spot artifact drift without opening raw turn history.
- The Office send path calls `office/run` when available and falls back to `office/message/send` for older app-servers.
- The Office activity path calls `office/run/cancel` and `office/run/retry` when available.
- The Office activity path also calls `office/delegation/cancel` and `office/verification/cancel` for active child rows. The UI shows these controls only when the child row has a saved thread/turn binding, and successful responses sync the panel from the backend Office config instead of locally rewriting the parent run.
- The Office activity path calls `office/delegation/retry` for failed or interrupted member rows. The UI shows a row-level Retry action, records the returned member turn, and keeps the retry linked to the source row through `retryOfDelegationId`.
- The retry action uses review-aware text and relabels actionable reviewed runs as repair or continue-loop instead of a generic retry.
- Run rows render backend-derived `loop.stopConditions` as a visible completion gate, so users can see whether acceptance framing, verification, evidence collection, high-risk cleanup, iteration limits, and retry budget currently permit a verified stop.
- The frontend app-server client exposes `dispatchOfficeDelegationConfig`, and `domainOfficeBackend` exposes `dispatchAppOfficeDelegation` for member runtime dispatch.
- The frontend app-server client exposes `previewOfficeMemberContextConfig`, and `domainOfficeBackend` exposes `previewAppOfficeMemberContext` for read-only member context audits before dispatch or while debugging route configuration.
- The Office member rail now exposes a read-only member context preview control when a run exists. It calls `office/member/context/preview` through the app runtime handler and renders the resolved context policy, memory scope, target thread, bounded shared digest, and bounded long-term memory context without registering a member turn.
- The frontend app-server client and domain helper expose `dispatchPolicy` on next-delegation dispatch. The visible run-level "Dispatch next" control omits it and therefore uses interactive semantics, while a later background scheduler tick can pass `"auto"` to skip manual-approval and high-risk rows.
- The frontend app-server client exposes `dispatchNextOfficeVerificationConfig`; the Office retry action routes `runVerificationChecks` to it when a pending undispatched `automationId` check exists, records the returned automation turn, and avoids starting a manager retry in that successful path. If no dispatchable automation check exists, it falls back to review-aware `office/run/retry`. The UI labels this action "Run checks" and the busy state "Running checks" to keep verification distinct from repair/retry. The backend scheduler can also start the same automation verification path automatically and emits `office/run/updated` with `reason: "autoVerificationStarted"`.
- The frontend app-server client exposes `retryOfficeVerificationConfig`; failed or interrupted automation-backed verification check rows show a row-level Retry action, record the returned automation turn, keep the check row linked to the prior attempt through `retryOfAutomationTurnId`, and let terminal automation sync overwrite the check with fresh evidence.
- Bound automation run actions now target the Office execution loop directly: when an automation config has a `targetOffice.workspace.threadId`, the frontend calls `office/run` on that Office thread, records the returned Office turn in the normal Office run tracker, and still writes an `automation/run` record keyed to the same turn so automation history and Office activity reconcile from one execution.
- The app-server terminal listener, explicit `office/run/sync`, backend completion monitor, and frontend turn completion paths all call safe auto-dispatch after successful Office run sync. This gives the first production scheduler loop without adding a separate durable worker: manager plans safe tasks, completion sync reconciles state, auto-dispatch starts the next safe member turn, automation verification runs next when needed, and review-gated auto re-plan starts the next manager iteration only after member and verification work have no dispatchable work.
- App-server emits `office/run/updated` for run start, retry, cancel, child cancellation, explicit sync, terminal sync, persisted-history recovery, runtime route repair, thread-surface scheduler recovery, delegation start, delegation retry start, verification start, verification retry start, auto-verification start, auto-replan start, and auto-dispatch completion so clients can keep the Office board current without polling. The frontend app-server event handler consumes this notification directly and updates the currently visible matching Office panel by exact `configPath` / notification `filePath` first, then `workspace.threadId`, with title/subtitle only as a legacy fallback. Backend auto-dispatch, auto-replan, history recovery, runtime repair, and automation-verification updates therefore do not have to wait for a turn-completion refresh path.
- The turn completion notification path calls `office/run/sync` for visible reconciliation of both manager turns and member delegation turns. The backend terminal listener and the non-consuming member completion monitor remain the server-side completion paths.
- Delegation responses keep the visible Office panel bound to the office main thread while tracking the active member turn under the member runtime thread.
- Run rows show run-level memory refs, and delegation rows show member-task memory refs with scope, kind, member/agent identity, and bounded content. This makes the shared manager context and member-scoped context visible without exposing private member transcripts.
- The Office workspace view has a Memory tab backed by `office/memory/list` and `office/memory/decide`, so pending model-authored memories can be reviewed without editing `.crewon/office-memory/index.json` directly. Accepted and rejected rows can also be moved back to pending or switched to the opposite decision, giving users a correction path for long-term memory governance. Rows display scope, kind, member/agent identity, confidence, evidence run/thread/turn refs, usage count, last-used timestamp, and keywords. The tab uses the API cursor to load additional memory pages instead of silently limiting governance to the first page.

## Future Backend Stages

1. Supervisor graph
   - Add a deterministic office planner step that can choose: direct answer, implementation, research, review, or parallel delegation.
   - Keep graph state in office runs, not core session context.

2. Richer verification model
   - Add product policy controls for which automation verification checks may run automatically versus requiring an explicit user-triggered `office/verification/dispatch/next`.
   - Keep free-form member transcript private and only merge bounded structured outputs.

3. Deeper member-aware delegation
   - First slice implemented: member dispatch prompts now include a bounded saved-agent profile summary derived from role, instructions, policy, skills, and tools when available.
   - Second slice implemented: member dispatch applies `contextPolicy` as a real prompt-context boundary (`sharedDigest`, `forkLastN`, or `isolated`) instead of merely displaying the policy string.
   - Startup worker implemented for bounded Office recovery. Member runtime route repair is now implemented for saved Agent members whose cold-loaded target thread has no readable persisted rollout: app-server creates a replacement runtime thread, updates the Agent config and Office route ledger, emits `runtimeRepair`, and then dispatches the pending safe delegation. Automation verification runtime route repair is also implemented for saved automation configs whose target thread is missing, unmaterialized, or has no readable rollout: app-server creates a replacement automation runtime thread, updates the automation config, carries `runtimeRepairSourceThreadId` / `runtimeRepairedAt` onto the verification check, and then starts the pending safe verification turn. Live in-process member runtime threads are preserved; freshly repaired automation runtime threads are preserved for their first verification turn.
   - Keep these policies bounded instead of introducing a full-history fork unless a later product requirement justifies the extra context cost.

4. Background runs and automations
   - First slice implemented: manual automation run actions with a bound target Office thread now call `office/run` and keep `automation/run` history for the same turn. Remaining background work is schedule/event-triggered Office runs that fire without a visible library click.
   - Per-child cancellation is implemented for active member delegations and automation verification checks. Per-child retry is implemented for failed or interrupted member delegations and failed/interrupted automation verification checks. Remaining policy work is schedule/event-triggered Office runs that fire without a visible library click.

5. Durable scheduler recovery
   - First slice implemented: terminal Office sync writes scheduler intents to `.crewon/office-runs/scheduler.json`, explicit `office/run/sync` and live auto-dispatch attempt the safe scheduler path immediately, successful dispatch marks intents dispatched, and `office/read` / `office/list` drain pending intents before fallback scanning.
   - Startup slice implemented: app-server initialization runs a bounded background recovery over `$CODEX_HOME/office-scheduler/workspaces.json` plus recently updated thread cwds, cold-loads resumable target runtime threads and review-gated manager source threads, repairs empty saved member runtime routes, dispatches safe pending member/verification/re-plan work, and polls briefly for newly started child or retry turns so the Office ledger can reach a terminal state without a frontend Office read.
   - Auto re-plan slice implemented: after safe member delegation and automation verification have no dispatchable work, the scheduler can start a bounded manager retry from `loop.review` when retry budget remains and no existing retry, active child, missing acceptance frame, high-risk, manual, approval, or runnable-verification gate is open.
   - Remaining durable gap: this still does not keep model execution alive while app-server is stopped; it resumes persisted terminal work once app-server is running again.

## Self Review

Alignment checks:

- Latest architecture alignment: yes. The design uses durable orchestration plus bounded agentic execution, matching Anthropic/LangGraph/AutoGen/CrewAI direction. The important alignment is not just multi-agent routing; it is managed-agent state, context curation, interruption/recovery, and verification evidence.
- Real execution: yes. V1 starts a normal Crewon turn.
- Permissions: yes. Execution stays inside the existing thread runtime.
- Human-in-loop: yes. Existing approvals remain in the normal event path.
- Bounded context: yes. Office prompt input has explicit caps.
- Long-term memory: second slice implemented. Accepted Office memories are retrieved into prompts with caps and evidence refs; structured `officeUpdate.memories` writes back into a separate Office memory index, missing or invalid memory status defaults to `pending` to prevent accidental memory poisoning, and retrieval scoring combines relevance, audience, importance, confidence, usage, and recency while keeping relevance dominant.
- Loop Engineering alignment: stronger. Runs now carry loop metadata, the prompt requires frame, plan, delegate, act, observe, verify, and summarize, the backend derives a deterministic `loop.review` gate from acceptance/evidence/risk signals, tool-derived command/file-change evidence participates in that review, and explicit or automatic retry can start the next Loop iteration from that gate only while `hasRetryBudget` remains true. A deterministic background supervisor graph is still future work.
- Scheduler alignment: improved. The deterministic scheduler step now covers safe member delegation first, safe automation verification second, and bounded review-driven manager re-plan last, including runtime-route repair for missing member or automation targets and persisted manager-thread loading before dispatch. App-server terminal listeners, persisted-history recovery, startup workspace-index recovery, thread-surface cwd recovery, backend member/automation/manager-replan completion monitors, frontend completion sync, and persisted scheduler intents trigger safe scheduler ticks after Office completion sync. Fully durable worker scheduling that can keep model execution alive while app-server is stopped remains future work.
- Avoids `crewon-core` growth: yes. New logic lives in app-server.
- Frontend compatibility: yes. Current office JSON remains compatible; new `activity.runs` fields are additive and ActivityBoard renders them.
- Artifact traceability: yes for the current slice. Backend artifact rows store source provenance and bounded inline/file content observations, the Office board shows compact fingerprints, and the artifact detail panel exposes the full backend content record plus the current read hash comparison so users can compare the saved observation with the loaded workspace file metadata.
- Completion durability: yes for live app-server processes and for restart/listener-miss cases where terminal turns were already persisted. Terminal turns are synced back into matching Office configs server-side through the run index first and bounded scan fallback, and completed sync writes a persisted scheduler intent before safe member, automation verification, or manager re-plan dispatch is attempted. Auto-dispatched member, automation verification, and manager re-plan turns additionally have a non-consuming completion monitor that reads terminal status/history without depending on frontend subscription. App-server startup, `office/read`, `office/list`, `thread/read`, and `thread/list` recover stale non-terminal Office rows from persisted terminal turns, drain pending scheduler intents, and scan terminal Office JSON rows with safe pending delegations, automation verification checks, or review-gated re-plan work, while `office/run/sync` remains as an explicit recovery path. Startup recovery can cold-load target member runtime threads with persisted rollout history, repair saved member routes whose cold-loaded target thread has no readable persisted rollout, repair saved automation verification routes whose target thread is missing or unmaterialized, and cold-load persisted Office manager threads before starting review-gated auto re-plan. Keeping active model execution alive while app-server is stopped remains the durable-worker stage.
- Multica alignment: yes. The Office run model has explicit task lifecycle state, real execution on owned runtime, visible progress through existing thread events, and durable status updates for the frontend board.
- Operability: yes for the current live app-server slice. Users can cancel whole active runs, cancel one active member delegation or automation verification child turn without stopping the rest of the team, retry terminal manager runs, let the scheduler auto-start safe review-gated manager re-plan runs, retry failed or interrupted member delegations as new child turns, retry failed or interrupted automation verification checks as new bounded attempts on the same check row, and clients receive first-class `office/run/updated` notifications for Office board state changes.
- Member-private context: second slice implemented. `office/member/add`, `office/run`, and `office/run/retry` resolve saved Agent `threadId` and bounded saved-agent profile into member runtime metadata, snapshot bounded `delegationRoutes`, expose exact route targets and profile hints in the prompt, and enrich run delegations with those route targets.
- Deterministic member dispatch and retry: implemented. `office/delegation/dispatch` validates a saved run route, claims planned delegation rows instead of duplicating them, rejects duplicate active dispatches, starts a normal turn on the member runtime thread, and records queued/running/failed delegation state. `office/delegation/retry` accepts only failed or interrupted source rows, writes a new `retryOf` child row instead of overwriting the source, and starts a fresh member turn with bounded prior failure context. Terminal member turns auto-sync bounded result/error, acceptance, model-authored evidence, tool-derived command/file-change evidence, risk, task, artifact, and memory state back into the parent Office run without injecting private member history into the Office prompt.
- Member failure handling: covered. Failed and interrupted member turns mark the delegation terminal, leave the manager run bound to the original manager `turnId`, move the delegated task back to `todo`, and append one deduplicated Office system message without copying member-private transcript content.
- Frontend completion reconciliation: implemented. The client records manager and member turn ids, loads full turns on `turn/completed`, calls `office/run/sync`, and refreshes the visible Office panel without rebinding it to member runtime threads.

Decision:

- Proceed with indexed `office/run`, `office/run/sync`, `office/run/cancel`, `office/run/retry`, and `office/delegation/dispatch` as the production-capable slice for Office team execution.
- Do not introduce a new Rust crate yet; current scope is app-server orchestration.
- Do not add a second multi-agent runtime; reuse `AgentControl` through the model-visible tools.
