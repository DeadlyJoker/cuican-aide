export function soakEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "XDG_RUNTIME_DIR",
    "SystemRoot",
  ]) {
    if (process.env[key]) result[key] = process.env[key];
  }
  return result;
}
