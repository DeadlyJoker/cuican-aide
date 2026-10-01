import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_HISTORICAL_WORK_ITEM_SCOPE,
  resolveRetainedExtensionBuild,
} from "../packages/agent-version/src/extension-build.ts";
import { resolveRuntimeExtensionEnvironment } from "../apps/runtime-worker/src/extensions/extension-process-environment.ts";

export type RetainedExtensionWorkerSelection = Readonly<{
  dataRoot: string;
  implementationDigest: string;
  buildIdentityDigest: string;
}>;

export function parseRetainedExtensionWorkerSelection(
  args: readonly string[],
): RetainedExtensionWorkerSelection {
  if (
    args.length !== 6 ||
    args[0] !== "--data-root" ||
    args[2] !== "--implementation-digest" ||
    args[4] !== "--build-identity-digest"
  )
    throw new Error("retained_extension_worker_arguments_invalid");
  const dataRoot = args[1]!;
  const implementationDigest = args[3]!;
  const buildIdentityDigest = args[5]!;
  if (
    !isAbsolute(dataRoot) ||
    dataRoot.trim() !== dataRoot ||
    /[\u0000-\u001f\u007f]/u.test(dataRoot) ||
    Buffer.byteLength(dataRoot, "utf8") > 4096 ||
    !/^sha256:[a-f0-9]{64}$/u.test(implementationDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(buildIdentityDigest)
  )
    throw new Error("retained_extension_worker_arguments_invalid");
  return Object.freeze({ dataRoot, implementationDigest, buildIdentityDigest });
}

/** Explicit operator recovery: retain old immutable binding files and supply current credentials. */
export async function retainedExtensionWorkerLaunchPlan(input: {
  selection: RetainedExtensionWorkerSelection;
  environment: Readonly<Record<string, string | undefined>>;
}): Promise<Readonly<{ workerPath: string; environment: NodeJS.ProcessEnv }>> {
  const { dataRoot, implementationDigest, buildIdentityDigest } =
    input.selection;
  const selection = parseRetainedExtensionWorkerSelection([
    "--data-root",
    dataRoot,
    "--implementation-digest",
    implementationDigest,
    "--build-identity-digest",
    buildIdentityDigest,
  ]);
  const environment: NodeJS.ProcessEnv = { ...input.environment };
  if (
    (environment.CREWON_CONTROL_SECURITY_MODE !== undefined &&
      environment.CREWON_CONTROL_SECURITY_MODE !== "standalone") ||
    (environment.CREWON_EXTENSION_EXECUTION_MODE !== undefined &&
      environment.CREWON_EXTENSION_EXECUTION_MODE !== "historical") ||
    Object.keys(environment).some(
      (name) => name.startsWith("CREWON_NATIVE_") && name.includes("BOOTSTRAP"),
    )
  )
    throw new Error("retained_extension_worker_environment_invalid");
  environment.CREWON_EXTENSION_EXECUTION_MODE = "historical";
  // The archive is code only. Model credentials and current permission are rechecked by Worker.
  delete environment.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT;
  if (
    resolveRuntimeExtensionEnvironment(environment, "standalone") === undefined
  )
    throw new Error("retained_extension_worker_environment_invalid");
  const build = await resolveRetainedExtensionBuild({
    dataRoot: selection.dataRoot,
    implementationDigest: selection.implementationDigest,
    expectedBuildIdentityDigest: selection.buildIdentityDigest,
  });
  // An older complete archive can still be inspected, but its Worker cannot
  // prove prepared-target queue isolation and must never be executed here.
  if (build.historicalWorkItemScope !== EXTENSION_HISTORICAL_WORK_ITEM_SCOPE)
    throw new Error("retained_extension_worker_scope_unsupported");
  const worker = build.bundles.find(
    (bundle) => bundle.file === "runtime-worker.mjs",
  );
  if (worker === undefined)
    throw new Error("retained_extension_worker_entry_missing");
  return Object.freeze({
    workerPath: worker.path,
    environment: Object.freeze(environment),
  });
}

export async function runRetainedExtensionWorker(input: {
  selection: RetainedExtensionWorkerSelection;
  environment: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}): Promise<number> {
  const signal = input.signal;
  if (!/^24\./u.test(process.versions.node))
    throw new Error("retained_extension_worker_node_version_invalid");
  signal?.throwIfAborted();
  const plan = await retainedExtensionWorkerLaunchPlan(input);
  signal?.throwIfAborted();
  const child = spawn(process.execPath, [plan.workerPath], {
    env: plan.environment,
    stdio: "inherit",
  });
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const abort = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let processFailure: Error | undefined;
  const onError = (error: Error) => {
    processFailure = error;
    // A failed signal does not prove a running child has exited. Keep owning it.
    if (child.pid !== undefined) abort();
  };
  child.on("error", onError);
  try {
    return await new Promise<number>((succeed, fail) => {
      child.on("error", (error) => {
        if (child.pid === undefined) fail(error);
      });
      child.once("exit", (code, signal) => {
        if (processFailure !== undefined) {
          fail(processFailure);
          return;
        }
        succeed(
          code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
        );
      });
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    child.removeListener("error", onError);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.exitCode = await runRetainedExtensionWorker({
      selection: parseRetainedExtensionWorkerSelection(process.argv.slice(2)),
      environment: process.env,
      signal: abort.signal,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
