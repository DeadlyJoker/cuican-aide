import { types } from "node:util";
import {
  captureProjectMediaInputRunCommitTransaction,
  type ProjectMediaInputRunCommitTransactionAuthority,
} from "./project-media-input-run-commit-authority.ts";
import { ApplicationError } from "./application-error.ts";
import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type {
  ProjectMediaInputAuthority,
  ProjectMediaWorkflowReview,
  SaveProjectMediaInputCommand,
} from "./project-media-input-port.ts";
import {
  assertProjectMediaInputActive,
  mediaInputDigest,
  mediaInputData,
  projectMediaInputFail as fail,
} from "./project-media-input-record.ts";
export type ProjectMediaInputPermission = Readonly<{
  actor: ActorContext;
  action:
    | "projectMediaInput:read"
    | "projectMediaInput:write"
    | "projectMediaInput:qualify";
  resource: Readonly<{
    projectId: string;
    mediaInputId: string | null;
    inputRevision: number | null;
    command: SaveProjectMediaInputCommand | null;
    reviewDigest: string | null;
  }>;
}>;
/** Separate purpose; text/asset permissions and preparation receipts are not media-input grants. */
export interface ProjectMediaInputAuthorizationPort {
  authorize(input: ProjectMediaInputPermission): Promise<AuthorizationDecision>;
  /** Optional transaction-safe PDP hook. Installation rows are checked by the Store on its borrowed connection. */
  authorizeTransaction?(
    input: ProjectMediaInputPermission,
  ): Promise<AuthorizationDecision>;
  assertActive(input: ProjectMediaInputPermission): void;
}
export function captureProjectMediaInputAuthorization(
  input: ProjectMediaInputAuthorizationPort,
): ProjectMediaInputAuthorizationPort {
  const authorizeTransaction = optionalTransaction(input);
  return Object.freeze({
    ...(authorizeTransaction === undefined ? {} : { authorizeTransaction }),
    authorize: projectMediaInputBound<
      ProjectMediaInputAuthorizationPort["authorize"]
    >(input, "authorize"),
    assertActive: projectMediaInputBound<
      ProjectMediaInputAuthorizationPort["assertActive"]
    >(input, "assertActive"),
  });
}
export function projectMediaInputAuthority(
  input: Readonly<{
    actor: ActorContext;
    projectId: string;
    action: ProjectMediaInputAuthority["action"];
    review: ProjectMediaWorkflowReview | null;
    mediaInputId: string | null;
    inputRevision: number | null;
    command: SaveProjectMediaInputCommand | null;
    authorization: ProjectMediaInputAuthorizationPort;
    signal?: AbortSignal;
    runTransaction?: ProjectMediaInputRunCommitTransactionAuthority;
  }>,
): ProjectMediaInputAuthority {
  const permission = mediaInputData({
    actor: input.actor,
    action: `projectMediaInput:${input.action}`,
    resource: {
      projectId: input.projectId,
      mediaInputId: input.mediaInputId,
      inputRevision: input.inputRevision,
      command: input.command,
      reviewDigest:
        input.review === null ? null : mediaInputDigest(input.review),
    },
  }) as ProjectMediaInputPermission;
  const active = () => {
    input.signal?.throwIfAborted();
    input.runTransaction?.assertActive();
    return input.authorization.assertActive(permission);
  };
  let authority: ProjectMediaInputAuthority;
  const check = async (phase: "before" | "transaction") => {
    assertProjectMediaInputActive(authority);
    const decision = await (phase === "transaction" &&
    input.authorization.authorizeTransaction !== undefined
      ? input.authorization.authorizeTransaction(permission)
      : input.authorization.authorize(permission));
    assertProjectMediaInputActive(authority);
    if (decision.outcome !== "allow")
      throw new ApplicationError("authorization", "project_media_input_denied");
  };
  authority = Object.freeze({
    version: "crewon.project-media-input-commit.v1",
    actor: input.actor,
    projectId: input.projectId,
    action: input.action,
    review: input.review,
    assertCurrent: () => check("before"),
    assertTransactionCurrent: () => check("transaction"),
    assertActive: active,
    ...(input.runTransaction === undefined
      ? {}
      : {
          runTransaction: captureProjectMediaInputRunCommitTransaction(
            input.runTransaction,
          ),
        }),
  });
  return authority;
}
function optionalTransaction(
  input: ProjectMediaInputAuthorizationPort,
): ProjectMediaInputAuthorizationPort["authorizeTransaction"] {
  if (!input || typeof input !== "object" || types.isProxy(input))
    fail("dependency_invalid");
  for (
    let owner: object | null = input;
    owner;
    owner = Object.getPrototypeOf(owner)
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, "authorizeTransaction");
    if (!d) continue;
    if (!Object.hasOwn(d, "value") || typeof d.value !== "function")
      fail("dependency_invalid");
    return d.value.bind(input);
  }
  return undefined;
}
export function projectMediaInputBound<T extends (...args: never[]) => unknown>(
  input: unknown,
  key: string,
): T {
  if (!input || typeof input !== "object" || types.isProxy(input))
    fail("dependency_invalid");
  for (
    let owner: object | null = input;
    owner;
    owner = Object.getPrototypeOf(owner)
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (!d) continue;
    if (!Object.hasOwn(d, "value") || typeof d.value !== "function")
      fail("dependency_invalid");
    return d.value.bind(input) as T;
  }
  fail("dependency_invalid");
}
