use std::collections::BTreeMap;
use std::fs;

use pretty_assertions::assert_eq;
use serde_json::json;
use zeroize::Zeroizing;

use super::load_private_credential_bindings_from;
use super::secret_key;
use super::PrivateCredentialError;
use super::PrivateCredentialSecretStore;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;
use crate::workspace_native::RuntimeRouteProjection;
use crate::workspace_native::WorkspaceAuthorityPrepareResult;

struct MemorySecretStore {
    values: BTreeMap<String, String>,
}

impl PrivateCredentialSecretStore for MemorySecretStore {
    fn get(&self, key: &str) -> Result<Zeroizing<String>, PrivateCredentialError> {
        self.values
            .get(key)
            .cloned()
            .map(Zeroizing::new)
            .ok_or(PrivateCredentialError::CredentialMissing)
    }
}

#[test]
fn resolves_only_the_selected_runtime_manifest_and_os_secret_binding() {
    let fixture = Fixture::new();
    let credential_key = secret_key(
        fixture.route.tenant_id(),
        fixture.route.workspace_binding_id().unwrap(),
        fixture.route.runtime_generation(),
        fixture.route.agent_version_id(),
        "credential-1",
    )
    .unwrap();
    let secrets = MemorySecretStore {
        values: BTreeMap::from([(credential_key, "private+/bearer==".to_string())]),
    };

    let credentials = load_private_credential_bindings_from(
        &fixture.manifest_path,
        &fixture.route,
        fixture.route.agent_version_id(),
        &secrets,
    )
    .expect("credential source")
    .expect("production credentials");

    assert_eq!(
        serde_json::to_value(credentials).expect("credential envelope"),
        json!({
            "schemaVersion": "crewon.remote-mcp-private-credentials.v1",
            "authority": {
                "tenantId": "standalone-tenant",
                "workspaceBindingId": fixture.route.workspace_binding_id().unwrap(),
                "runtimeBindingId": fixture.route.runtime_generation(),
                "agentVersionId": fixture.route.agent_version_id(),
            },
            "bindings": [{
                "credentialBindingId": "credential-1",
                "bearerToken": "private+/bearer==",
            }],
        })
    );
}

#[test]
fn fails_closed_before_injection_on_route_drift_or_missing_secret() {
    let fixture = Fixture::new();
    let empty = MemorySecretStore {
        values: BTreeMap::new(),
    };
    assert_eq!(
        load_private_credential_bindings_from(
            &fixture.manifest_path,
            &fixture.route,
            "other-agent-version",
            &empty,
        )
        .expect_err("agent version drift"),
        PrivateCredentialError::BindingInvalid
    );
    assert_eq!(
        load_private_credential_bindings_from(
            &fixture.manifest_path,
            &fixture.route,
            fixture.route.agent_version_id(),
            &empty,
        )
        .expect_err("missing OS secret"),
        PrivateCredentialError::CredentialMissing
    );
}

struct Fixture {
    _root: tempfile::TempDir,
    manifest_path: std::path::PathBuf,
    route: RuntimeRouteProjection,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let mut authority = DesktopWorkspaceAuthorityManager::open(root.path().join("authority"))
            .expect("workspace authority");
        let candidate = match authority
            .prepare("select-workspace", 0, workspace)
            .expect("prepare workspace")
        {
            WorkspaceAuthorityPrepareResult::Pending(pending) => {
                pending.candidate().unwrap().clone()
            }
            WorkspaceAuthorityPrepareResult::Committed(_)
            | WorkspaceAuthorityPrepareResult::Aborted => panic!("pending workspace expected"),
        };
        authority
            .commit("select-workspace")
            .expect("commit workspace");
        let route = RuntimeRouteProjection::from_authority(authority.authority()).unwrap();
        let remote_path = root.path().join("remote-mcp.json");
        fs::write(
            &remote_path,
            serde_json::to_vec(&json!({
                "schemaVersion": "crewon.remote-mcp-runtime.v0",
                "servers": [
                    {
                        "serverId": "production-server",
                        "serverBindingId": "server-1",
                        "mode": "production",
                        "endpoint": "https://mcp.example.test/mcp",
                        "credentialBindingId": "credential-1",
                        "tools": [],
                    },
                    {
                        "serverId": "loopback-server",
                        "serverBindingId": "server-2",
                        "mode": "standaloneLoopback",
                        "endpoint": "http://127.0.0.1:4318/mcp",
                        "credentialBindingId": "loopback-credential",
                        "tools": [],
                    },
                ],
            }))
            .unwrap(),
        )
        .unwrap();
        let manifest_path = root.path().join("runtime-bindings.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&json!({
                "schemaVersion": "crewon.agent-version-runtime-bindings.v0",
                "bindings": [{
                    "tenantId": route.tenant_id(),
                    "agentVersionId": route.agent_version_id(),
                    "contentDigest": format!("sha256:{}", "0".repeat(64)),
                    "authorityId": "authority-1",
                    "workspaceBindingId": candidate.workspace_binding_id(),
                    "provider": { "kind": "directResponses" },
                    "mcpStdioConfigPath": null,
                    "deviceToolConfigPath": null,
                    "remoteMcpConfigPath": remote_path,
                }],
            }))
            .unwrap(),
        )
        .unwrap();
        Self {
            _root: root,
            manifest_path,
            route,
        }
    }
}
