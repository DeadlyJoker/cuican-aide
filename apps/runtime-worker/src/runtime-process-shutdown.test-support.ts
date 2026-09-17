import { installRuntimeProcessShutdown } from "./runtime-process-shutdown.ts";

let release!: () => void, reject!: (error: Error) => void;
const closing = new Promise<void>((yes, no) => {
  release = yes;
  reject = no;
});
process.on("SIGUSR2", () => {
  if (process.argv[2] === "reject") reject(new Error("private failure"));
  else release();
});
installRuntimeProcessShutdown({
  host: {
    on: process.on.bind(process),
    exit: (code) => {
      process.stdout.write("cleanup settled\n");
      process.exit(code);
    },
  },
  close: () => {
    process.stdout.write("cleanup pending\n");
    return closing;
  },
  reportFailure: () => {
    process.stderr.write("close failed\n");
  },
});
process.emit("SIGTERM");
