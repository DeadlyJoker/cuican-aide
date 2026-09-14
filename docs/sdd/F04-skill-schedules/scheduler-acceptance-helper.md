# Existing scheduler acceptance helper

`apps/crewon-ui/scripts/browser-execution/scheduled-skill-acceptance.ts` exports
`prepareScheduledSkillAcceptance`. It is an acceptance driver for the production
Control API and existing scheduler. It does not own browser execution or model
completion.

## Caller preparation

1. Obtain an immutable Skill version with an actual completed, reviewed trial.
2. Prepare the destination Thread, uploaded template and concrete invocation
   parameters. Obtain its delivery target from `client.delivery.catalog`.
3. Authorize the controlled browser for that exact Thread, Skill version and
   reviewed rules through the normal browser authority mechanism.
4. Record the explicit Run permission choice, `requestApproval` or `approveForMe`.
   Delivery target references and Skill content do not confer this authority.
5. Persist `fixedVersion`, `threadId`, `expectedThreadRevision`, `invocation`,
   `title`, `idempotencyKey`, `dueAt` and `toolPermissionMode` before calling the
   helper. Allow enough time before `dueAt` for activation and schedule creation.
   F05 normally leaves 15–30 seconds after preparation.

Supply the current `ControlApiClient`, the authenticated JSON `request` function
used by the real acceptance script and the actual runtime `databasePath`.
`request(path, body?, method?, key?)` returns parsed JSON and must reject non-2xx
responses. It defaults to POST; the helper specifies GET for reads. Optional
`onAutomationCreated` can persist the returned automation checkpoint.

Preserve the entire saved request on retry, including the original Thread
revision. Creating a new key or using the newly advanced revision changes the
request instead of recovering the original receipt.

## Evidence collected

The helper resolves the exact version through F03 and, when needed, activates it
through the real API. The service rechecks the reviewed trial. It then creates a
one-time Skill automation through `ControlApiClient.createAutomation` with the
explicit top-level permission mode. The definition must have been saved before
its due time.

The helper waits for the existing scheduler. It finds the Run through
authenticated APIs, then opens the supplied SQLite database **read-only**. A
single read transaction checks the persisted definition, invocation receipt and
Run snapshot together:

- Exactly one occurrence receipt belongs to the automation.
- Its key matches the existing scheduler's `scheduled:` occurrence key.
- The Run's automation origin identifies that definition and exact due time.
- The frozen Skill reference, parameters, tool references and delivery target
  equal the submitted invocation.
- The definition, Run and receipt retain the explicit permission mode.
- The Run was created at or after the due time.

Finally, `GET /api/v1/runs/:id/skill-invocation` checks the current server-side
Skill authority and returns the same Thread, version and parameters.

The result includes `automation`, `run`, `binding`, `scheduledFor`,
`runCreatedAt`, `toolPermissionMode`, `invocationReceiptCount`,
`schedulerReceiptKey` and `authorization`. It proves admission of the scheduled
Run. The caller must still wait for model completion, inspect the actual source
and output files independently and verify restart persistence.

The helper never calls run-now, creates a Run directly, fabricates a trial,
approves a tool, grants browser access, assembles a file or starts Electron.
A timeout retains the saved automation; retry uses the same request.

## Verification recorded on 2026-09-14

Relevant commits: helper `88cc5cb5a`, scheduler receipt proof `faf5448ea`, fixture
output correction `8dba99f82`. The permission backend is F01 `3e5d6af1d`
(cherry-picked locally as `7f530bbb5`).

```bash
node --experimental-strip-types --test apps/control-api/src/scheduled-skill-acceptance.test.ts
pnpm --filter @crewon/control-api typecheck
pnpm crewon:boundary:check
```

All four helper tests pass, with no skips. Both permission modes go through real
Control HTTP, SQLite, the existing scheduler and a real Worker instance. They
complete with one fixture model call and replay the same automation and Run.
Changing mode under the same key is rejected. Missing reviewed-trial authority
fails through real F03 activation before any automation is created; wrong version
and target bindings fail before mutation. Control typecheck and repository
boundary checks also pass.

The tests deliberately seed an activated Skill as a scheduling precondition and
use a fake model transport. They are **not** evidence of a real trial, browser
interaction, model-produced spreadsheet or unattended E05 completion. That
evidence belongs to F05's independent real acceptance run.

The first positive test attempt timed out because the fixture emitted only a
completion event. The actual Worker's persisted work item reported
`message_content_invalid` while retrying the empty assistant response. The
one-line fixture correction emits a valid text delta; no scheduler, Worker,
permission policy or timeout was changed. The corrected four tests completed in
3.29 seconds.
