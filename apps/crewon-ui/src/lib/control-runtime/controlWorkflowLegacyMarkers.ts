const DEFINITION_PREFIX = "__crewon_workflow_definition__:";
const EXECUTION_PREFIX = "__crewon_workflow_run__:";
export function parseDefinitionTitle(title: string | null): string | null {
  if (!title?.startsWith(DEFINITION_PREFIX)) return null;
  try {
    return decodeURIComponent(title.slice(DEFINITION_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

export type ExecutionMarker = Readonly<{
  workflowVersionId: string;
  executionId: string;
}>;

export function parseExecutionTitle(
  title: string | null,
): ExecutionMarker | null {
  if (!title?.startsWith(EXECUTION_PREFIX)) return null;
  const value = title.slice(EXECUTION_PREFIX.length);
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  try {
    return {
      workflowVersionId: decodeURIComponent(value.slice(0, separator)),
      executionId: value.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function isInternalControlWorkflowThread(thread: {
  name?: string | null;
  preview?: string | null;
  title?: string | null;
}): boolean {
  const title = thread.title ?? thread.name ?? thread.preview ?? null;
  return (
    parseDefinitionTitle(title) !== null || parseExecutionTitle(title) !== null
  );
}
