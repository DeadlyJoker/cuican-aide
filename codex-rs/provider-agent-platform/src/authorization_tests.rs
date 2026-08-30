use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use pretty_assertions::assert_eq;
use reqwest::Client;

use super::*;

const SERVICE_SECRET: &str = "service-secret-value-that-must-not-leak";
const DELEGATION_SECRET: &str = "delegation-secret-value-that-must-not-leak";

#[test]
fn authorization_headers_are_sensitive_and_debug_redacted() {
    let headers = ProviderAuthorizationHeaders::new(
        ServiceBearerToken::new(SERVICE_SECRET).expect("service token"),
        DelegationToken::new(DELEGATION_SECRET).expect("delegation token"),
    )
    .expect("authorization headers");

    let debug = format!("{headers:?}");
    assert!(!debug.contains(SERVICE_SECRET));
    assert!(!debug.contains(DELEGATION_SECRET));
    assert_eq!(
        debug,
        "ProviderAuthorizationHeaders { authorization: \"[REDACTED]\", delegation: \"[REDACTED]\" }"
    );

    let request = headers
        .apply(Client::new().get("https://provider.example/provider/v3/descriptor:read"))
        .build()
        .expect("request");
    assert!(request.headers()["authorization"].is_sensitive());
    assert!(request.headers()["x-crewon-delegation"].is_sensitive());
}

#[test]
fn authorization_tokens_reject_empty_oversized_and_header_injection() {
    let oversized = "x".repeat(MAX_TOKEN_BYTES + 1);
    for result in [
        ServiceBearerToken::new(String::new()).map(|_| ()),
        ServiceBearerToken::new(oversized).map(|_| ()),
        DelegationToken::new("value\r\ninjected: true").map(|_| ()),
    ] {
        assert_eq!(result, Err(ProviderAuthorizationError::Unauthorized));
    }
}

#[test]
fn token_debug_never_contains_the_secret() {
    let service = ServiceBearerToken::new(SERVICE_SECRET).expect("service token");
    let delegation = DelegationToken::new(DELEGATION_SECRET).expect("delegation token");

    assert_eq!(format!("{service:?}"), "ServiceBearerToken([REDACTED])");
    assert_eq!(format!("{delegation:?}"), "DelegationToken([REDACTED])");
}

#[test]
fn run_authorization_binding_requires_exact_agent_resource_task_and_credential() {
    let resource = ResourceRef {
        provider: ProviderRef {
            provider_id: ProviderId::new("agent-platform").expect("provider id"),
            protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
        },
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new("agent-demo").expect("resource id"),
        revision: ResourceRevision::new("agent-version:7").expect("revision"),
    };
    let binding = ProviderRunAuthorizationBinding::new(
        resource.clone(),
        "task-demo",
        "credential-demo",
        /*credential_revision*/ 7,
    )
    .expect("run binding");

    assert_eq!(binding.resource(), &resource);
    assert_eq!(binding.task_id(), "task-demo");
    assert_eq!(binding.credential_id(), "credential-demo");
    assert_eq!(binding.credential_revision(), 7);
    assert_eq!(
        ProviderRunAuthorizationBinding::new(
            resource.clone(),
            "task\nforged",
            "credential-demo",
            /*credential_revision*/ 7,
        ),
        Err(ProviderAuthorizationError::Unauthorized)
    );
    assert_eq!(
        ProviderRunAuthorizationBinding::new(
            resource,
            "task-demo",
            "credential-demo",
            /*credential_revision*/ 0,
        ),
        Err(ProviderAuthorizationError::Unauthorized)
    );
}

#[test]
fn dynamic_authorization_binding_requires_exact_resource_action_and_credential() {
    let resource = ResourceRef {
        provider: ProviderRef {
            provider_id: ProviderId::new("agent-platform").expect("provider id"),
            protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
        },
        kind: ResourceKind::McpTool,
        resource_id: ResourceId::new("tool-demo").expect("resource id"),
        revision: ResourceRevision::new("tool-version:3").expect("revision"),
    };
    let digest = format!("sha256:{}", "a".repeat(64));
    let binding = ProviderDynamicAuthorizationBinding::new(
        resource.clone(),
        "tool-call-demo",
        digest.clone(),
        "credential-demo",
        /*credential_revision*/ 7,
    )
    .expect("dynamic binding");

    assert_eq!(binding.resource(), &resource);
    assert_eq!(binding.call_id(), "tool-call-demo");
    assert_eq!(binding.action_digest(), digest);
    assert_eq!(binding.credential_id(), "credential-demo");
    assert_eq!(binding.credential_revision(), 7);
    assert_eq!(
        ProviderDynamicAuthorizationBinding::new(
            resource,
            "tool-call-demo",
            "sha256:not-canonical",
            "credential-demo",
            /*credential_revision*/ 7,
        ),
        Err(ProviderAuthorizationError::Unauthorized)
    );
}
