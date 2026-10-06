type FileCheck = { validate(): void; repeated: boolean };
let current: Map<object, FileCheck> | undefined;

/** Only synchronous, read-only ownership validation belongs in this scope.
 * Each file is checked on first use. Repeated checks run again at the end,
 * after the last ownership read. Nothing survives an await or this call. */
export function validateNativeOwnership(validate: () => void): void {
  if (current !== undefined) {
    if (validate() !== undefined) invalid();
    return;
  }
  const batch = new Map<object, FileCheck>();
  current = batch;
  try {
    if (validate() !== undefined) invalid();
    current = undefined;
    for (const check of batch.values()) if (check.repeated) check.validate();
  } finally {
    current = undefined;
  }
}

/** key is the immutable configuration issued by the original private-file loader. */
export function checkNativeOwnershipFile(
  key: object,
  validate: () => void,
): void {
  const batch = current;
  if (batch === undefined) {
    validate();
    return;
  }
  const previous = batch.get(key);
  if (previous !== undefined) {
    previous.repeated = true;
    return;
  }
  validate();
  batch.set(key, { validate, repeated: false });
}

function invalid(): never {
  throw new Error("desktop_native_ownership_check_must_be_synchronous");
}
