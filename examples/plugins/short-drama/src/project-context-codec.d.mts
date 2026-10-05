import type { PublicProjectContextScope } from "./project-context-service.js";
export declare const projectContextCodec: {
  parseResponse(input: unknown): Readonly<{ scope: PublicProjectContextScope | null }>;
};
