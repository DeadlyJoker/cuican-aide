use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_app_server_protocol::WorkspaceBindParams;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::ConnectionRequestIdentity;
use super::WorkspaceRegistry;
use super::WorkspaceRootCatalog;
use super::authenticated_principal::AuthenticatedPrincipal;
use super::authenticated_principal::AuthenticatedPrincipalBinding;
use super::authenticated_principal::AuthenticatedPrincipalSource;
use super::authenticated_principal::AuthenticatedPrincipalSpec;
use crate::transport::ConnectionOrigin;

#[tokio::test]
async fn authenticated_reconnect_reuses_durable_workspace_key_and_connection_identity_does_not() {
    let state_home = TempDir::new().expect("state home");
    let root = TempDir::new().expect("workspace root");
    let state = initialized_state(&state_home).await;
    let catalog = workspace_catalog(root.path());

    let first_identity = authenticated_identity("token-1");
    let first_registry = registry(&first_identity);
    let first_key = listed_key(
        &first_registry,
        &first_identity,
        &catalog,
        Some(state.as_ref()),
    )
    .await;
    state.close().await;

    let reopened = initialized_state(&state_home).await;
    let second_identity = authenticated_identity("token-2");
    let second_registry = registry(&second_identity);
    let second_key = listed_key(
        &second_registry,
        &second_identity,
        &catalog,
        Some(reopened.as_ref()),
    )
    .await;
    assert_eq!(second_key, first_key);

    let first_connection_identity = connection_identity();
    let connection_registry = registry(&first_connection_identity);
    let connection_key = listed_key(
        &connection_registry,
        &first_connection_identity,
        &catalog,
        Some(reopened.as_ref()),
    )
    .await;
    assert_ne!(connection_key, first_key);
    let other_connection_identity = connection_identity();
    let other_connection_registry = registry(&other_connection_identity);
    let other_connection_key = listed_key(
        &other_connection_registry,
        &other_connection_identity,
        &catalog,
        Some(reopened.as_ref()),
    )
    .await;
    assert_ne!(other_connection_key, connection_key);

    let unavailable_registry = registry(&second_identity);
    assert_eq!(
        unavailable_registry
            .list_with_state(
                &second_identity,
                &catalog,
                /*state*/ None,
                WorkspaceListParams {
                    cursor: None,
                    limit: None,
                },
            )
            .await
            .expect_err("authenticated durable workspace requires state")
            .message,
        "durable workspace authority is unavailable"
    );

    reopened.close().await;
}

#[tokio::test]
async fn durable_workspace_only_exposes_current_catalog_roots_and_never_serializes_paths() {
    let state_home = TempDir::new().expect("state home");
    let first_root = TempDir::new().expect("first workspace root");
    let replacement_root = TempDir::new().expect("replacement workspace root");
    let state = initialized_state(&state_home).await;
    let identity = authenticated_identity("token-1");
    let registry = registry(&identity);
    let first_catalog = workspace_catalog(first_root.path());

    let response = registry
        .list_with_state(
            &identity,
            &first_catalog,
            Some(state.as_ref()),
            WorkspaceListParams {
                cursor: None,
                limit: None,
            },
        )
        .await
        .expect("workspace list");
    let first_key = response.data[0].workspace_key.clone();
    let serialized = serde_json::to_string(&response).expect("serialize workspace list");
    assert!(!serialized.contains(first_root.path().to_string_lossy().as_ref()));
    assert!(!serialized.contains("rootFingerprint"));
    assert!(!serialized.contains("sha256:"));

    let replacement_catalog = workspace_catalog(replacement_root.path());
    assert_eq!(
        registry
            .bind_with_state(
                &identity,
                &replacement_catalog,
                Some(state.as_ref()),
                WorkspaceBindParams {
                    workspace_key: first_key,
                    scope: WorkspaceScope::Conversation,
                    scope_id: "thread-1".to_string(),
                },
            )
            .await
            .expect_err("removed catalog root must not remain bindable")
            .message,
        "workspaceKey is not registered for this session"
    );

    state.close().await;
}

async fn listed_key(
    registry: &WorkspaceRegistry,
    identity: &super::RequestIdentity,
    catalog: &WorkspaceRootCatalog,
    state: Option<&StateRuntime>,
) -> String {
    registry
        .list_with_state(
            identity,
            catalog,
            state,
            WorkspaceListParams {
                cursor: None,
                limit: None,
            },
        )
        .await
        .expect("workspace list")
        .data
        .into_iter()
        .next()
        .expect("workspace")
        .workspace_key
}

fn authenticated_identity(token_id: &str) -> super::RequestIdentity {
    let principal = AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
        source: AuthenticatedPrincipalSource::WebSocketSignedBearer,
        issuer: "https://identity.example".to_string(),
        audience: "crewon-app-server".to_string(),
        subject: "user:42".to_string(),
        tenant_id: "tenant-7".to_string(),
        space_id: "space-9".to_string(),
        token_id: token_id.to_string(),
        issued_at: 100,
        expires_at: 200,
        binding: AuthenticatedPrincipalBinding::LegacyUnbound,
    })
    .expect("authenticated principal");
    ConnectionRequestIdentity::new_authenticated(ConnectionOrigin::WebSocket, principal)
        .derive(declared_client(), format!("trace-{token_id}"))
}

fn connection_identity() -> super::RequestIdentity {
    ConnectionRequestIdentity::new(ConnectionOrigin::Stdio)
        .derive(declared_client(), "connection-trace".to_string())
}

fn declared_client() -> RequestIdentityClientRef {
    RequestIdentityClientRef {
        name: "durable-workspace-test".to_string(),
        version: "1.0.0".to_string(),
        capabilities: RequestIdentityClientCapabilitiesRef {
            experimental_api: true,
            request_attestation: false,
        },
    }
}

fn registry(identity: &super::RequestIdentity) -> WorkspaceRegistry {
    WorkspaceRegistry::new(identity.reference().session_id.clone())
}

fn workspace_catalog(root: &std::path::Path) -> WorkspaceRootCatalog {
    WorkspaceRootCatalog::new(
        "node-1".to_string(),
        root.to_path_buf(),
        vec![root.to_path_buf()],
    )
}

async fn initialized_state(home: &TempDir) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state")
}
