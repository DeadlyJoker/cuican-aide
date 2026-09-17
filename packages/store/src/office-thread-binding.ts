import {
  RunStoreError,
  type BindOfficeThreadInput,
  type CommitThreadInput,
  type OfficeThreadBinding,
  type OfficeThreadLocator,
} from "@crewon/application";
import { parseOfficeDefinition, type ThreadState } from "@crewon/domain";

export function validateOfficeThreadLocator(input: OfficeThreadLocator): void {
  if (input == null) throw new RunStoreError("office_thread_binding_invalid");
  for (const key of ["tenantId", "spaceId", "officeId"] as const)
    text(input[key]);
}

export function validateOfficeThreadBinding(input: OfficeThreadBinding): void {
  validateOfficeThreadLocator(input);
  if (Object.keys(input).length !== 7)
    throw new RunStoreError("office_thread_binding_invalid");
  for (const key of ["officeVersionId", "threadId", "boundByActorId"] as const)
    text(input[key]);
  if (
    typeof input.boundAt !== "string" ||
    input.boundAt.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(input.boundAt) ||
    !Number.isFinite(Date.parse(input.boundAt))
  )
    throw new RunStoreError("office_thread_binding_invalid");
}

export function validateOfficeThreadCreation(input: CommitThreadInput): void {
  const binding = input.officeBinding;
  if (binding === undefined) return;
  validateOfficeThreadBinding(binding);
  const event = input.events[0];
  if (
    input.expectedRevision !== 0 ||
    input.events.length !== 1 ||
    event?.type !== "thread.created" ||
    input.messages.length !== 0 ||
    input.history.items.length !== 0 ||
    input.history.expectedLastSequence !== 0 ||
    input.sourceFence !== undefined ||
    input.tombstone !== undefined ||
    input.tenantId !== binding.tenantId ||
    event.identity.threadId !== binding.threadId ||
    event.data.tenantId !== binding.tenantId ||
    event.data.spaceId !== binding.spaceId ||
    event.data.createdByActorId !== binding.boundByActorId ||
    event.occurredAt !== binding.boundAt
  )
    throw new RunStoreError("office_thread_creation_invalid");
}

export function validateOfficeThreadAdoption(
  input: BindOfficeThreadInput,
): void {
  validateOfficeThreadBinding(input.binding);
  if (
    !Number.isSafeInteger(input.expectedThreadRevision) ||
    input.expectedThreadRevision < 1
  )
    throw new RunStoreError("office_thread_revision_invalid");
}

export function assertOfficeThreadDefinition(
  binding: OfficeThreadBinding,
  raw: unknown,
): void {
  if (raw == null) throw new RunStoreError("office_thread_office_not_found");
  try {
    const office = parseOfficeDefinition(
      typeof raw === "string" ? JSON.parse(raw) : raw,
    );
    if (
      office.tenantId !== binding.tenantId ||
      office.spaceId !== binding.spaceId ||
      office.officeId !== binding.officeId ||
      office.officeVersionId !== binding.officeVersionId
    )
      throw new Error("scope_mismatch");
  } catch (cause) {
    throw new RunStoreError("office_thread_office_mismatch", { cause });
  }
}

export function assertOfficeThreadAdoption(
  input: BindOfficeThreadInput,
  thread: ThreadState | null,
): void {
  const { binding } = input;
  if (
    !thread ||
    thread.tenantId !== binding.tenantId ||
    thread.spaceId !== binding.spaceId ||
    thread.threadId !== binding.threadId
  )
    throw new RunStoreError("office_thread_not_found");
  if (thread.revision !== input.expectedThreadRevision)
    throw new RunStoreError("revision_conflict");
  if (thread.status !== "active" || thread.forkedFromThreadId !== null)
    throw new RunStoreError("office_thread_not_eligible");
}

export function assertOfficeThreadReplay(
  binding: OfficeThreadBinding,
  existing: OfficeThreadBinding | null,
  state: ThreadState,
): void {
  if (
    existing === null ||
    existing.threadId !== state.threadId ||
    state.tenantId !== binding.tenantId ||
    state.spaceId !== binding.spaceId
  )
    throw new RunStoreError("office_thread_receipt_mismatch");
}

export function decodeOfficeThreadRow(
  row: Record<string, unknown> | undefined,
  locator: OfficeThreadLocator,
): OfficeThreadBinding | null {
  if (row === undefined) return null;
  const binding = {
    tenantId: row.tenant_id,
    spaceId: row.space_id,
    officeId: row.office_id,
    officeVersionId: row.office_version_id,
    threadId: row.thread_id,
    boundByActorId: row.bound_by_actor_id,
    boundAt: row.bound_at,
  } as OfficeThreadBinding;
  validateOfficeThreadBinding(binding);
  if (
    binding.tenantId !== locator.tenantId ||
    binding.spaceId !== locator.spaceId ||
    binding.officeId !== locator.officeId
  )
    throw new RunStoreError("office_thread_binding_invalid");
  return binding;
}

export function officeThreadSchemaSql(schema?: string): string {
  const table =
    schema === undefined
      ? "office_thread_bindings"
      : `${schema}.office_thread_bindings`;
  return `CREATE TABLE IF NOT EXISTS ${table} (
    tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, office_id TEXT NOT NULL,
    office_version_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    bound_by_actor_id TEXT NOT NULL, bound_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, space_id, office_id),
    UNIQUE (tenant_id, space_id, thread_id)
  )${schema === undefined ? " STRICT" : ""};`;
}

export function officeThreadLockKey(binding: OfficeThreadLocator): string {
  return `office-thread:${JSON.stringify([binding.tenantId, binding.spaceId, binding.officeId])}`;
}

function text(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new RunStoreError("office_thread_binding_invalid");
}
