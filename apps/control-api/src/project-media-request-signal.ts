import type { FastifyRequest, FastifyReply } from "fastify";

/** Cancel preparation on disconnect while retaining the physical handler until it settles. */
export async function withProjectMediaRequestSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController(),
    abort = () => controller.abort(),
    closed = () => {
      if (!reply.raw.writableEnded) abort();
    };
  request.raw.once("aborted", abort);
  reply.raw.once("close", closed);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  try {
    return await work(controller.signal);
  } finally {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", closed);
  }
}
