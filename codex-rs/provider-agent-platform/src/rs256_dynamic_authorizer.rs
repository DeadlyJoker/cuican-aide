use crewon_resource_federation::ResourceKind;
use serde::Serialize;
use uuid::Uuid;

use crate::DynamicAuthorizationOperation;
use crate::ProviderAuthorizationError;
use crate::ProviderAuthorizationIdentity;
use crate::ProviderDynamicAuthorizationBinding;
use crate::ProviderRs256SigningKey;
use crate::wire::ResourceRefWire;

const ISSUER: &str = "crewon";
const AUDIENCE: &str = "agent-platform-provider-dynamic";
const AUTHORIZED_PARTY: &str = "crewon-app-server";
const PURPOSE: &str = "executeDynamicResource";
const TOKEN_TYPE: &str = "crewon-dynamic-delegation+jwt";

pub(crate) fn issue_dynamic_delegation(
    signing_key: &ProviderRs256SigningKey,
    identity: &ProviderAuthorizationIdentity,
    operation: DynamicAuthorizationOperation,
    binding: &ProviderDynamicAuthorizationBinding,
    issued_at: u64,
    expires_at: u64,
) -> Result<String, ProviderAuthorizationError> {
    if matches!(operation, DynamicAuthorizationOperation::Call)
        != matches!(binding.resource().kind, ResourceKind::McpTool)
    {
        return Err(ProviderAuthorizationError::Unauthorized);
    }
    let resource = ResourceRefWire::from_domain(binding.resource())
        .map_err(|_| ProviderAuthorizationError::Unauthorized)?;
    signing_key.issue(
        TOKEN_TYPE,
        &DynamicClaims {
            issuer: ISSUER,
            audience: AUDIENCE,
            subject: identity.subject(),
            token_id: Uuid::now_v7().to_string(),
            issued_at,
            expires_at,
            authorized_party: AUTHORIZED_PARTY,
            tenant_id: identity.tenant_id(),
            space_id: identity.space_id(),
            scopes: [match operation {
                DynamicAuthorizationOperation::Call => "providerTool:call",
                DynamicAuthorizationOperation::Search => "providerKnowledge:search",
            }],
            purpose: PURPOSE,
            call_id: binding.call_id(),
            action_digest: binding.action_digest(),
            credential: DynamicCredentialClaims {
                credential_id: binding.credential_id(),
                owner_subject: identity.subject(),
                revision: binding.credential_revision(),
            },
            resource,
        },
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DynamicClaims<'a> {
    #[serde(rename = "iss")]
    issuer: &'static str,
    #[serde(rename = "aud")]
    audience: &'static str,
    #[serde(rename = "sub")]
    subject: &'a str,
    #[serde(rename = "jti")]
    token_id: String,
    #[serde(rename = "iat")]
    issued_at: u64,
    #[serde(rename = "exp")]
    expires_at: u64,
    #[serde(rename = "azp")]
    authorized_party: &'static str,
    tenant_id: &'a str,
    space_id: &'a str,
    scopes: [&'static str; 1],
    purpose: &'static str,
    call_id: &'a str,
    action_digest: &'a str,
    credential: DynamicCredentialClaims<'a>,
    resource: ResourceRefWire,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DynamicCredentialClaims<'a> {
    credential_id: &'a str,
    owner_subject: &'a str,
    revision: u64,
}
