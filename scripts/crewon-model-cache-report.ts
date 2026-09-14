import {
  readSqliteModelCacheUsageReport,
  readSqliteModelUsageObservationsReport,
  readSqliteModelCallsReport,
  readSqliteModelAccountingReport,
} from "../packages/store/src/index.ts";

const [databasePath, tenantId, runId, ...extra] = process.argv.slice(2);
if (
  databasePath === undefined ||
  tenantId === undefined ||
  runId === undefined ||
  (extra.length > 0 &&
    (extra.length !== 1 ||
      !["--observations", "--calls", "--reconcile"].includes(extra[0] ?? "")))
) {
  process.stderr.write(
    "Usage: pnpm exec node --experimental-strip-types scripts/crewon-model-cache-report.ts DATABASE TENANT_ID RUN_ID [--observations|--calls|--reconcile]\n",
  );
  process.exitCode = 1;
} else {
  try {
    const report = await (
      extra[0] === "--reconcile"
        ? readSqliteModelAccountingReport
        : extra[0] === "--calls"
          ? readSqliteModelCallsReport
          : extra[0] === "--observations"
            ? readSqliteModelUsageObservationsReport
            : readSqliteModelCacheUsageReport
    )({
      databasePath,
      tenantId,
      runId,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "cache_report_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
