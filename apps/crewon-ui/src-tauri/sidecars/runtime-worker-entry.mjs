// The reusable worker intentionally `unref()`s its scan timer so library users
// are not forced to keep a process alive. A packaged desktop worker is itself a
// supervised daemon, so retain the host-owned stdin pipe after initialization.
// The pipe closes with the Tauri parent even if normal shutdown cannot run.
await import("../../../runtime-worker/src/main.ts");
process.stdin.resume();
