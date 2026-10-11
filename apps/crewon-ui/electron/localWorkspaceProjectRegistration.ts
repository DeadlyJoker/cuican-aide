/** Native-only, one-use registration proof. Neither JSON nor another authority instance can reuse it. */
export type LocalWorkspaceProjectRegistration = Readonly<Record<never, never>>;
type Registration = Readonly<{
  authority: object;
  workspaceId: string;
  root: string;
}>;
const registrations = new WeakMap<object, Registration>();

/** Internal allocator issuance; intentionally absent from the renderer bridge and plugin SDK. */
export function issueLocalWorkspaceProjectRegistration(
  input: Registration,
): LocalWorkspaceProjectRegistration {
  const token = Object.freeze(Object.create(null) as object);
  registrations.set(token, Object.freeze({ ...input }));
  return token;
}

export function consumeLocalWorkspaceProjectRegistration(
  authority: object,
  token: LocalWorkspaceProjectRegistration,
): Readonly<{ workspaceId: string; root: string }> {
  const value =
    token !== null && typeof token === "object"
      ? registrations.get(token)
      : undefined;
  if (value === undefined || value.authority !== authority)
    throw new Error("desktop_workspace_registration_unavailable");
  registrations.delete(token);
  return Object.freeze({ workspaceId: value.workspaceId, root: value.root });
}
