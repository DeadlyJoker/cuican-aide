# 2026-09-03 GUI Team evidence

This directory preserves one real, same-prompt GUI comparison for the
three-member release-decision Office. The model was `gpt-5.5` through provider
`aicuican`; no product HTTP API was used to submit either turn.

The visible prompt, final answer, one-user/one-assistant card counts, terminal
state, and absence of alerts were re-read from the browser GUI. Run counts and
the first-created-to-last-terminal durations were corroborated read-only from
the local durable SQLite store:

| Variant           | Root thread                            | Office version                         | Durable runs | Phases |  Duration |
| ----------------- | -------------------------------------- | -------------------------------------- | -----------: | -----: | --------: |
| manager-generated | `01a0670f-bd42-765f-9853-67de8dba4eb6` | `01a0670f-7b0c-71c5-847a-2acde042cfc8` |            4 |      3 | 50,524 ms |
| role-directed     | `01a06733-d3cc-745f-9ac3-16ba342b5418` | `01a06733-a73f-7124-8461-a8aee35aa0fd` |            3 |      2 | 45,683 ms |

Baseline run IDs:

- `01a0670f-bd9d-76b6-a9ad-dafb0d5f3af0`
- `01a0670f-f4fd-74b5-ba7e-72c32f6eec15`
- `01a0670f-f503-7721-a2d2-1340af4e3d33`
- `01a06710-59ec-742c-9347-d48bcb96d871`

Candidate run IDs:

- `01a06733-d454-71eb-a4a5-418989874b35`
- `01a06733-d45f-77fd-8c89-f56f8e7c1e60`
- `01a06734-5eba-767b-b37c-8cfc12487d00`

The deterministic gate checks the exact `NO-GO` decision, evidence coverage,
conflict, release gate, actions, unresolved facts, authored line syntax and
order, answer length, UI terminal state, and a required reduction in both Run
and phase counts. Manual semantic review also confirmed that neither answer
uses `184/184` to override the digest conflict or refund failure.

Limits are intentional and material: this is one paired observation, not a
latency benchmark; time to first visible output was not captured; the trace's
collector identity and aggregate efficiency are declarations rather than a
cryptographically bound receipt; and no second model was available in the GUI.
The artifacts therefore support the observed `gpt-5.5` regression result but
must not be presented as a release certificate or a cross-model conclusion.

## Fresh-profile responsibility regression

After Office member responsibilities became part of the immutable Office
definition, a separate GUI-only regression was run against Office version
`01a06a4d-ae38-71fa-901e-e2ec19007a7e`. The isolated browser's
`crewon:office-member-agent-profiles:v1` entry was absent before both turns, so
the role-directed decision had to come from the server-returned definition.

The second turn used the existing root Thread
`01a06a4f-728f-77dd-8420-74df36ffcbfc` and created exactly these three Runs,
with no manager-planning Run:

- `01a06a5d-237f-74df-bb7b-50785531a11a` (planner)
- `01a06a5d-2388-70c8-bca5-aac4e303a05f` (verifier)
- `01a06a5d-ba88-726d-bbc7-7bbfa9f6c68b` (manager final)

The first Run was created at `2026-09-04T03:01:23.967Z`; the final Run became
terminal at `2026-09-04T03:02:07.792Z`, a durable span of 43,825 ms. A browser
MutationObserver captured 19 distinct incremental answer states between 44,515
ms and the durable terminal message at 45,197 ms. The result was exactly four
nonblank lines, returned `DECISION: NO-GO`, preserved all requested labels,
showed no visible error, and left no loading state. This is a portability and
streaming regression check, not another paired latency sample.

Submitted prompt:

```text
仅依据以下给定事实，不使用工具、网络或外部信息。
事实：单元测试全部通过；生产冒烟测试尚未执行；发布制品没有签名。
规划成员给出门槛，验证成员判断证据，组长裁决。
最终必须恰好四行，不要空行：
DECISION: NO-GO
EVIDENCE: 说明阻断事实
GATE: 说明何时可发布
UNRESOLVED: 说明仍缺证据
```

Durable assistant Message `01a06a5d-ceb0-72e5-920e-30393a74bd55`:

```text
DECISION: NO-GO
EVIDENCE: 生产冒烟测试尚未执行，发布制品没有签名，单元测试全部通过不足以支持发布
GATE: 生产冒烟测试执行并通过，发布制品完成签名且签名校验通过后才可发布
UNRESOLVED: 仍缺生产冒烟测试结果、制品签名与签名校验证据、验证成员对证据充分性的确认
```

A final hard-reload check exercised the compacted prompts rather than an HMR
closure retained by the already-open page. It again started with no browser
member-profile entry and created exactly three Runs:

- `01a06a61-7c6d-70ef-b849-5cea05e60b13` (planner)
- `01a06a61-7c76-7140-8609-db711f026c3a` (verifier)
- `01a06a61-e32f-766d-9693-f590c3573186` (manager final)

The durable span was 30,901 ms. Browser observation captured one thinking state
and 20 distinct incremental answer states, from the first answer text at 31,560
ms to durable completion at 32,287 ms. Read-only inspection of the persisted
model-visible messages confirmed that each worker responsibility appeared once,
the generated responsibility tag appeared zero times, the manager's
authoritative responsibility was present, and the obsolete instruction to add
blank Markdown lines appeared zero times. The terminal assistant Message
`01a06a61-f523-73db-bfc4-b244124f5ded` was exactly four nonblank lines, with no
visible error or residual loading state.
