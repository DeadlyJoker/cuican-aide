# 2026-09-07 CrewON compatibility evidence

This run treated PIM as an external contract. No PIM Agent, API setting, tool,
or API Key was created, edited, enabled, disabled, published, or deleted.
Product turns were submitted through the CrewON desktop GUI rather than by
calling the product HTTP API.

## Account bootstrap degradation

The desktop initially remained indefinitely on `正在连接企业账号与资源目录…`.
Its sequential bootstrap had no deadline around either the remote WeCom
configuration read or current-user/token restoration. After adding concurrent
five-second CrewON-side deadlines, a hard GUI reload left the spinner and
rendered the password-login surface with the stable message
`账号服务暂时不可用，请稍后重试。`. The returned WeCom-disabled explanation also
rendered, so the GUI evidence points to the current-user/token boundary rather
than the configuration read; no narrower network attribution is claimed. The
existing `admin` account then logged in successfully through the GUI. PIM
configuration was unchanged.

## Team quality regression

The existing four-member `设计交付组` Office was run with provider `aicuican`
and model `gpt-5.5`. The GUI accepted the prompt, showed `协作中`, reached a
completed state, and displayed one final manager answer. Completion occurred
between the 52-second and 72-second GUI observations; no narrower latency or
first-delta value is claimed because a real collector was not attached.

The prompt reused the release-conflict case from the 2026-09-03 evidence. The
answer contained exactly the required ten nonblank labelled lines, selected
`DECISION: NO-GO`, preserved both the AA11/BB22 and refund-test conflicts, did
not use `184/184` to cancel either blocker, and exposed no internal member,
AgentVersion, or Run identifiers. Manual review therefore passed the quality
floor, while the latency sample remains informational and is not a benchmark.

## Instrumented migration-readiness cases

The opt-in GUI observer was enabled with `?crewonTeamObserve=1`, and both
migration-readiness turns were submitted through the visible composer. The
observer consumed read-only CrewON Control SSE after each Team Run had already
been accepted. It did not submit turns or call PIM.

Revision `2026-09-07.1` intentionally remains failed evidence. The answer made
the correct `NO-GO` decision and explained the checksum, rollback, and
zero-downtime gaps, but the authored gate also demanded whitespace, words, and
minimum section lengths that the prompt had never required. Loosening the gate
after seeing the answer would have overfit the evaluator, so revision
`2026-09-07.2` instead states its output contract before execution and checks
stable factual fragments. Its GUI trace passes every deterministic gate.

Revision `2026-09-07.2` used three model Runs across two logical phases and
settled in 46,639 ms, with no recovery Run, reconnect, sampling retry,
transport fallback, or provider continuation. The planner and verifier emitted
439 and 371 Control-SSE output chunks. The final manager Run emitted only two
Control-SSE chunks and its first delta arrived 13,849 ms after that stream was
requested. This is Control delivery evidence, not the upstream provider or PIM
first-byte timing.

The planner and verifier Runs were accepted together, but the verifier's first
delta arrived only after the planner completed. Code inspection explains the
observation: the development supervisor starts one Runtime Worker process, and
that worker permits only one active drain/claim at a time. The current
three-Run/two-phase topology is already the minimum for this three-member
role-directed Office; reducing prompt rounds cannot remove this queue. Any
parallel-worker treatment must first define provider-rate limits and
per-workspace mutation isolation, then be compared on fresh GUI evidence. It
must not silently become a universal production default.

A bounded local-Web canary then started two Runtime Worker processes with
unique lease owners while retaining a single provider-probe listener. The same
revision `2026-09-07.2` prompt retained the correct `NO-GO` decision, the same
three-Run/two-phase topology, and no recovery or retry signals. Its planner and
verifier overlapped, and settled duration fell from 46,639 ms to 33,158 ms, a
28.9% reduction in this one matched sample. However, the strict quality gate
failed: `ACTION-1` contained 27 characters and `ACTION-2` contained 17, below
their pre-authored 28-character floors. The gate was not loosened and the run
was not repeated until it happened to pass. The switch is explicit and defaults
to one worker; this sample shows latency potential but is not a quality-safe
promotion result for this model, another provider/model, or a workspace.

## Certification and PIM SSE boundary

The new offline capability-certification gate evaluated the real 2026-09-03
GUI pair as `notCertified`: the case passed, but only one distinct case exists
for the `gpt-5.5` cohort and the minimum is three. This prevents a same-case
prompt win from being promoted as a cross-model or release-ready policy.

PIM was inspected read-only. Agent API Management showed `No Data` / `Total 0`
for the current personal-space view, while API Key Management still showed the
same three pre-existing rows. Since creating or changing PIM resources was out
of scope, the external `/agents/{id}` authenticated SSE success path remains
unverified. CrewON's existing transport contract still requests
`text/event-stream` and accepts `message`, `done`, and `error` envelopes; no
untested alternate PIM event shape was invented.

The tested Office AgentVersions were bound to the same direct Responses
transport at `https://api.aicuican.com/v1/responses`. Consequently, these GUI
observations validate CrewON Team orchestration and Control SSE only; they do
not certify the separate PIM Agent API or its SSE behavior.
