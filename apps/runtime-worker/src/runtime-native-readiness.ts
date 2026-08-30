export function runtimeNativeReadinessLines(input: {
  providerRuntimeBindingId: string | null;
  workspacePrivateOrigin: string | null;
  workspaceRuntimeBindingId: string | null;
}): readonly [string, string] {
  const provider = input.providerRuntimeBindingId ?? "none";
  const workspaceBinding = input.workspaceRuntimeBindingId ?? "none";
  if (!opaque(provider) || !opaque(workspaceBinding)) {
    throw new Error("runtime_native_readiness_invalid");
  }
  const origin = input.workspacePrivateOrigin ?? "none";
  if (
    origin !== "none" &&
    !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/u.test(origin)
  ) {
    throw new Error("runtime_native_readiness_invalid");
  }
  return [
    `CrewON Provider Runtime ready:${provider}`,
    `CrewON Workspace Runtime ready:${origin}:${workspaceBinding}`,
  ];
}

function opaque(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value);
}
