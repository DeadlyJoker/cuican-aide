use std::collections::HashMap;

use crewon_provider_agent_platform::ProviderAuthorizationIdentity;
use crewon_provider_agent_platform::ProviderAuthorizationIdentitySpec;
use pretty_assertions::assert_eq;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_descriptor::ProviderDescriptorReadRequest;
use super::provider_connection_descriptor::ProviderDescriptorReader;
use super::provider_connection_production::PreparedProviderConnectionProduction;
use super::provider_connection_production::SystemProviderConnectionClock;

#[tokio::test]
async fn production_factory_is_explicitly_enabled_and_never_reuses_legacy_open_api_config() {
    let legacy_only = HashMap::from([
        (
            "CREWON_AGENT_PLATFORM_BASE_URL".to_string(),
            "https://legacy.example".to_string(),
        ),
        (
            "CREWON_AGENT_PLATFORM_API_KEY".to_string(),
            "legacy-secret".to_string(),
        ),
    ]);
    assert!(
        PreparedProviderConnectionProduction::from_environment(&legacy_only)
            .await
            .expect("legacy config ignored")
            .is_none()
    );

    let invalid_flag = HashMap::from([(
        "CREWON_PROVIDER_AGENT_PLATFORM_ENABLED".to_string(),
        "yes".to_string(),
    )]);
    let error = match PreparedProviderConnectionProduction::from_environment(&invalid_flag).await {
        Ok(_) => panic!("ambiguous flag rejected"),
        Err(error) => error,
    };
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);

    let missing_config = HashMap::from([(
        "CREWON_PROVIDER_AGENT_PLATFORM_ENABLED".to_string(),
        "true".to_string(),
    )]);
    let error = match PreparedProviderConnectionProduction::from_environment(&missing_config).await
    {
        Ok(_) => panic!("partial config rejected"),
        Err(error) => error,
    };
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);

    let key_file = private_signing_key_file();
    let identity_source_url = HashMap::from([
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_ENABLED".to_string(),
            "true".to_string(),
        ),
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_URL".to_string(),
            "http://127.0.0.1:9/identity/v1/".to_string(),
        ),
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_ENDPOINT_MODE".to_string(),
            "development-loopback".to_string(),
        ),
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_KEY_ID".to_string(),
            "provider-signing-test".to_string(),
        ),
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_PRIVATE_KEY_FILE".to_string(),
            key_file.path().display().to_string(),
        ),
    ]);
    let error =
        match PreparedProviderConnectionProduction::from_environment(&identity_source_url).await {
            Ok(_) => panic!("identity-source endpoint cannot stand in for Provider v3"),
            Err(error) => error,
        };
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
}

#[tokio::test]
async fn production_factory_reads_strict_live_descriptor_with_rs256_authority() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "providerId": "agent-platform",
            "protocolVersion": "3.0.0",
            "capabilities": ["durableRun", "remoteAgent", "resumableEvents"],
            "resourceCapabilities": [{
                "resourceType": "agent",
                "bindingMode": "providerManaged",
                "executionLocation": "provider"
            }]
        })))
        .expect(1)
        .mount(&server)
        .await;
    let key_file = private_signing_key_file();
    let environment = HashMap::from([
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_ENABLED".to_string(),
            "true".to_string(),
        ),
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_URL".to_string(),
            format!("{}/provider/v3/", server.uri()),
        ),
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_ENDPOINT_MODE".to_string(),
            "development-loopback".to_string(),
        ),
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_KEY_ID".to_string(),
            "provider-signing-test".to_string(),
        ),
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_PRIVATE_KEY_FILE".to_string(),
            key_file.path().display().to_string(),
        ),
    ]);
    let production = PreparedProviderConnectionProduction::from_environment(&environment)
        .await
        .expect("prepare production factory")
        .expect("enabled production factory");
    let descriptor = production
        .factory()
        .read_descriptor(ProviderDescriptorReadRequest {
            provider_id: "agent-platform".to_string(),
            authorization_identity: ProviderAuthorizationIdentity::new(
                ProviderAuthorizationIdentitySpec {
                    subject: "user:42".to_string(),
                    tenant_id: "7".to_string(),
                    space_id: "11".to_string(),
                },
            )
            .expect("mapped identity"),
        })
        .await
        .expect("read live descriptor");

    assert_eq!(descriptor.provider().provider_id.as_str(), "agent-platform");
    assert_eq!(descriptor.provider().protocol_version.as_str(), "3.0.0");
    assert_eq!(descriptor.capabilities().len(), 3);
    assert!(SystemProviderConnectionClock.now() > 0);
    assert_eq!(
        format!("{:?}", production.factory()),
        "AgentPlatformProviderDescriptorFactory([REDACTED])"
    );
    let requests = server.received_requests().await.expect("received requests");
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert!(
        request.headers["authorization"]
            .to_str()
            .expect("authorization")
            .starts_with("Bearer ")
    );
    assert!(request.headers.contains_key("x-crewon-delegation"));
    let body = String::from_utf8(request.body.clone()).expect("descriptor request body");
    assert!(!body.contains("PRIVATE KEY"));
    assert!(!body.contains("legacy-secret"));
    assert!(!body.contains("user:42"));
}

fn private_signing_key_file() -> tempfile::NamedTempFile {
    let source = crewon_utils_cargo_bin::find_resource!(
        "../provider-agent-platform/tests/fixtures/provider_rs256_test_private.pem"
    )
    .expect("RSA fixture");
    let key = std::fs::read(source).expect("read RSA fixture");
    let file = tempfile::NamedTempFile::new().expect("private key file");
    std::fs::write(file.path(), key).expect("write private key");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600))
            .expect("private key permissions");
    }
    file
}
