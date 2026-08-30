use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use crewon_app_server_protocol::ProviderConnectParams;
use crewon_app_server_protocol::ProviderReadParams;
use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_app_server_protocol::ResourceListParams;
use crewon_app_server_protocol::ResourceReadParams;
use crewon_app_server_protocol::ResourceType;
use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_state::ProviderAccessGrantRecord;
use crewon_state::ProviderAccessGrantResolveOutcome;
use crewon_state::ProviderAccessGrantStatus;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;
use serde_json::Value;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_partial_json;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::ConnectionRequestIdentity;
use super::authenticated_principal::AuthenticatedPrincipal;
use super::authenticated_principal::AuthenticatedPrincipalBinding;
use super::authenticated_principal::AuthenticatedPrincipalSource;
use super::authenticated_principal::AuthenticatedPrincipalSpec;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_startup::prepare_provider_connection_runtime;
use super::provider_identity_refresh::apply_provider_identity_source_snapshot;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadError;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadRequest;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReader;
use crate::request_processors::ProviderConnectionRequestProcessor;
use crate::request_processors::ProviderResourceRequestProcessor;
use crate::transport::ConnectionOrigin;

const CANONICAL: &str =
    include_str!("../../../app-server-protocol/schema/canonical/provider_identity_source.v1.json");
const NOW: i64 = 1_785_000_101;

#[tokio::test]
async fn provider_rpc_processors_connect_list_read_and_map_errors_without_authority_leaks() {
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
        .expect(4)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/resources:list"))
        .and(body_partial_json(serde_json::json!({
            "type": "listResources",
            "resourceType": "agent",
            "afterCursor": null,
            "limit": 20
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{
                "resource": {
                    "providerId": "agent-platform",
                    "resourceType": "agent",
                    "resourceId": "agent-demo",
                    "revision": "agent-version:7"
                },
                "manifestSchemaVersion": "1.0.0",
                "contentDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }],
            "nextCursor": null
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/resources:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "resource": {
                "providerId": "agent-platform",
                "resourceType": "agent",
                "resourceId": "agent-demo",
                "revision": "agent-version:7"
            },
            "manifestSchemaVersion": "1.0.0",
            "contentDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let key_file = private_signing_key_file();
    let environment = enabled_environment(&format!("{}/provider/v3/", server.uri()), &key_file);
    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    apply_provider_identity_source_snapshot(&state, &owner(), &snapshot())
        .await
        .expect("create identity mapping");
    let identity = authenticated_identity();
    let grant = discovery_grant(&identity);
    assert_eq!(
        state
            .resolve_provider_access_grant_record(&grant)
            .await
            .expect("create grant"),
        ProviderAccessGrantResolveOutcome::Created(grant)
    );
    let reader = FixedReader {
        snapshot: snapshot(),
        requests: Mutex::new(Vec::new()),
    };
    let runtime = prepare_provider_connection_runtime(
        &environment,
        Some(state.clone()),
        Some(&reader),
        FixedClock,
        NOW,
    )
    .await
    .expect("prepare runtime")
    .expect("enabled runtime");
    let runtime = Arc::new(runtime);
    let processor = ProviderConnectionRequestProcessor::new(Some(Arc::clone(&runtime)));
    let resource_processor =
        ProviderResourceRequestProcessor::new(Some(runtime), Some(Arc::clone(&state)));

    let connected = processor
        .connect(
            &identity,
            ProviderConnectParams {
                provider_id: "agent-platform".to_string(),
            },
        )
        .await
        .expect("connect response");
    let read = processor
        .read(
            &identity,
            ProviderReadParams {
                connection_id: connected.provider.connection_id.clone(),
            },
        )
        .await
        .expect("read response");
    assert_eq!(read.provider, connected.provider);
    let listed = resource_processor
        .list(
            &identity,
            ResourceListParams {
                connection_id: connected.provider.connection_id.clone(),
                cursor: None,
                limit: Some(20),
                resource_type: Some(ResourceType::Agent),
            },
        )
        .await
        .expect("resource list response");
    let resource_read = resource_processor
        .read(
            &identity,
            ResourceReadParams {
                connection_id: connected.provider.connection_id.clone(),
                resource: listed.data[0].clone(),
            },
        )
        .await
        .expect("resource read response");
    assert_eq!(resource_read.manifest.resource, listed.data[0]);
    assert_eq!(listed.provider_etag, connected.provider.projection_etag);
    assert_eq!(
        resource_read.provider_etag,
        connected.provider.projection_etag
    );

    let invalid_limit = resource_processor
        .list(
            &identity,
            ResourceListParams {
                connection_id: connected.provider.connection_id.clone(),
                cursor: None,
                limit: Some(0),
                resource_type: None,
            },
        )
        .await
        .expect_err("invalid resource limit rejected");
    assert_eq!(invalid_limit.code, -32602);
    assert_eq!(
        invalid_limit.message,
        "Provider resource request is invalid"
    );

    let invalid = processor
        .connect(
            &identity,
            ProviderConnectParams {
                provider_id: "forged-provider".to_string(),
            },
        )
        .await
        .expect_err("unknown provider rejected");
    assert_eq!(invalid.code, -32602);
    assert_eq!(invalid.message, "Provider connection request is invalid");
    assert!(!invalid.message.contains("grant"));
    assert!(!invalid.message.contains("source"));
    state.close().await;
}

#[tokio::test]
async fn provider_rpc_processor_fails_closed_without_prepared_runtime() {
    let processor = ProviderConnectionRequestProcessor::<FixedClock>::new(/*runtime*/ None);
    let resource_processor = ProviderResourceRequestProcessor::<FixedClock>::new(
        /*runtime*/ None, /*state*/ None,
    );
    let identity = authenticated_identity();
    let connect = processor
        .connect(
            &identity,
            ProviderConnectParams {
                provider_id: "agent-platform".to_string(),
            },
        )
        .await
        .expect_err("disabled connect rejected");
    let read = processor
        .read(
            &identity,
            ProviderReadParams {
                connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101"
                    .to_string(),
            },
        )
        .await
        .expect_err("disabled read rejected");
    assert_eq!(connect, read);
    assert_eq!(connect.code, -32603);
    assert_eq!(
        connect.message,
        "Provider connection runtime is unavailable"
    );
    let resource = resource_processor
        .list(
            &identity,
            ResourceListParams {
                connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101"
                    .to_string(),
                cursor: None,
                limit: None,
                resource_type: None,
            },
        )
        .await
        .expect_err("disabled resource list rejected");
    assert_eq!(resource.code, -32603);
    assert_eq!(resource.message, "Provider resource runtime is unavailable");
}

#[derive(Clone, Copy)]
struct FixedClock;

impl ProviderConnectionClock for FixedClock {
    fn now(&self) -> i64 {
        NOW
    }
}

struct FixedReader {
    snapshot: ProviderIdentitySourceSnapshot,
    requests: Mutex<Vec<ProviderIdentitySourceReadRequest>>,
}

impl ProviderIdentitySourceReader for FixedReader {
    async fn read(
        &self,
        request: ProviderIdentitySourceReadRequest,
        _now: i64,
    ) -> Result<ProviderIdentitySourceSnapshot, ProviderIdentitySourceReadError> {
        self.requests.lock().expect("request lock").push(request);
        Ok(self.snapshot.clone())
    }
}

fn owner() -> crewon_state::ProviderIdentityBindingLookup {
    crewon_state::ProviderIdentityBindingLookup {
        local_actor_id:
            "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f".to_string(),
        local_tenant_id: "7".to_string(),
        local_space_id: "11".to_string(),
        provider_id: "agent-platform".to_string(),
    }
}

fn snapshot() -> ProviderIdentitySourceSnapshot {
    let mut wire: Value = serde_json::from_str(CANONICAL).expect("canonical JSON");
    wire["freshness"]["issuedAt"] = 1_785_000_100_i64.into();
    wire["freshness"]["freshUntil"] = 1_785_000_160_i64.into();
    ProviderIdentitySourceSnapshot::parse(&serde_json::to_vec(&wire).expect("snapshot JSON"), NOW)
        .expect("snapshot")
}

fn authenticated_identity() -> super::RequestIdentity {
    ConnectionRequestIdentity::new_authenticated(
        ConnectionOrigin::WebSocket,
        AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
            source: AuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
            issuer: "agent-platform".to_string(),
            audience: "crewon-app-server".to_string(),
            subject: "user:42".to_string(),
            tenant_id: "7".to_string(),
            space_id: "11".to_string(),
            token_id: "019f6f00-0000-7000-8000-000000000002".to_string(),
            issued_at: 1_785_000_000,
            expires_at: 1_785_000_300,
            binding: AuthenticatedPrincipalBinding::AgentPlatform {
                source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
                source_revision: 1,
            },
        })
        .expect("authenticated principal"),
    )
    .derive(
        RequestIdentityClientRef {
            name: "provider-rpc-test".to_string(),
            version: "0.1.0".to_string(),
            capabilities: RequestIdentityClientCapabilitiesRef {
                experimental_api: true,
                request_attestation: false,
            },
        },
        "provider-rpc-trace".to_string(),
    )
}

fn discovery_grant(identity: &super::RequestIdentity) -> ProviderAccessGrantRecord {
    let reference = identity.reference();
    let mut grant = ProviderAccessGrantRecord {
        grant_id: "provider-grant:019f6f00-0000-7000-8000-000000000003".to_string(),
        local_actor_id: reference.actor_id.clone(),
        local_tenant_id: reference.tenant_id.clone().expect("tenant"),
        local_space_id: reference.space_id.clone().expect("space"),
        provider_id: "agent-platform".to_string(),
        source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
        source_revision: 1,
        granted_scopes: super::provider_access_grant_scope::agent_platform_scopes(),
        status: ProviderAccessGrantStatus::Active,
        expires_at: 1_785_000_300,
        revision: 1,
        record_hash: String::new(),
        created_at: 1_785_000_000,
        updated_at: 1_785_000_000,
        revoked_at: None,
    };
    grant.record_hash = grant.canonical_hash();
    grant
}

fn enabled_environment(
    endpoint: &str,
    key_file: &tempfile::NamedTempFile,
) -> HashMap<String, String> {
    HashMap::from([
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_ENABLED".to_string(),
            "true".to_string(),
        ),
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_URL".to_string(),
            endpoint.to_string(),
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
    ])
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

async fn initialized(home: &tempfile::TempDir) -> Arc<StateRuntime> {
    StateRuntime::init(home.path().to_path_buf(), "provider-rpc-test".to_string())
        .await
        .expect("initialize state")
}
