use std::cell::Cell;
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
    reads: Cell<usize>,
}

impl PrivateCredentialSecretStore for MemorySecretStore {
    fn get(&self, key: &str) -> Result<Zeroizing<String>, PrivateCredentialError> {
        self.reads.set(self.reads.get() + 1);
        self.values
            .get(key)
            .cloned()
            .map(Zeroizing::new)
            .ok_or(PrivateCredentialError::CredentialMissing)
    }
}

#[test]
fn resolves_selected_manifest_with_explicit_nulls_and_os_secret_binding() {
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
        reads: Cell::new(0),
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
    assert_eq!(secrets.reads.get(), 1);
}

#[test]
fn fails_closed_before_injection_on_route_drift_or_missing_secret() {
    let fixture = Fixture::new();
    let empty = MemorySecretStore {
        values: BTreeMap::new(),
        reads: Cell::new(0),
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

#[test]
fn rejects_worker_invalid_provider_endpoint_and_tools_before_secret_store_reads() {
    for invalid in [
        json!({"provider": {"kind": "directResponses"}}),
        json!({"endpoint": "http://mcp.example.test:8443/mcp"}),
        json!({"tools": []}),
        json!({"toolExtra": "secret-shaped-metadata"}),
        json!({"missingCredentialBindingId": true}),
        json!({"missingResourceBindingId": true}),
        json!({"missingApiKeyEnvironment": true}),
        json!({"missingRemoteMcpConfigPath": true}),
    ] {
        let fixture = Fixture::new();
        let invalid_label = invalid.to_string();
        fixture.write_invalid(invalid);
        let secrets = MemorySecretStore {
            values: BTreeMap::new(),
            reads: Cell::new(0),
        };
        assert_eq!(
            load_private_credential_bindings_from(
                &fixture.manifest_path,
                &fixture.route,
                fixture.route.agent_version_id(),
                &secrets,
            )
            .expect_err("invalid projection"),
            PrivateCredentialError::BindingInvalid,
            "{invalid_label}"
        );
        assert_eq!(secrets.reads.get(), 0);
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    manifest_path: std::path::PathBuf,
    remote_path: std::path::PathBuf,
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
                        "endpoint": "https://mcp.example.test:443/mcp",
                        "credentialBindingId": "credential-1",
                        "tools": [valid_tool("server-1", "credential-1")],
                    },
                    {
                        "serverId": "loopback-server",
                        "serverBindingId": "server-2",
                        "mode": "standaloneLoopback",
                        "endpoint": "http://127.0.0.1:4318/mcp",
                        "credentialBindingId": "loopback-credential",
                        "tools": [valid_tool("server-2", "loopback-credential")],
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
                    "provider": valid_provider(),
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
            remote_path,
            route,
        }
    }

    fn write_invalid(&self, invalid: serde_json::Value) {
        if let Some(provider) = invalid.get("provider") {
            let mut manifest: serde_json::Value =
                serde_json::from_slice(&fs::read(&self.manifest_path).unwrap()).unwrap();
            manifest["bindings"][0]["provider"] = provider.clone();
            fs::write(&self.manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            return;
        }
        if invalid.get("missingApiKeyEnvironment").is_some()
            || invalid.get("missingRemoteMcpConfigPath").is_some()
        {
            let mut manifest: serde_json::Value =
                serde_json::from_slice(&fs::read(&self.manifest_path).unwrap()).unwrap();
            if invalid.get("missingApiKeyEnvironment").is_some() {
                manifest["bindings"][0]["provider"]
                    .as_object_mut()
                    .unwrap()
                    .remove("apiKeyEnvironment");
            } else {
                manifest["bindings"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("remoteMcpConfigPath");
            }
            fs::write(&self.manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            return;
        }
        let mut remote: serde_json::Value =
            serde_json::from_slice(&fs::read(&self.remote_path).unwrap()).unwrap();
        if let Some(endpoint) = invalid.get("endpoint") {
            remote["servers"][0]["endpoint"] = endpoint.clone();
        } else if let Some(tools) = invalid.get("tools") {
            remote["servers"][0]["tools"] = tools.clone();
        } else if let Some(extra) = invalid.get("toolExtra") {
            remote["servers"][0]["tools"][0]["unexpectedMetadata"] = extra.clone();
        } else if invalid.get("missingCredentialBindingId").is_some() {
            remote["servers"][0]["tools"][0]["policy"]
                .as_object_mut()
                .unwrap()
                .remove("credentialBindingId");
        } else if invalid.get("missingResourceBindingId").is_some() {
            remote["servers"][0]["tools"][0]["policy"]
                .as_object_mut()
                .unwrap()
                .remove("resourceBindingId");
        }
        fs::write(&self.remote_path, serde_json::to_vec(&remote).unwrap()).unwrap();
    }
}

fn valid_provider() -> serde_json::Value {
    json!({
        "kind": "directResponses",
        "endpoint": "https://api.openai.com/v1/responses",
        "apiKeyEnvironment": null,
        "storeResponses": false,
        "requestProfile": "standard",
        "idleTimeoutMs": 30_000,
        "sequencePolicy": "required",
    })
}

fn valid_tool(server_binding_id: &str, credential_binding_id: &str) -> serde_json::Value {
    json!({
        "descriptor": {
            "name": "create_record",
            "description": "Creates a reviewed record.",
            "inputSchema": {"type": "object", "additionalProperties": false},
        },
        "policy": {
            "effect": "mutation",
            "recovery": "reconcilable",
            "resourceBindingId": null,
            "credentialBindingId": credential_binding_id,
            "executionTarget": {"kind": "remote", "bindingId": server_binding_id},
            "capability": "records.create",
            "approvalRequirement": "perAction",
            "limits": {"timeoutMs": 30_000, "maxOutputBytes": 64_000, "maxArtifactBytes": 1_000_000},
        },
    })
}
