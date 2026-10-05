import type {
  AssociationRequest,
  AssociationResponse,
} from "./project-conversation-association-service";
export function parseProjectConversationAssociationRequest(
  input: unknown,
): AssociationRequest;
export function parseProjectConversationAssociationResponse(
  request: AssociationRequest,
  input: unknown,
): AssociationResponse;
