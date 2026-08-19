import type { Server } from "node:http";

export type BoundedServerShutdown = Readonly<{
  register(controller: AbortController): () => void;
  shutdown(): Promise<"drained" | "forced">;
}>;

export function createBoundedServerShutdown(
  server: Server,
  graceMs: number,
): BoundedServerShutdown {
  if (!Number.isSafeInteger(graceMs) || graceMs < 1) {
    throw new Error("web_bff_shutdown_grace_invalid");
  }

  const activeControllers = new Set<AbortController>();
  let shutdownPromise: Promise<"drained" | "forced"> | null = null;

  return {
    register(controller) {
      if (shutdownPromise !== null) {
        controller.abort();
        return () => undefined;
      }
      activeControllers.add(controller);
      return () => {
        activeControllers.delete(controller);
        if (shutdownPromise !== null && activeControllers.size === 0) {
          server.closeIdleConnections();
        }
      };
    },
    shutdown() {
      shutdownPromise ??= new Promise((resolve) => {
        let completed = false;
        const finish = (result: "drained" | "forced") => {
          if (completed) {
            return;
          }
          completed = true;
          clearTimeout(deadline);
          resolve(result);
        };
        const deadline = setTimeout(() => {
          for (const controller of activeControllers) {
            controller.abort();
          }
          server.closeAllConnections();
          finish("forced");
        }, graceMs);
        deadline.unref();
        server.close(() => finish("drained"));
      });
      return shutdownPromise;
    },
  };
}
