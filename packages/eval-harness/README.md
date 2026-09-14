# Team effect evaluation harness

This package evaluates artifacts captured by a GUI test. It does not start the
product, call a product HTTP API, contact a model, or collect a trace itself.

The v1 workflow is deliberately ordered:

1. The case owns a case ID and revision, the original prompt, authored label
   order, answer-size limit, exact-content requirements, whether unlabelled text
   is allowed, and explicit efficiency limits. It also declares the exact
   expected Team member-ID set.
2. A GUI test submits that prompt and writes a
   `crewon.team-effect-gui-trace.v1` artifact after the UI reaches a terminal
   state.
3. `parseTeamEffectCase` and `parseTeamEffectGuiTrace` reject unknown versions,
   extra fields, non-GUI sources, and malformed provenance. Evaluation also
   requires the trace's case ID, case revision, and submitted prompt to match
   the case exactly after NFC normalization.
4. `evaluateTeamEffectQuality` checks required decision, evidence, conflict,
   and unknown sections; per-label minimum content; exact decisions; authored
   order; answer length; unexpected unlabelled lines; duplicate user messages;
   visible UI errors; and pending state.
5. `compareTeamEffectVariants` compares work and latency only when both traces
   pass the same correctness gate, use the same harness version and GUI
   collector, and every member stays in the same model cohort. It reports
   `efficiencyFailures` for authored regression and minimum-improvement limits,
   and rejects comparing a trace ID with itself. Missing measurements remain
   unknown (`null`) and do not become fabricated values or zeroes.

## Execution observation v2

`crewon.team-effect-execution-observation.v2` is an optional sidecar, not an
implicit upgrade of the v1 GUI trace. Existing v1 fixtures, CLI commands,
quality gates, and comparisons keep their current behavior. Before attributing
v2 work to a v1 result, call
`requireMatchingTeamEffectExecutionObservationV2`; it requires the same trace
ID, GUI collector, and capture timestamp.

The sidecar keeps each execution layer separate:

```text
user turn
  -> CrewON Run (run kind, Team phase, execution authority)
    -> durable Attempt
      -> provider invocation (initial, tool continuation, recovery, or sampling retry)
```

A sampling retry is a new provider invocation inside the same durable Attempt;
it is not silently counted as another Run. `firstDeltaMs`, `maxDeltaGapMs`,
reconnect count, truncation, provider receipt fields, and token usage belong to
that invocation. `summarizeTeamEffectDeltaTimeline` derives the two delta
timings only from explicit monotonic collector timestamps.

Unknown data must be written as `null`; it is never inferred from another
layer. In particular, a provider-owned Agent may expose one outer invocation
while keeping `providerInternalSteps` unknown. A nullable collection uses
`null` for an opaque layer and `[]` only when the collector actually observed
zero items. `summarizeTeamEffectExecutionObservationV2` propagates opacity to
dependent totals instead of reporting a misleading lower bound or zero.

Run the offline CLI against local JSON files. Filtered package scripts run from
this package directory, so use absolute paths for artifacts stored elsewhere:

```bash
pnpm --silent --filter @crewon/eval-harness evaluate -- /absolute/path/case.json /absolute/path/trace.json
pnpm --silent --filter @crewon/eval-harness compare -- /absolute/path/case.json /absolute/path/baseline.json /absolute/path/candidate.json
```

Results are JSON on stdout. Exit code `0` means the quality evaluation passed,
or that comparison was allowed without an efficiency-gate regression. Exit
code `1` means correctness failed, the measurement or model cohorts did not
match, no common efficiency metric was available, an enabled gate was missing
a baseline or candidate measurement, a measured metric exceeded its regression
limit, or it did not reach its required minimum improvement. Invalid arguments,
unreadable files, invalid JSON, reused trace identity, and schema violations use
exit code `2` and a structured error on stderr.

Lower values are better for every efficiency metric. A positive
`improvementPercent` means that the candidate used less work or time than the
baseline. Each 2–6-member Team records member and agent-version IDs, immutable
agent digest, provider, model, reasoning effort, and capability profile. Member
IDs are unique within a trace and must exactly match the case contract;
multiple members may correctly reuse the same AgentVersion. Prompt variant,
harness version, and build revision stay at the overall variant level. This
avoids pretending that a mixed-model Team used one provider or model and allows
results to be grouped instead of assuming one prompt works equally well for
every model. Efficiency attribution additionally requires the baseline and
candidate to use the same `harnessVersion` and declared GUI `collector`, then
match `providerId`, `modelId`, and `reasoningEffort` for each `memberId`; member
array order does not matter. AgentVersion, prompt variant, build revision, and
capability profile may differ because they can be the treatment under test.
Different models need separate baseline/candidate lanes and must not be compared
directly for efficiency.

## Opt-in GUI Run observation

Open the CrewON web UI with `?crewonTeamObserve=1` before submitting a Team
turn through the composer. This enables a bounded, read-only observer for that
tab. It listens to accepted CrewON Team Runs over Control SSE and writes the
latest 16 observations to the tab's `sessionStorage` key
`crewon.control-team-gui-observation.v1` and mirrors the same bounded JSON in
the hidden `#crewon-control-team-gui-observation` output element for GUI
automation that cannot access browser storage. It does not start a Run, call
PIM, or change any PIM Agent, API key, prompt, tool, or publication state.
Normal UI sessions do not open these observer connections.

The collector keeps one current Team observation per CrewON thread. A new turn
replaces a completed observation on that thread. If an earlier turn was
interrupted before its final Run settled, start the next measured case in a new
thread; otherwise the strict parser will fail closed rather than guess a turn
boundary.

The observation contains Run/phase placement, Control-SSE first-delta and
maximum inter-delta timing, reconnects, sampling retries, transport fallbacks,
provider continuations, token usage, and terminal state. These are delivery
measurements at the CrewON Control SSE boundary. They must not be relabelled as
the PIM/provider's own first-byte latency or internal Agent step count.

Use `parseControlTeamGuiObservations` to validate the JSON before keeping it as
evidence. `teamEffectEfficiencyFromControlTeamGuiObservation` exports the
matching v1 Run count, phase count, and settled duration. It deliberately leaves
`timeToFirstVisibleOutputMs` as `null`, because the observer starts at the first
accepted Run rather than the original composer submit gesture. The stricter
provider-invocation v2 sidecar remains separate; unknown PIM internals stay
`null`.

For a local Web concurrency canary, start the development stack with
`CREWON_CONTROL_DEV_RUNTIME_WORKER_COUNT=2`. The explicit setting accepts one
to eight workers and defaults to one. Workers receive distinct durable lease
owners, while only the primary worker exposes the provider-probe listener.
Treat worker count as a harness treatment: keep the prompt, case revision,
model cohort, and correctness gate fixed, and do not promote one provider/model
result into a production or workspace-wide default.

`certifyTeamEffectCapability` turns that warning into a fail-closed release
gate. A prompt/profile treatment needs at least three distinct case revisions,
fresh baseline and candidate trace IDs, the same candidate per-member provider,
model, and reasoning-effort cohort across the suite, and passing comparisons on
every case. Every candidate member must declare the target capability profile
and prompt variant. The authored `modelRunCount` and `logicalPhaseCount` gates
must both forbid regression and require a positive improvement. The result is
an offline readiness decision; it does not create or mutate an AgentVersion or
silently enable a production planning strategy. Certify each model cohort
separately, because a prompt that helps one model can regress another.

Each efficiency metric has nullable `maxRegressionPercent` and
`minImprovementPercent` fields. Set maximum regression to `0` to forbid a
measured regression. Set minimum improvement to a positive percentage when a
candidate must measurably reduce work or latency; `0` allows equality. A
`null` field disables that constraint. If either enabled constraint lacks a
baseline or candidate measurement, comparison emits `measurement_missing` and
the CLI fails closed. Missing values remain `null`; they are never converted to
zero. Non-null run count, phase count, and settled duration measurements start
at one; time to first visible output may be zero.

An authored label line has exactly this syntax: the configured label, one ASCII
space, then non-empty content with no leading or trailing whitespace. Thus
`证据A:: ...`, `证据A:...`, and `证据A:  ...` are invalid when the configured
label is `证据A:`. Exact-content checks do not trim output. Authored case text
and the evaluator's matching view use Unicode NFC, while the parsed trace keeps
the raw answer text unchanged as evidence.

The files under `fixtures/` are synthetic contract examples for unit tests;
they are not evidence of a real product run. Release decisions should use
fresh artifacts emitted by the GUI test collector. The deterministic fragment
and length checks are only a regression floor. Passing them does not establish
semantic sufficiency and is not a substitute for case-specific factual
assertions or an independent evaluator when semantic quality matters.
The trace's `capture.source` and `capture.collector` values are declarations
inside the JSON. This package does not authenticate the collector or prove that
the artifact was truly captured through the GUI; that trust must come from the
external test runner and artifact chain.

## Business-deliverable regression guards

`checkSeptemberMeetingNotice` checks the actual final notice from the September
GUI case, including the deadline added at human approval. Feed it the notice,
not the whole transcript or the verifier's `PASS`. It is a bounded,
case-specific lexical guard: unfamiliar phrasing and safety-flagged quotations
require human review, and matching keywords cannot rule out every contradiction.

`checkResourceSchedule` checks a human-normalized daily allocation against an
explicit case specification: capacity, work amounts, mandatory release scope,
next-workday testing dependency, and deadline. Check every alternative against
the original specification. For a what-if plan, record the proposed constraint
changes separately; the evaluator cannot infer them or the intended scope from
prose. The model does not need to adopt an evaluator-specific output format.

Both return `necessaryChecksPassed` and always set
`humanSemanticReviewRequired: true`. These offline guards do not approve an
in-product workflow or replace its verification node. Regression tests include
the real failed W1 draft, corrected W1-R2 final notice, negative mutations, and
O2 counterexamples where extra testers or reduced testing effort still cannot
remove the development dependency. Existing v1 certification rules are unchanged.
