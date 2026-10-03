/** Complete serial owner cleanup, preserving the original startup failure. */
export async function closeStandaloneCompositionOwners(
  owners: readonly (() => void | Promise<void>)[],
  initialErrors: readonly unknown[] = [],
): Promise<void> {
  const errors = [...initialErrors];
  for (const close of owners) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "extension_control_cleanup_failed");
}
