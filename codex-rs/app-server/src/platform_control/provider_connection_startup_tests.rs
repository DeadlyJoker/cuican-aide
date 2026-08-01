use std::collections::HashMap;
use std::sync::Mutex;

use crewon_app_server_protocol::ProviderConnectionStatus;
use crewon_app_server_protocol::ResourceListParams;
use crewon_app_server_protocol::ResourceReadParams;
use crewon_app_server_protocol::ResourceType;
use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_state::ProviderAccessGrantResolveOutcome;
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
use super::provider_access_grant_authority_tests::discovery_grant;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_startup::prepare_provider_connection_runtime;
use super::provider_identity_adapter_tests::declared_client;
use super::provider_identity_refresh::apply_provider_identity_source_snapshot;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadError;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadRequest;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReader;
use crate::transport::ConnectionOrigin;

const CANONICAL: &str =
    include_str!("../../../app-server-protocol/schema/canonical/provider_identity_source.v1.json");
const NOW: i64 = 1_785_000_101;

#[tokio::test]
async fn disabled_or_removed_provider_config_does_not_require_or_reuse_authority() {
    assert!(
        prepare_provider_connection_runtime::<FixedReader, FixedClock>(
            &HashMap::new(),
            /*state*/ None,
            /*identity_reader*/ None,
            FixedClock(NOW),
            NOW,
        )
        .await
        .expect("disabled startup")
        .is_none()
    );

    let home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&home).await;
    apply_provider_identity_source_snapshot(&state, &owner(), &initial_snapshot())
        .await
        .expect("create initial mapping");
    let disabled_after_restart = prepare_provider_connection_runtime::<FixedReader, FixedClock>(
        &HashMap::new(),
        Some(state.clone()),
        /*identity_reader*/ None,
        FixedClock(NOW),
        NOW,
    )
    .await
    .expect("config removal");
    assert!(disabled_after_restart.is_none());
    state.close().await;
}

#[tokio::test]
async fn enabled_startup_requires_state_principal_reader_and_fresh_mappings() {
    let key_file = private_signing_key_file();
    let environment = enabled_environment("http://127.0.0.1:9/provider/v3/", &key_file);
    let reader = FixedReader {
        snapshot: Some(refreshed_snapshot()),
        requests: Mutex::new(Vec::new()),
    };
    let state_home = tempfile::TempDir::new().expect("state home");
    let state = initialized(&state_home).await;

    let missing_state = prepare_provider_connection_runtime(
        &environment,
        /*state*/ None,
        Some(&reader),
        FixedClock(NOW),
        NOW,
    )
    .await
    .expect_err("missing state rejected");
    assert_eq!(missing_state.kind(), std::io::ErrorKind::InvalidInput);

    let missing_reader = prepare_provider_connection_runtime::<FixedReader, FixedClock>(
        &environment,
        Some(state.clone()),
        /*identity_reader*/ None,
        FixedClock(NOW),
        NOW,
    )
    .await
    .expect_err("missing principal reader rejected");
    assert_eq!(missing_reader.kind(), std::io::ErrorKind::InvalidInput);

    let invalid_clock = prepare_provider_connection_runtime(
        &environment,
        Some(state.clone()),
        Some(&reader),
        FixedClock(-1),
        /*now*/ -1,
    )
    .await
    .expect_err("invalid clock rejected");
    assert_eq!(invalid_clock.kind(), std::io::ErrorKind::ConnectionRefused);

    apply_provider_identity_source_snapshot(&state, &owner(), &initial_snapshot())
        .await
        .expect("create initial mapping");
    let unavailable = FixedReader {
        snapshot: None,
        requests: Mutex::new(Vec::new()),
    };
    let source_error = prepare_provider_connection_runtime(
        &environment,
        Some(state.clone()),
        Some(&unavailable),
        FixedClock(NOW),
        NOW,
    )
    .await
    .expect_err("source unavailable rejected");
    assert_eq!(source_error.kind(), std::io::ErrorKind::ConnectionRefused);
    state.close().await;
}

#[tokio::test]
async fn restart_refreshes_mappings_and_composes_real_provider_runtime() {
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
        .expect(3)
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
            "nextCursor": "agent-version-row:71"
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
    apply_provider_identity_source_snapshot(&state, &owner(), &initial_snapshot())
        .await
        .expect("create initial mapping");
    let identity = authenticated_identity();
    let grant = discovery_grant(&identity, /*expires_at*/ 1_785_000_300);
    assert_eq!(
        state
            .resolve_provider_access_grant_record(&grant)
            .await
            .expect("create grant"),
        ProviderAccessGrantResolveOutcome::Created(grant)
    );
    let reader = FixedReader {
        snapshot: Some(refreshed_snapshot()),
        requests: Mutex::new(Vec::new()),
    };
    {
        let runtime = prepare_provider_connection_runtime(
            &environment,
            Some(state.clone()),
            Some(&reader),
            FixedClock(NOW),
            NOW,
        )
        .await
        .expect("prepare runtime")
        .expect("enabled runtime");
        assert_eq!(runtime.readiness().refreshed_bindings(), 1);
        assert_eq!(runtime.readiness().completed_at(), NOW);
        let projection = runtime
            .connect(&identity, "agent-platform")
            .await
            .expect("connect through production runtime");
        assert_eq!(projection.status, ProviderConnectionStatus::Connected);
        let listed = runtime
            .list_resources(
                &identity,
                ResourceListParams {
                    connection_id: projection.connection_id.clone(),
                    cursor: None,
                    limit: Some(20),
                    resource_type: Some(ResourceType::Agent),
                },
            )
            .await
            .expect("list through production runtime");
        let read = runtime
            .read_resource(
                &identity,
                ResourceReadParams {
                    connection_id: projection.connection_id.clone(),
                    resource: listed.data[0].clone(),
                },
            )
            .await
            .expect("read through production runtime");
        assert_eq!(listed.next_cursor.as_deref(), Some("agent-version-row:71"));
        assert_eq!(read.manifest.resource, listed.data[0]);
        assert_eq!(listed.provider_etag, projection.projection_etag);
        assert_eq!(read.provider_etag, projection.projection_etag);
        let serialized = serde_json::to_string(&projection).expect("serialize projection");
        assert!(!serialized.contains("credential"));
        assert_eq!(
            format!("{runtime:?}"),
            "PreparedProviderConnectionRuntime([REDACTED])"
        );
        assert_eq!(reader.requests.lock().expect("request lock").len(), 1);
    }
    state.close().await;

    let reopened = initialized(&home).await;
    let restart_reader = FixedReader {
        snapshot: Some(refreshed_snapshot()),
        requests: Mutex::new(Vec::new()),
    };
    {
        let restarted = prepare_provider_connection_runtime(
            &environment,
            Some(reopened.clone()),
            Some(&restart_reader),
            FixedClock(NOW),
            NOW,
        )
        .await
        .expect("prepare after restart")
        .expect("restarted runtime");
        assert_eq!(restarted.readiness().refreshed_bindings(), 1);
    }
    reopened.close().await;
}

#[derive(Clone, Copy)]
struct FixedClock(i64);

impl ProviderConnectionClock for FixedClock {
    fn now(&self) -> i64 {
        self.0
    }
}

struct FixedReader {
    snapshot: Option<ProviderIdentitySourceSnapshot>,
    requests: Mutex<Vec<ProviderIdentitySourceReadRequest>>,
}

impl ProviderIdentitySourceReader for FixedReader {
    async fn read(
        &self,
        request: ProviderIdentitySourceReadRequest,
        _now: i64,
    ) -> Result<ProviderIdentitySourceSnapshot, ProviderIdentitySourceReadError> {
        self.requests.lock().expect("request lock").push(request);
        self.snapshot.clone().ok_or(ProviderIdentitySourceReadError)
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

fn initial_snapshot() -> ProviderIdentitySourceSnapshot {
    snapshot(
        /*issued_at*/ 1_785_000_060,
        /*fresh_until*/ 1_785_000_120,
        /*now*/ 1_785_000_061,
    )
}

fn refreshed_snapshot() -> ProviderIdentitySourceSnapshot {
    snapshot(
        /*issued_at*/ 1_785_000_100,
        /*fresh_until*/ 1_785_000_160,
        NOW,
    )
}

fn snapshot(issued_at: i64, fresh_until: i64, now: i64) -> ProviderIdentitySourceSnapshot {
    let mut wire: Value = serde_json::from_str(CANONICAL).expect("canonical JSON");
    wire["freshness"]["issuedAt"] = issued_at.into();
    wire["freshness"]["freshUntil"] = fresh_until.into();
    ProviderIdentitySourceSnapshot::parse(&serde_json::to_vec(&wire).expect("snapshot JSON"), now)
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
    .derive(declared_client(), "provider-startup".to_string())
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

async fn initialized(home: &tempfile::TempDir) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(home.path().to_path_buf(), "provider-test".to_string())
        .await
        .expect("initialize state")
}
