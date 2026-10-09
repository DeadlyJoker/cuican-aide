#!/usr/bin/env node
import { verifyLocalPluginPackage } from "@crewon/plugin-host/package-snapshot";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(
    "Usage: crewon-plugin check <package-directory>\nChecks descriptor and actual file bytes. Does not install, import, authorize or resolve services.\n",
  );
} else if (
  args.length !== 2 ||
  args[0] !== "check" ||
  !args[1] ||
  args[1].startsWith("--")
) {
  process.stderr.write(
    JSON.stringify({
      schemaVersion: "crewon.plugin-package-check.v1",
      outcome: "rejected",
      code: "plugin_check_arguments_invalid",
    }) + "\n",
  );
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const verified = await verifyLocalPluginPackage({
      directory: args[1],
      signal: controller.signal,
    });
    const { descriptor } = verified;
    process.stdout.write(
      JSON.stringify({
        schemaVersion: "crewon.plugin-package-check.v1",
        outcome: "verified",
        pluginId: descriptor.pluginId,
        publisherId: descriptor.publisherId,
        version: descriptor.version,
        hostApi: descriptor.hostApi,
        packageDigest: verified.packageDigest,
        totalBytes: verified.totalBytes,
        fileCount: verified.fileCount,
        requires: descriptor.requires,
        provides: descriptor.provides,
        contributions: descriptor.contributions,
        authorization: "notEvaluated",
        services: "notResolved",
      }) + "\n",
    );
  } catch (error) {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^plugin_package_[a-z_]+$/u.test(error.code)
        ? error.code
        : "plugin_package_check_failed";
    process.stderr.write(
      JSON.stringify({
        schemaVersion: "crewon.plugin-package-check.v1",
        outcome: "rejected",
        code,
      }) + "\n",
    );
    process.exitCode =
      controller.signal.reason === "SIGINT"
        ? 130
        : controller.signal.reason === "SIGTERM"
          ? 143
          : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
