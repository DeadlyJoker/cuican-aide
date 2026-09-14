import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRecordingFixtureSite } from "./recording-fixture-site.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sample = JSON.parse(
  await readFile(
    resolve(root, "artifacts/f02-recording/recording-export.json"),
    "utf8",
  ),
) as { authorization: { allowedOrigins: string[] } };
const origin = new URL(sample.authorization.allowedOrigins[0]!);
if (origin.hostname !== "127.0.0.1" || origin.protocol !== "http:")
  throw new Error("fixture_origin_invalid");
const { server, url } = await startRecordingFixtureSite({
  port: Number(origin.port),
});
console.log(`F02_SYNTHETIC_SITE ${url}`);
console.log(
  "Serving the exact loopback port recorded by the actual-source C01 sample; stop this process after acceptance.",
);
process.on("SIGINT", () => server.close());
process.on("SIGTERM", () => server.close());
