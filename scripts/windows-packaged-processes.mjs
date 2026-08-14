import { win32 } from "node:path";

const packagedProcessName =
  /^(?:crewon-ui|crewon-node|crewon-process-guardian|node)(?:-[a-z0-9_.-]+)?\.exe$/iu;

export function findOwnedPackagedWindowsProcesses({
  appBinary,
  installRoot,
  processes,
}) {
  const root = canonicalAbsolutePath(installRoot);
  const app = canonicalAbsolutePath(appBinary);
  if (!isWithin(root, app))
    throw new Error("packaged_windows_app_outside_install_root");
  if (!Array.isArray(processes))
    throw new Error("packaged_windows_process_snapshot_invalid");

  return processes.flatMap((process) => {
    const name = process?.Name;
    if (typeof name !== "string" || !packagedProcessName.test(name)) return [];
    const processId = Number(process.ProcessId);
    if (!Number.isSafeInteger(processId) || processId <= 0)
      throw new Error("packaged_windows_process_snapshot_invalid");
    const executablePath = optionalCanonicalPath(process.ExecutablePath);
    const commandLine =
      typeof process.CommandLine === "string"
        ? process.CommandLine.replaceAll("/", "\\").toLowerCase()
        : "";
    if (
      executablePath === null &&
      commandLine === "" &&
      name.toLowerCase() !== "node.exe"
    )
      throw new Error("packaged_windows_process_snapshot_invalid");
    const rootPrefix = root.endsWith("\\") ? root : `${root}\\`;
    const owned =
      (executablePath !== null &&
        (executablePath === app || isWithin(root, executablePath))) ||
      commandLine.includes(app) ||
      commandLine.includes(rootPrefix);
    return owned ? [{ name, processId }] : [];
  });
}

function canonicalAbsolutePath(value) {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("packaged_windows_process_path_invalid");
  const normalized = win32.normalize(value.trim()).toLowerCase();
  if (!win32.isAbsolute(normalized))
    throw new Error("packaged_windows_process_path_invalid");
  return normalized;
}

function optionalCanonicalPath(value) {
  if (value === null || value === undefined || value === "") return null;
  return canonicalAbsolutePath(value);
}

function isWithin(root, candidate) {
  const relative = win32.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${win32.sep}`) &&
      !win32.isAbsolute(relative))
  );
}
