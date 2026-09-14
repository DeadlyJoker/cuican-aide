# 2026-09-04 PIM Agent GUI evidence

This note separates the PIM Agent's visible behavior from CrewON's external
Agent transport. All prompts were submitted through the PIM or CrewON desktop
GUI. Product HTTP APIs were not used to submit a turn. Chrome DevTools Protocol
was used only to operate the visible pages and observe browser timing, DOM, and
network metadata. No API Key value was logged or persisted in this repository.

## Agent behavior in the PIM preview

The published `AI智能助理` preview identified its model as `deepseek-chat`.
For the release-decision prompt below, the preview returned the required three
nonblank lines, selected `NO-GO`, covered both supplied blockers, and introduced
no unsupported fact:

```text
请根据以下事实做发布决策，不得添加未提供的事实：安全扫描通过；回退演练未执行；SBOM 摘要与制品摘要不一致。只输出三行：
DECISION: GO 或 NO-GO
BLOCKER: 一句话
NEXT: 一句话
```

Observed answer:

```text
DECISION: NO-GO
BLOCKER: SBOM 摘要与制品摘要不一致，且回退演练未执行，风险未闭合
NEXT: 先核对并修复 SBOM 与制品摘要差异，再补做回退演练并复审后再做最终发布决策
```

The first and only visible answer state arrived at 4,022 ms. A follow-up in the
same conversation asked for only the prior decision value and returned exactly
`NO-GO` at 1,781 ms, confirming visible multi-turn continuity for this case.

## SSE protocol versus incremental delivery

The follow-up response was HTTP 200 over HTTP/2 with
`Content-Type: text/event-stream; charset=utf-8` on
`/api/v1/conversations/305/messages/stream`. The DOM nevertheless changed only
once with the complete answer.

A new preview conversation then requested exactly `STREAM-01` through
`STREAM-40`, one item per line. All 40 lines were correct and unique. Its HTTP
200 response on `/api/v1/conversations/306/messages/stream` also declared
`text/event-stream`, but browser network observation saw only two positive data
events: the first at 2,554 ms and the second at 2,557 ms, a 3 ms gap. The PIM
preview DOM exposed one complete answer state at 3,041 ms. For this observation,
the endpoint used the SSE media type but buffered almost the entire result
before delivery; a downstream CrewON parser cannot create an earlier truthful
first delta from that input.

This is evidence for the PIM preview route, not proof that the external
`/agents/{id}` Open API has identical buffering behavior. That external route
could not be authenticated in this run for the reason below.

## External API credential blocker

The PIM API Key GUI was used with only the `chat` scope and expiry
`2026-10-04 00:00:00`. Two attempts with name
`CrewON desktop SSE 20260904` and one controlled attempt with the shorter ASCII
name `CrewON-SSE-0904` all returned:

```text
POST /api/v1/spaces/1/api-keys
HTTP 500
code: SYSTEM_BUSY
message: 系统繁忙，请稍后再试
```

No new row appeared and no one-time Key was returned. The pre-existing three
Keys were not edited, revoked, or deleted. CrewON's encrypted desktop Agent
credential file remained absent. Therefore the real external-Agent success,
delta, terminal, reconnect, and multi-turn paths remain unverified rather than
being inferred from the PIM preview.

The CrewON GUI did verify its fail-closed boundary: choosing “加入当前工作区
AI智能助理” with no PIM credential opened a password-only dialog bound to the
exact origin `https://pim.aicuican.com`; it did not reuse the model-provider Key
or restart the runtime. An earlier external attempt failed before any stream
with `cloud_agent_authentication_failed` (Thread
`01a06a6a-ccd4-707b-bc63-abac5ef47738`).

## Prompt and trace observations

The live System prompt names the memory tool `save_memory`, while `AGENT.md`
names it `memory.write`; the published Agent currently reports zero enabled
built-in tools. A no-side-effect probe asking only for the tool name returned a
third spelling, `memory_write`. Exact runtime tool identities should be injected
from the active capability catalog, and authored prompts should not carry stale
aliases. When no matching tool is present, the contract should require an
explicit unavailable result instead of a guessed name.

The probe's PIM trace was
`92a3776f-d187-4f95-a9ab-889aa90897e4` (Session 307). It reported a 1.29 s parent
run and included a model-operation ID plus a terminal receipt hash. However,
the UI reported `0 Tokens` and every child span, including model request and
model return, as `0μs`. Provider-internal steps and token usage must therefore
remain unknown in CrewON evidence until PIM exposes trustworthy values. The
operation ID and terminal receipt are promising correlation fields for a future
external SSE terminal event, but this observation does not prove replay,
idempotency, or resume support.

## Recommended next gates

1. Restore PIM API Key creation, then rerun the external CrewON GUI case with a
   short-lived, chat-only Key.
2. Flush an early SSE envelope and each real model delta through the PIM proxy;
   verify first-delta and maximum-gap distributions instead of media type alone.
3. Expose a stable invocation ID, monotonic event sequence, terminal receipt,
   token usage, and query/resume semantics to make reconnect evidence durable.
4. Evaluate prompt/capability profiles in same-model cohorts. Do not reduce
   global tool-round limits or branch on model display names without a measured
   quality gate.
