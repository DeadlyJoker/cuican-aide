# Office TypeScript authority and contract

## Scope

Office is a tenant/space-scoped membership boundary. It is not an execution
engine, scheduler, expert compatibility layer, or in-memory handoff mechanism.
Starting work from an Office now names one immutable `WorkflowVersion`, one
active Thread, and bounded JSON input. The resulting canonical Workflow Run is
the sole execution, retry, verification, cancellation, and recovery authority.

## Authority

- `OfficeDefinitionStore` owns immutable Office versions.
- `OfficeDelegationStore` owns immutable Office-to-Workflow-Run provenance and
  is part of the same canonical `DomainStore` as Workflow admission on SQLite
  and PostgreSQL.
- Admission is receipt-first. A matching receipt returns the original
  Delegation and Workflow Run without invoking route resolution or
  preparation. A fingerprint mismatch conflicts.
- A fresh admission loads the exact OfficeVersion, immutable digest-valid
  WorkflowVersion, and active Thread, then revalidates the current release,
  every Agent/Verifier deployment, and the candidate route.
- Every AgentVersion referenced by the Workflow must be present in the Office
  membership boundary.
- Root input, canonical Run/event/outbox/scheduler WorkItem, Workflow receipt,
  OfficeDelegation, and Office receipt commit in one provider transaction.
- Delegation lists join the current canonical Run snapshot and use stable
  `createdAt + delegationId` pagination.

## Control contract

- `POST /api/v1/offices` creates an immutable Office version with revision CAS.
- `GET /api/v1/offices/:officeVersionId` and `GET /api/v1/offices` read versions.
- `POST /api/v1/offices/:officeVersionId:runs` accepts only
  `workflowVersionId`, `threadId`, and `input`; the former target-based request
  is rejected rather than translated.
- `GET /api/v1/offices/:officeVersionId/delegations` lists immutable provenance
  together with safe canonical Run projections.
- Start requires both exact `office:run` and `run:create` authorization. List
  requires exact `office:read` authorization.
- The CrewON Office room reads WorkflowVersion choices from Control, requires
  explicit JSON input, and shows no legacy Office scheduler or App Server path.

## Deliberate exclusions

No Rust compatibility, legacy importer, dual-read, target-to-Workflow adapter,
Office-specific queue, auto-dispatch, expert alias, chat, or memory handoff is
introduced. Automation scheduling is a separate pure TypeScript authority.
