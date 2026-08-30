use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use jsonwebtoken::Algorithm;
use jsonwebtoken::DecodingKey;
use jsonwebtoken::Header;
use jsonwebtoken::Validation;
use jsonwebtoken::decode;
use jsonwebtoken::decode_header;
use pretty_assertions::assert_eq;
use reqwest::Client;
use serde::Deserialize;
use uuid::Uuid;

use crate::DiscoveryAuthorizationOperation;
use crate::DynamicAuthorizationOperation;
use crate::ProviderAuthorizationConfigurationError;
use crate::ProviderAuthorizationError;
use crate::ProviderAuthorizationIdentity;
use crate::ProviderAuthorizationIdentitySpec;
use crate::ProviderAuthorizationRequest;
use crate::ProviderAuthorizer;
use crate::ProviderDynamicAuthorizationBinding;
use crate::ProviderRs256SigningKey;
use crate::ProviderRunAuthorizationBinding;
use crate::Rs256ProviderAuthorizer;
use crate::RunAuthorizationOperation;

const KEY_ID: &str = "provider-signing-2026-07";
const SUBJECT: &str = "user:42";
const TENANT_ID: &str = "7";
const SPACE_ID: &str = "11";
const TEST_RSA_MODULUS: &str = "1qQF2MqTrGAMDm7wXbjJP5sWqGA83tAGUs2ksy7iJXLJdhCg4AtwGm4SFl4f6kxhCSzlN1QdXuZjvRT2wZZiGUi9xUE28rf4WLrTxSnwqLuTy5knMP08yC0t_0YU_FGPZMcWb14hG05IvZr8UbmRaVagxSR8H4rSIymRoVwwmFSrqz068XrWGSYNIfLEASyo5GdAaqmk1JALINHgYGQJVxMxtwcvDxoVKmC7eltUNymMNBZhsv4E8sx9YNLpBoEibznfEpDU_DGzrM5eZCsQzaqbhBOlGd427ifud_Nnd9cPqzgCUc23-0FXSPfpbgksCXAwAmD0OFjQWrgqVdKL6Q";
const TEST_RSA_EXPONENT: &str = "AQAB";

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceClaims {
    iss: String,
    aud: String,
    sub: String,
    jti: String,
    iat: u64,
    exp: u64,
    service_audience: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialClaims {
    credential_id: String,
    owner_subject: String,
    revision: u64,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceClaims {
    provider_id: String,
    resource_type: String,
    resource_id: String,
    revision: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunDelegationClaims {
    iss: String,
    aud: String,
    sub: String,
    jti: String,
    iat: u64,
    exp: u64,
    azp: String,
    tenant_id: String,
    space_id: String,
    task_id: String,
    scopes: Vec<String>,
    purpose: String,
    credential: CredentialClaims,
    resource: ResourceClaims,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscoveryDelegationClaims {
    iss: String,
    aud: String,
    sub: String,
    jti: String,
    iat: u64,
    exp: u64,
    azp: String,
    tenant_id: String,
    space_id: String,
    scopes: Vec<String>,
    purpose: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DynamicDelegationClaims {
    iss: String,
    aud: String,
    sub: String,
    jti: String,
    iat: u64,
    exp: u64,
    azp: String,
    tenant_id: String,
    space_id: String,
    scopes: Vec<String>,
    purpose: String,
    call_id: String,
    action_digest: String,
    credential: CredentialClaims,
    resource: ResourceClaims,
}

#[test]
fn signing_key_and_identity_fail_closed_without_echoing_inputs() {
    let private_marker = "not-a-private-key-secret";
    let invalid_key = ProviderRs256SigningKey::from_rsa_pem(KEY_ID, private_marker.as_bytes());
    let invalid_key_debug = format!("{invalid_key:?}");
    assert_eq!(
        invalid_key.as_ref().err(),
        Some(&ProviderAuthorizationConfigurationError::InvalidSigningKey)
    );
    assert!(!invalid_key_debug.contains(private_marker));

    let private_key_pem = test_rsa_private_key_pem();
    assert_eq!(
        ProviderRs256SigningKey::from_rsa_pem("kid\nforged", &private_key_pem)
            .as_ref()
            .err(),
        Some(&ProviderAuthorizationConfigurationError::InvalidKeyId)
    );

    for spec in [
        identity_spec("42", TENANT_ID, SPACE_ID),
        identity_spec("user:042", TENANT_ID, SPACE_ID),
        identity_spec(SUBJECT, "0", SPACE_ID),
        identity_spec(SUBJECT, TENANT_ID, " 11"),
    ] {
        assert_eq!(
            ProviderAuthorizationIdentity::new(spec),
            Err(ProviderAuthorizationConfigurationError::InvalidIdentity)
        );
    }
}

#[tokio::test]
async fn discovery_authority_is_rs256_signed_exact_and_least_privilege() {
    let authorizer = authorizer();
    let decoding_key = test_decoding_key();
    let operations = [
        (
            DiscoveryAuthorizationOperation::ReadDescriptor,
            "provider:describe",
        ),
        (
            DiscoveryAuthorizationOperation::ReadDynamicResource,
            "dynamicResource:read",
        ),
        (
            DiscoveryAuthorizationOperation::ListResources,
            "resource:list",
        ),
        (
            DiscoveryAuthorizationOperation::ReadResource,
            "resource:read",
        ),
    ];
    let mut delegation_jtis = Vec::new();

    for (operation, expected_scope) in operations {
        let headers = authorizer
            .authorize(ProviderAuthorizationRequest::Discovery(operation))
            .await
            .expect("discovery authorization");
        let (service_token, delegation_token) = issued_tokens(headers);
        assert_header(&service_token, "crewon-service+jwt");
        assert_header(&delegation_token, "crewon-discovery+jwt");

        let service = decode_claims::<ServiceClaims>(
            &service_token,
            &decoding_key,
            "agent-platform-provider-api",
        );
        assert_service_claims(&service);
        let delegation = decode_claims::<DiscoveryDelegationClaims>(
            &delegation_token,
            &decoding_key,
            "agent-platform-provider-discovery",
        );
        let expected = DiscoveryDelegationClaims {
            iss: "crewon".to_string(),
            aud: "agent-platform-provider-discovery".to_string(),
            sub: SUBJECT.to_string(),
            jti: delegation.jti.clone(),
            iat: delegation.iat,
            exp: delegation.exp,
            azp: "crewon-app-server".to_string(),
            tenant_id: TENANT_ID.to_string(),
            space_id: SPACE_ID.to_string(),
            scopes: vec![expected_scope.to_string()],
            purpose: "discoverResources".to_string(),
        };
        assert_eq!(delegation, expected);
        assert_token_window(delegation.iat, delegation.exp);
        assert_valid_jti(&delegation.jti);
        assert_ne!(delegation.jti, service.jti);
        delegation_jtis.push(delegation.jti);
    }

    assert_eq!(delegation_jtis.len(), 4);
    delegation_jtis.sort();
    delegation_jtis.dedup();
    assert_eq!(delegation_jtis.len(), 4);
}

#[tokio::test]
async fn run_authority_binds_exact_operation_resource_task_and_credential_revision() {
    let authorizer = authorizer();
    let decoding_key = test_decoding_key();
    let operations = [
        (RunAuthorizationOperation::Start, "providerRun:start"),
        (RunAuthorizationOperation::Read, "providerRun:read"),
        (RunAuthorizationOperation::ListEvents, "providerRun:events"),
        (RunAuthorizationOperation::Cancel, "providerRun:cancel"),
        (
            RunAuthorizationOperation::DecideApproval,
            "providerRun:approval",
        ),
        (
            RunAuthorizationOperation::SubmitToolResult,
            "providerRun:toolResult",
        ),
    ];

    for (operation, expected_scope) in operations {
        let headers = authorizer
            .authorize(ProviderAuthorizationRequest::Run {
                operation,
                binding: run_binding(),
            })
            .await
            .expect("run authorization");
        let (service_token, delegation_token) = issued_tokens(headers);
        assert_header(&service_token, "crewon-service+jwt");
        assert_header(&delegation_token, "crewon-delegation+jwt");

        let service = decode_claims::<ServiceClaims>(
            &service_token,
            &decoding_key,
            "agent-platform-provider-api",
        );
        assert_service_claims(&service);
        let delegation = decode_claims::<RunDelegationClaims>(
            &delegation_token,
            &decoding_key,
            "agent-platform-provider-run",
        );
        let expected = RunDelegationClaims {
            iss: "crewon".to_string(),
            aud: "agent-platform-provider-run".to_string(),
            sub: SUBJECT.to_string(),
            jti: delegation.jti.clone(),
            iat: delegation.iat,
            exp: delegation.exp,
            azp: "crewon-app-server".to_string(),
            tenant_id: TENANT_ID.to_string(),
            space_id: SPACE_ID.to_string(),
            task_id: "task-demo".to_string(),
            scopes: vec![expected_scope.to_string()],
            purpose: "executeTask".to_string(),
            credential: CredentialClaims {
                credential_id: "credential-demo".to_string(),
                owner_subject: SUBJECT.to_string(),
                revision: 7,
            },
            resource: ResourceClaims {
                provider_id: "agent-platform".to_string(),
                resource_type: "agent".to_string(),
                resource_id: "agent-demo".to_string(),
                revision: "agent-version:7".to_string(),
            },
        };
        assert_eq!(delegation, expected);
        assert_token_window(delegation.iat, delegation.exp);
        assert_valid_jti(&delegation.jti);
        assert_ne!(delegation.jti, service.jti);
    }
}

#[tokio::test]
async fn dynamic_authority_binds_exact_operation_call_action_resource_and_credential() {
    let authorizer = authorizer();
    let decoding_key = test_decoding_key();
    for (operation, kind, scope, resource_type, resource_id, revision) in [
        (
            DynamicAuthorizationOperation::Call,
            ResourceKind::McpTool,
            "providerTool:call",
            "mcpTool",
            "tool-demo",
            "tool-version:3",
        ),
        (
            DynamicAuthorizationOperation::Search,
            ResourceKind::KnowledgeBase,
            "providerKnowledge:search",
            "knowledgeBase",
            "knowledge-demo",
            "knowledge-version:5",
        ),
    ] {
        let headers = authorizer
            .authorize(ProviderAuthorizationRequest::Dynamic {
                operation,
                binding: dynamic_binding(kind, resource_id, revision),
            })
            .await
            .expect("dynamic authorization");
        let (service_token, delegation_token) = issued_tokens(headers);
        assert_header(&service_token, "crewon-service+jwt");
        assert_header(&delegation_token, "crewon-dynamic-delegation+jwt");
        assert_service_claims(&decode_claims::<ServiceClaims>(
            &service_token,
            &decoding_key,
            "agent-platform-provider-api",
        ));
        let delegation = decode_claims::<DynamicDelegationClaims>(
            &delegation_token,
            &decoding_key,
            "agent-platform-provider-dynamic",
        );
        assert_eq!(
            delegation,
            DynamicDelegationClaims {
                iss: "crewon".to_string(),
                aud: "agent-platform-provider-dynamic".to_string(),
                sub: SUBJECT.to_string(),
                jti: delegation.jti.clone(),
                iat: delegation.iat,
                exp: delegation.exp,
                azp: "crewon-app-server".to_string(),
                tenant_id: TENANT_ID.to_string(),
                space_id: SPACE_ID.to_string(),
                scopes: vec![scope.to_string()],
                purpose: "executeDynamicResource".to_string(),
                call_id: "tool-call-001".to_string(),
                action_digest: format!("sha256:{}", "f".repeat(64)),
                credential: CredentialClaims {
                    credential_id: "credential-demo".to_string(),
                    owner_subject: SUBJECT.to_string(),
                    revision: 7,
                },
                resource: ResourceClaims {
                    provider_id: "agent-platform".to_string(),
                    resource_type: resource_type.to_string(),
                    resource_id: resource_id.to_string(),
                    revision: revision.to_string(),
                },
            }
        );
        assert_token_window(delegation.iat, delegation.exp);
        assert_valid_jti(&delegation.jti);
    }

    assert!(matches!(
        authorizer
            .authorize(ProviderAuthorizationRequest::Dynamic {
                operation: DynamicAuthorizationOperation::Search,
                binding: dynamic_binding(ResourceKind::McpTool, "tool-demo", "tool-version:3"),
            })
            .await,
        Err(ProviderAuthorizationError::Unauthorized)
    ));
}

#[tokio::test]
async fn tokens_verify_only_with_the_configured_public_key_and_debug_is_redacted() {
    let authorizer = authorizer();
    let debug = format!("{authorizer:?}");
    assert!(!debug.contains(SUBJECT));
    assert_eq!(debug, "Rs256ProviderAuthorizer([REDACTED])");

    let headers = authorizer
        .authorize(ProviderAuthorizationRequest::Discovery(
            DiscoveryAuthorizationOperation::ReadDescriptor,
        ))
        .await
        .expect("authorization");
    let (_service_token, delegation_token) = issued_tokens(headers);
    let mut validation = validation("agent-platform-provider-discovery");
    let mut wrong_modulus = TEST_RSA_MODULUS.to_string();
    wrong_modulus.replace_range(..1, "2");
    let result = decode::<DiscoveryDelegationClaims>(
        &delegation_token,
        &DecodingKey::from_rsa_components(&wrong_modulus, TEST_RSA_EXPONENT)
            .expect("other public key"),
        &validation,
    );
    assert!(result.is_err());

    validation.set_audience(&["agent-platform-provider-run"]);
    let result =
        decode::<DiscoveryDelegationClaims>(&delegation_token, &test_decoding_key(), &validation);
    assert!(result.is_err());
}

#[tokio::test]
async fn shared_signing_key_issues_identity_scoped_authorizers_without_exposing_key_material() {
    let signing_key = Arc::new(
        ProviderRs256SigningKey::from_rsa_pem(KEY_ID, &test_rsa_private_key_pem())
            .expect("shared signing key"),
    );
    let first = Rs256ProviderAuthorizer::from_shared(
        signing_key.clone(),
        ProviderAuthorizationIdentity::new(identity_spec(SUBJECT, TENANT_ID, SPACE_ID))
            .expect("first identity"),
    );
    let second = Rs256ProviderAuthorizer::from_shared(
        signing_key,
        ProviderAuthorizationIdentity::new(identity_spec("user:43", TENANT_ID, SPACE_ID))
            .expect("second identity"),
    );

    let first_headers = first
        .authorize(ProviderAuthorizationRequest::Discovery(
            DiscoveryAuthorizationOperation::ReadDescriptor,
        ))
        .await
        .expect("first authorization");
    let second_headers = second
        .authorize(ProviderAuthorizationRequest::Discovery(
            DiscoveryAuthorizationOperation::ReadDescriptor,
        ))
        .await
        .expect("second authorization");
    let (_, first_delegation) = issued_tokens(first_headers);
    let (_, second_delegation) = issued_tokens(second_headers);
    let first_claims = decode_claims::<DiscoveryDelegationClaims>(
        &first_delegation,
        &test_decoding_key(),
        "agent-platform-provider-discovery",
    );
    let second_claims = decode_claims::<DiscoveryDelegationClaims>(
        &second_delegation,
        &test_decoding_key(),
        "agent-platform-provider-discovery",
    );

    assert_eq!(first_claims.sub, SUBJECT);
    assert_eq!(second_claims.sub, "user:43");
    assert_ne!(first_claims.jti, second_claims.jti);
    assert_eq!(format!("{first:?}"), "Rs256ProviderAuthorizer([REDACTED])");
}

#[tokio::test]
async fn run_issuer_rejects_resource_text_the_provider_would_reject() {
    let authorizer = authorizer();
    let binding = ProviderRunAuthorizationBinding::new(
        ResourceRef {
            provider: ProviderRef {
                provider_id: ProviderId::new("agent-platform").expect("provider id"),
                protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
            },
            kind: ResourceKind::Agent,
            resource_id: ResourceId::new("a".repeat(256)).expect("federation resource id"),
            revision: ResourceRevision::new("agent-version:7").expect("revision"),
        },
        "task-demo",
        "credential-demo",
        /*credential_revision*/ 7,
    )
    .expect("federation binding");

    assert!(matches!(
        authorizer
            .authorize(ProviderAuthorizationRequest::Run {
                operation: RunAuthorizationOperation::Start,
                binding,
            })
            .await,
        Err(ProviderAuthorizationError::Unauthorized)
    ));
}

fn authorizer() -> Rs256ProviderAuthorizer {
    let private_key_pem = test_rsa_private_key_pem();
    let signing_key =
        ProviderRs256SigningKey::from_rsa_pem(KEY_ID, &private_key_pem).expect("signing key");
    let identity = ProviderAuthorizationIdentity::new(identity_spec(SUBJECT, TENANT_ID, SPACE_ID))
        .expect("identity");
    Rs256ProviderAuthorizer::new(signing_key, identity)
}

fn identity_spec(
    subject: &str,
    tenant_id: &str,
    space_id: &str,
) -> ProviderAuthorizationIdentitySpec {
    ProviderAuthorizationIdentitySpec {
        subject: subject.to_string(),
        tenant_id: tenant_id.to_string(),
        space_id: space_id.to_string(),
    }
}

fn run_binding() -> ProviderRunAuthorizationBinding {
    ProviderRunAuthorizationBinding::new(
        ResourceRef {
            provider: ProviderRef {
                provider_id: ProviderId::new("agent-platform").expect("provider id"),
                protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
            },
            kind: ResourceKind::Agent,
            resource_id: ResourceId::new("agent-demo").expect("resource id"),
            revision: ResourceRevision::new("agent-version:7").expect("revision"),
        },
        "task-demo",
        "credential-demo",
        /*credential_revision*/ 7,
    )
    .expect("run binding")
}

fn dynamic_binding(
    kind: ResourceKind,
    resource_id: &str,
    revision: &str,
) -> ProviderDynamicAuthorizationBinding {
    ProviderDynamicAuthorizationBinding::new(
        ResourceRef {
            provider: ProviderRef {
                provider_id: ProviderId::new("agent-platform").expect("provider id"),
                protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
            },
            kind,
            resource_id: ResourceId::new(resource_id).expect("resource id"),
            revision: ResourceRevision::new(revision).expect("revision"),
        },
        "tool-call-001",
        format!("sha256:{}", "f".repeat(64)),
        "credential-demo",
        /*credential_revision*/ 7,
    )
    .expect("dynamic binding")
}

fn issued_tokens(headers: crate::ProviderAuthorizationHeaders) -> (String, String) {
    let request = headers
        .apply(Client::new().get("https://provider.example/provider/v3/descriptor:read"))
        .build()
        .expect("request");
    let service = request.headers()["authorization"]
        .to_str()
        .expect("authorization header")
        .strip_prefix("Bearer ")
        .expect("bearer scheme")
        .to_string();
    let delegation = request.headers()["x-crewon-delegation"]
        .to_str()
        .expect("delegation header")
        .to_string();
    (service, delegation)
}

fn assert_header(token: &str, token_type: &str) {
    let header = decode_header(token).expect("JOSE header");
    let mut expected = Header::new(Algorithm::RS256);
    expected.typ = Some(token_type.to_string());
    expected.kid = Some(KEY_ID.to_string());
    assert_eq!(header, expected);
}

fn decode_claims<Claims>(token: &str, decoding_key: &DecodingKey, audience: &str) -> Claims
where
    Claims: serde::de::DeserializeOwned,
{
    decode::<Claims>(token, decoding_key, &validation(audience))
        .expect("verified token")
        .claims
}

fn test_decoding_key() -> DecodingKey {
    DecodingKey::from_rsa_components(TEST_RSA_MODULUS, TEST_RSA_EXPONENT).expect("test public key")
}

fn test_rsa_private_key_pem() -> Vec<u8> {
    let path =
        crewon_utils_cargo_bin::find_resource!("tests/fixtures/provider_rs256_test_private.pem")
            .expect("resolve test RSA private key fixture");
    std::fs::read(path).expect("read test RSA private key fixture")
}

fn validation(audience: &str) -> Validation {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[audience]);
    validation.set_issuer(&["crewon"]);
    validation.set_required_spec_claims(&["iss", "aud", "sub", "exp"]);
    validation
}

fn assert_service_claims(claims: &ServiceClaims) {
    let expected = ServiceClaims {
        iss: "crewon".to_string(),
        aud: "agent-platform-provider-api".to_string(),
        sub: "crewon-app-server".to_string(),
        jti: claims.jti.clone(),
        iat: claims.iat,
        exp: claims.exp,
        service_audience: "crewon-task-control".to_string(),
    };
    assert_eq!(claims, &expected);
    assert_token_window(claims.iat, claims.exp);
    assert_valid_jti(&claims.jti);
}

fn assert_token_window(iat: u64, exp: u64) {
    assert_eq!(exp - iat, 5 * 60);
}

fn assert_valid_jti(jti: &str) {
    assert!(Uuid::parse_str(jti).is_ok());
}
use std::sync::Arc;
