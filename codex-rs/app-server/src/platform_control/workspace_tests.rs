use super::*;
use crate::platform_control::ConnectionRequestIdentity;
use crate::transport::ConnectionOrigin;
use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

fn identity(origin: ConnectionOrigin) -> RequestIdentity {
    ConnectionRequestIdentity::new(origin).derive(
        RequestIdentityClientRef {
            name: "workspace-test".to_string(),
            version: "1.0.0".to_string(),
            capabilities: RequestIdentityClientCapabilitiesRef {
                experimental_api: true,
                request_attestation: false,
            },
        },
        "00000000000000000000000000000011".to_string(),
    )
}

fn registry(identity: &RequestIdentity) -> WorkspaceRegistry {
    WorkspaceRegistry::new(identity.reference().session_id.clone())
}

fn catalog(root: &Path) -> WorkspaceRootCatalog {
    WorkspaceRootCatalog::new(
        "node-1".to_string(),
        root.to_path_buf(),
        vec![root.to_path_buf()],
    )
}

async fn listed_workspace(
    registry: &WorkspaceRegistry,
    identity: &RequestIdentity,
    catalog: &WorkspaceRootCatalog,
) -> WorkspaceSummary {
    registry
        .list(
            identity,
            catalog,
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
        .expect("registered workspace")
}

#[tokio::test]
async fn registry_canonicalizes_roots_resolves_children_and_separates_bindings() {
    let root = TempDir::new().expect("workspace tempdir");
    let child = root.path().join("child");
    std::fs::create_dir(&child).expect("create child");
    let identity = identity(ConnectionOrigin::Stdio);
    let registry = registry(&identity);
    let catalog = catalog(root.path());
    let workspace = listed_workspace(&registry, &identity, &catalog).await;
    let single = registry
        .bind(
            &identity,
            WorkspaceBindParams {
                workspace_key: workspace.workspace_key.clone(),
                scope: WorkspaceScope::Conversation,
                scope_id: "single-thread".to_string(),
            },
        )
        .await
        .expect("single binding");
    let repeated = registry
        .bind(
            &identity,
            WorkspaceBindParams {
                workspace_key: workspace.workspace_key.clone(),
                scope: WorkspaceScope::Conversation,
                scope_id: "single-thread".to_string(),
            },
        )
        .await
        .expect("repeated single binding");
    let office = registry
        .bind(
            &identity,
            WorkspaceBindParams {
                workspace_key: workspace.workspace_key.clone(),
                scope: WorkspaceScope::Office,
                scope_id: "office-record".to_string(),
            },
        )
        .await
        .expect("office binding");

    assert_eq!(repeated, single);
    assert_eq!(
        single.workspace.workspace_key,
        office.workspace.workspace_key
    );
    assert_ne!(single.workspace.binding_id, office.workspace.binding_id);
    assert_eq!(single.workspace.scope, WorkspaceScope::Conversation);
    assert_eq!(office.workspace.scope, WorkspaceScope::Office);
    assert_eq!(workspace.availability, WorkspaceAvailability::Available);
    assert_eq!(
        registry
            .resolve_workspace_path(&workspace.workspace_key, Path::new("child"))
            .await
            .expect("resolve child"),
        std::fs::canonicalize(&child).expect("canonical child"),
    );
    for rejected in [Path::new("../escape"), root.path()] {
        assert_eq!(
            registry
                .resolve_workspace_path(&workspace.workspace_key, rejected)
                .await
                .expect_err("reject path")
                .message,
            "relative path must stay within workspace",
        );
    }
}

#[tokio::test]
async fn concurrent_connection_lists_keep_one_session_workspace_key() {
    let root = TempDir::new().expect("workspace tempdir");
    let identity = identity(ConnectionOrigin::Stdio);
    let registry = registry(&identity);
    let catalog = catalog(root.path());
    let params = WorkspaceListParams {
        cursor: None,
        limit: None,
    };

    let (first, second) = tokio::join!(
        registry.list(&identity, &catalog, params.clone()),
        registry.list(&identity, &catalog, params),
    );
    assert_eq!(
        first.expect("first list").data,
        second.expect("second list").data
    );
}

#[tokio::test]
async fn registry_rejects_cross_session_keys_and_missing_roots() {
    let root = TempDir::new().expect("workspace tempdir");
    let first_identity = identity(ConnectionOrigin::Stdio);
    let first_registry = registry(&first_identity);
    let catalog = catalog(root.path());
    let workspace = listed_workspace(&first_registry, &first_identity, &catalog).await;

    let second_identity = identity(ConnectionOrigin::WebSocket);
    let second_registry = registry(&second_identity);
    assert_eq!(
        first_registry
            .bind(
                &second_identity,
                WorkspaceBindParams {
                    workspace_key: workspace.workspace_key.clone(),
                    scope: WorkspaceScope::Conversation,
                    scope_id: "single-thread".to_string(),
                },
            )
            .await
            .expect_err("identity cannot use another session registry")
            .message,
        "workspace registry does not belong to this session",
    );
    let second_list = second_registry
        .list(
            &second_identity,
            &catalog,
            WorkspaceListParams {
                cursor: None,
                limit: None,
            },
        )
        .await
        .expect("remote workspace list");
    assert_eq!(
        second_list.access_mode,
        WorkspaceAccessMode::RemoteServerRoots
    );
    assert_eq!(
        second_registry
            .bind(
                &second_identity,
                WorkspaceBindParams {
                    workspace_key: workspace.workspace_key.clone(),
                    scope: WorkspaceScope::Conversation,
                    scope_id: "single-thread".to_string(),
                },
            )
            .await
            .expect_err("cross-session key must fail")
            .message,
        "workspaceKey is not registered for this session",
    );

    std::fs::remove_dir_all(root.path()).expect("delete workspace root");
    assert_eq!(
        first_registry
            .bind(
                &first_identity,
                WorkspaceBindParams {
                    workspace_key: workspace.workspace_key,
                    scope: WorkspaceScope::Conversation,
                    scope_id: "single-thread".to_string(),
                },
            )
            .await
            .expect_err("missing root must fail")
            .message,
        "workspace is missing",
    );
}

#[tokio::test]
async fn workspace_binding_ref_is_session_owned_path_free_and_refresh_bounded() {
    let root = TempDir::new().expect("workspace tempdir");
    let request_identity = identity(ConnectionOrigin::Stdio);
    let registry = registry(&request_identity);
    let catalog = catalog(root.path());
    let workspace = listed_workspace(&registry, &request_identity, &catalog).await;
    let bound = registry
        .bind(
            &request_identity,
            WorkspaceBindParams {
                workspace_key: workspace.workspace_key,
                scope: WorkspaceScope::Office,
                scope_id: "office-record".to_string(),
            },
        )
        .await
        .expect("workspace binding");

    let resolved = registry
        .resolve_binding_ref_with_state(
            &request_identity,
            &catalog,
            /*state*/ None,
            &bound.workspace.binding_id,
        )
        .await
        .expect("resolve workspace binding");
    assert_eq!(resolved, bound.workspace);
    let serialized = serde_json::to_string(&resolved).expect("serialize workspace binding");
    assert!(!serialized.contains(root.path().to_string_lossy().as_ref()));

    let other_identity = identity(ConnectionOrigin::WebSocket);
    assert_eq!(
        registry
            .resolve_binding_ref_with_state(
                &other_identity,
                &catalog,
                /*state*/ None,
                &resolved.binding_id,
            )
            .await
            .expect_err("cross-session binding rejected")
            .message,
        "workspace registry does not belong to this session",
    );
    assert_eq!(
        registry
            .resolve_binding_ref_with_state(
                &request_identity,
                &catalog,
                /*state*/ None,
                "binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c499",
            )
            .await
            .expect_err("unknown binding rejected")
            .message,
        "workspace binding is not registered for this session",
    );

    std::fs::remove_dir_all(root.path()).expect("remove workspace root");
    assert_eq!(
        registry
            .resolve_binding_ref_with_state(
                &request_identity,
                &catalog,
                /*state*/ None,
                &resolved.binding_id,
            )
            .await
            .expect_err("stale binding rejected after refresh")
            .message,
        "workspace binding is not registered for this session",
    );
}

#[cfg(unix)]
#[tokio::test]
async fn registry_rejects_symlink_escape() {
    let root = TempDir::new().expect("workspace tempdir");
    let outside = TempDir::new().expect("outside tempdir");
    let link = root.path().join("outside-link");
    std::os::unix::fs::symlink(outside.path(), &link).expect("create symlink");
    let identity = identity(ConnectionOrigin::Stdio);
    let registry = registry(&identity);
    let catalog = catalog(root.path());
    let workspace = listed_workspace(&registry, &identity, &catalog).await;

    assert_eq!(
        registry
            .resolve_workspace_path(&workspace.workspace_key, Path::new("outside-link"))
            .await
            .expect_err("symlink escape must fail")
            .message,
        "path resolves outside workspace",
    );
}
