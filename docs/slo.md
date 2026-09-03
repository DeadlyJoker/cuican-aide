# CrewON service-level objectives

This document defines the initial production SLO boundary for the active services. Targets become release gates only when their metrics and alerts are wired in the deployment environment.

| Tier | Service                       | Availability target |
| ---- | ----------------------------- | ------------------- |
| P0   | Control API                   | 99.9%               |
| P0   | Runtime Worker inference path | 99.9%               |
| P1   | Web BFF                       | 99.5%               |
| P1   | Device Gateway                | 99.5%               |
| P2   | Desktop updater               | 99.0%               |

## Core signals

- Request and first-event latency for Control API commands and reconnectable streams
- Run queue wait, provider first-token latency, completion latency, and terminal error rate
- Active threads, runs, workers, device sessions, and reconnect rates
- Database pool, storage, CPU, memory, queue, and outbox saturation
- Run completion, idempotent replay, stream recovery, and device unknown-outcome rates

## Initial objectives

| Signal                                     | Objective    | Alert threshold |
| ------------------------------------------ | ------------ | --------------- |
| Control API p99 excluding streams          | below 500 ms | above 1 s       |
| Runtime first-event p99                    | below 30 s   | above 60 s      |
| Control API 5xx rate                       | below 0.1%   | above 0.5%      |
| Runtime terminal infrastructure error rate | below 0.5%   | above 1%        |
| Scheduler admission wait p99               | below 1 s    | above 5 s       |
| Durable outbox settlement lag p99          | below 5 s    | above 15 s      |

Provider-declared failures and user cancellations must be classified separately from platform infrastructure failures.

## Error budgets and operations

At 99.9%, the annual error budget is approximately 8.76 hours; at 99.5%, it is approximately 43.8 hours. A service that exhausts its rolling error budget pauses risky releases until recovery actions are complete.

Production readiness requires dashboards, actionable alerts, backup/restore drills, dependency-failure drills, and capacity tests at twice the expected peak. Metrics and logs must not expose prompts, credentials, tenant data, device payloads, or model output by default.
