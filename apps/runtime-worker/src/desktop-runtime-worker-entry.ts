import { readAndInstallRuntimeNativeBootstrap } from "./runtime-stdin-bootstrap.ts";

await readAndInstallRuntimeNativeBootstrap();
await import("./main.ts");
process.stdin.resume();
