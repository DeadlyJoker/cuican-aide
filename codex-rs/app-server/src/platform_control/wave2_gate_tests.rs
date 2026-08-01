use std::collections::HashMap;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crewon_app_server_protocol::DynamicToolCallOutputContentItem;
use crewon_app_server_protocol::DynamicToolCallResponse;
use crewon_app_server_protocol::ProviderConnectParams;
use crewon_app_server_protocol::ProviderReadParams;
use crewon_app_server_protocol::ResourceBindParams;
use crewon_app_server_protocol::ResourceBindingMode;
use crewon_app_server_protocol::ResourceListParams;
use crewon_app_server_protocol::ResourceReadParams;
use crewon_app_server_protocol::ResourceType;
use crewon_app_server_protocol::ThreadExecutionContextBindingRef;
use crewon_app_server_protocol::ThreadExecutionContextCreateParams;
use crewon_app_server_protocol::ThreadExecutionContextUpdateParams;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_provider_agent_platform::ProviderIdentitySourceOwner;
use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_state::ProviderIdentityBindingLookup;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tempfile::NamedTempFile;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::Request;
use wiremock::Respond;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_partial_json;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::ConnectionRequestIdentity;
use super::WorkspaceRegistry;
use super::WorkspaceRootCatalog;
use super::authenticated_principal::AuthenticatedPrincipal;
use super::authenticated_principal::AuthenticatedPrincipalBinding;
use super::authenticated_principal::AuthenticatedPrincipalSource;
use super::authenticated_principal::AuthenticatedPrincipalSpec;
use super::provider_access_grant_provisioner::provision_agent_platform_access_grant;
use super::provider_connection_production::SystemProviderConnectionClock;
use super::provider_connection_startup::prepare_provider_connection_runtime;
use super::provider_identity_refresh::apply_provider_identity_source_snapshot;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadError;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadRequest;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReader;
use super::thread_dynamic_tool_projection::project_provider_dynamic_tools;
use super::thread_dynamic_tool_server::ThreadDynamicToolServer;
use super::thread_execution_context_runtime::ThreadExecutionContextRequestRuntime;
use super::thread_execution_context_runtime::ThreadExecutionContextWorkspaceScope;
use crate::request_processors::ProviderConnectionRequestProcessor;
use crate::request_processors::ProviderResourceRequestProcessor;
use crate::transport::ConnectionOrigin;

const PROVIDER_ID: &str = "agent-platform";
const SOURCE_BINDING_ID: &str = "019f6f00-0000-7000-8000-000000000001";
const THREAD_ID: &str = "019f550e-ba52-7490-a248-b0d3a84103c1";
const KNOWLEDGE_ID: &str = "knowledge-demo";
const KNOWLEDGE_REVISION: &str = "knowledge-version:5";
const KNOWLEDGE_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DYNAMIC_RESULT_TEXT: &str = "Vertical Provider result.";

#[tokio::test]
async fn wave2_vertical_connects_binds_thread_authority_and_executes_provider_knowledge() {
    let now = unix_now();
    let provider = MockServer::start().await;
    mount_provider_contract(&provider).await;
    let key_file = private_signing_key_file();
    let state_home = tempfile::TempDir::new().expect("state home");
    let workspace_root = tempfile::TempDir::new().expect("workspace root");
    let state = StateRuntime::init(
        state_home.path().to_path_buf(),
        "wave2-vertical-gate".to_string(),
    )
    .await
    .expect("initialize State");
    let identity = authenticated_identity(now);
    let snapshot = identity_snapshot(&identity, now);
    let owner = provider_owner(&identity);
    apply_provider_identity_source_snapshot(&state, &identity_lookup(&identity), &snapshot)
        .await
        .expect("persist Provider identity authority");
    provision_agent_platform_access_grant(&state, &owner, &snapshot, now + 3_500, now)
        .await
        .expect("provision Provider access grant");
    let reader = FixedIdentityReader { snapshot };
    let environment = provider_environment(&format!("{}/provider/v3/", provider.uri()), &key_file);
    let runtime = Arc::new(
        prepare_provider_connection_runtime(
            &environment,
            Some(Arc::clone(&state)),
            Some(&reader),
            SystemProviderConnectionClock,
            now,
        )
        .await
        .expect("prepare Provider runtime")
        .expect("enabled Provider runtime"),
    );
    let registry = Arc::new(WorkspaceRegistry::new(
        identity.reference().session_id.clone(),
    ));
    let catalog = WorkspaceRootCatalog::new(
        "wave2-node".to_string(),
        workspace_root.path().to_path_buf(),
        vec![workspace_root.path().to_path_buf()],
    );
    let workspace_key = registry
        .list_with_state(
            &identity,
            &catalog,
            Some(state.as_ref()),
            WorkspaceListParams {
                cursor: None,
                limit: Some(20),
            },
        )
        .await
        .expect("list Workspace")
        .data
        .into_iter()
        .next()
        .expect("Workspace")
        .workspace_key;
    let thread_runtime = ThreadExecutionContextRequestRuntime::new(
        identity.clone(),
        Arc::clone(&registry),
        catalog,
        Arc::clone(&state),
    );
    let prepared = thread_runtime
        .prepare_create(ThreadExecutionContextCreateParams { workspace_key })
        .await
        .expect("prepare Thread authority");
    let created_context = thread_runtime
        .create(
            prepared,
            THREAD_ID,
            ThreadExecutionContextWorkspaceScope::Conversation,
            now,
        )
        .await
        .expect("create Thread authority");

    let connections = ProviderConnectionRequestProcessor::new(Some(Arc::clone(&runtime)));
    let resources =
        ProviderResourceRequestProcessor::new(Some(Arc::clone(&runtime)), Some(Arc::clone(&state)));
    let connected = connections
        .connect(
            &identity,
            ProviderConnectParams {
                provider_id: PROVIDER_ID.to_string(),
            },
        )
        .await
        .expect("connect Provider");
    let reread = connections
        .read(
            &identity,
            ProviderReadParams {
                connection_id: connected.provider.connection_id.clone(),
            },
        )
        .await
        .expect("read Provider");
    assert_eq!(reread.provider, connected.provider);

    let listed = resources
        .list(
            &identity,
            ResourceListParams {
                connection_id: connected.provider.connection_id.clone(),
                cursor: None,
                limit: Some(20),
                resource_type: Some(ResourceType::KnowledgeBase),
            },
        )
        .await
        .expect("list Provider resources");
    let resource = listed.data.first().expect("knowledge resource").clone();
    let read = resources
        .read(
            &identity,
            ResourceReadParams {
                connection_id: connected.provider.connection_id.clone(),
                resource: resource.clone(),
            },
        )
        .await
        .expect("read Provider resource");
    assert_eq!(read.manifest.resource, resource);
    let bound = resources
        .bind(
            &identity,
            &created_context.workspace,
            ResourceBindParams {
                connection_id: connected.provider.connection_id.clone(),
                workspace_binding_id: created_context.workspace.binding_id.clone(),
                resource,
                mode: ResourceBindingMode::RemoteReference,
            },
        )
        .await
        .expect("bind Provider resource");
    let updated_context = thread_runtime
        .update(
            ThreadExecutionContextUpdateParams {
                thread_id: THREAD_ID.to_string(),
                workspace_binding_id: created_context.workspace.binding_id.clone(),
                resource_binding_ids: vec![bound.binding.binding_id.clone()],
                execution_binding_id: None,
                expected_revision: created_context.revision,
            },
            now,
        )
        .await
        .expect("attach resource to Thread authority");
    assert_eq!(
        updated_context.resource_bindings,
        vec![ThreadExecutionContextBindingRef {
            binding_id: bound.binding.binding_id.clone(),
            revision: bound.revision,
        }]
    );

    let binding_records = thread_runtime
        .owned_binding_records(THREAD_ID)
        .await
        .expect("read exact Thread bindings");
    let tools = project_provider_dynamic_tools(&runtime, &identity, &binding_records)
        .await
        .expect("project Provider dynamic tool");
    assert_eq!(tools.len(), 1);
    let namespace = tools[0].namespace.clone().expect("Provider namespace");
    assert_eq!(tools[0].name, "search");

    let dynamic_server = ThreadDynamicToolServer::new(Some(Arc::clone(&runtime)));
    dynamic_server
        .bind_turn(THREAD_ID, identity, updated_context.workspace.clone())
        .await
        .expect("bind turn authority");
    let response = dynamic_server
        .dispatch(
            THREAD_ID,
            "turn-wave2-vertical",
            "knowledge-call-wave2-vertical".to_string(),
            Some(namespace),
            "search".to_string(),
            json!({"query": "exact revision behavior", "limit": 5}),
        )
        .await
        .expect("Provider namespace is server-owned");
    assert_eq!(
        response,
        DynamicToolCallResponse {
            content_items: vec![DynamicToolCallOutputContentItem::InputText {
                text: DYNAMIC_RESULT_TEXT.to_string(),
            }],
            success: true,
        }
    );

    let requests = provider
        .received_requests()
        .await
        .expect("Provider requests");
    let execute = requests
        .iter()
        .find(|request| request.url.path() == "/provider/v3/dynamicActions:execute")
        .expect("dynamic execution request");
    let execute_body: Value =
        serde_json::from_slice(&execute.body).expect("dynamic execution JSON");
    assert_eq!(execute_body["resource"], knowledge_resource_wire());
    assert_eq!(execute_body["operation"], "search");
    assert_eq!(
        execute_body["arguments"],
        json!({"query": "exact revision behavior", "limit": 5})
    );
    let serialized_requests = requests
        .iter()
        .map(|request| String::from_utf8_lossy(&request.body))
        .collect::<String>();
    assert!(!serialized_requests.contains(workspace_root.path().to_string_lossy().as_ref()));
    assert!(!serialized_requests.contains("PRIVATE KEY"));

    state.close().await;
}

async fn mount_provider_contract(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(provider_descriptor()))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/resources:list"))
        .and(body_partial_json(json!({
            "type": "listResources",
            "resourceType": "knowledgeBase",
            "afterCursor": null,
            "limit": 20
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [{
                "resource": knowledge_resource_wire(),
                "manifestSchemaVersion": "1.0.0",
                "contentDigest": KNOWLEDGE_DIGEST
            }],
            "nextCursor": null
        })))
        .expect(1)
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/resources:read"))
        .and(body_partial_json(json!({
            "type": "readResource",
            "resource": knowledge_resource_wire()
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "resource": knowledge_resource_wire(),
            "manifestSchemaVersion": "1.0.0",
            "contentDigest": KNOWLEDGE_DIGEST
        })))
        .expect(2)
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/dynamicResources:read"))
        .and(body_partial_json(json!({
            "type": "readDynamicResource",
            "resource": knowledge_resource_wire()
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(dynamic_manifest()))
        .expect(2)
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/dynamicActions:execute"))
        .and(body_partial_json(json!({
            "type": "executeDynamicResource",
            "resource": knowledge_resource_wire(),
            "operation": "search",
            "arguments": {"query": "exact revision behavior", "limit": 5}
        })))
        .respond_with(DynamicSuccessResponder)
        .expect(1)
        .mount(server)
        .await;
}

fn provider_descriptor() -> Value {
    json!({
        "providerId": PROVIDER_ID,
        "protocolVersion": "3.0.0",
        "capabilities": [
            "durableRun",
            "remoteAgent",
            "resumableEvents",
            "remoteTool",
            "remoteKnowledge"
        ],
        "resourceCapabilities": [
            {
                "resourceType": "agent",
                "bindingMode": "providerManaged",
                "executionLocation": "provider"
            },
            {
                "resourceType": "mcpTool",
                "bindingMode": "remoteReference",
                "executionLocation": "provider"
            },
            {
                "resourceType": "mcpTool",
                "bindingMode": "providerManaged",
                "executionLocation": "provider"
            },
            {
                "resourceType": "knowledgeBase",
                "bindingMode": "remoteReference",
                "executionLocation": "provider"
            },
            {
                "resourceType": "knowledgeBase",
                "bindingMode": "providerManaged",
                "executionLocation": "provider"
            }
        ]
    })
}

fn knowledge_resource_wire() -> Value {
    json!({
        "providerId": PROVIDER_ID,
        "resourceType": "knowledgeBase",
        "resourceId": KNOWLEDGE_ID,
        "revision": KNOWLEDGE_REVISION
    })
}

fn dynamic_manifest() -> Value {
    json!({
        "resource": knowledge_resource_wire(),
        "manifestSchemaVersion": "1.0.0",
        "contentDigest": KNOWLEDGE_DIGEST,
        "operation": "search",
        "sideEffect": "readOnly",
        "schemaDigest": "sha256:67d625e7a3d4c91f6604c399a977ea061d226365f3d0e9d92be6c24f10a285c9",
        "description": "Search one exact knowledge revision.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "query": {"type": "string", "maxLength": 4000},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20}
            },
            "required": ["query"]
        }
    })
}

struct DynamicSuccessResponder;

impl Respond for DynamicSuccessResponder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let command: Value = serde_json::from_slice(&request.body).expect("dynamic command JSON");
        let result = format!(
            r#"{{"type":"inlineText","items":[{}]}}"#,
            serde_json::to_string(DYNAMIC_RESULT_TEXT).expect("result text JSON")
        );
        let result_digest = format!("sha256:{:x}", Sha256::digest(result.as_bytes()));
        ResponseTemplate::new(200).set_body_json(json!({
            "status": "succeeded",
            "callId": command["callId"],
            "actionDigest": command["actionDigest"],
            "resultDigest": result_digest,
            "result": serde_json::from_str::<Value>(&result).expect("result JSON")
        }))
    }
}

struct FixedIdentityReader {
    snapshot: ProviderIdentitySourceSnapshot,
}

impl ProviderIdentitySourceReader for FixedIdentityReader {
    async fn read(
        &self,
        _request: ProviderIdentitySourceReadRequest,
        _now: i64,
    ) -> Result<ProviderIdentitySourceSnapshot, ProviderIdentitySourceReadError> {
        Ok(self.snapshot.clone())
    }
}

fn authenticated_identity(now: i64) -> super::RequestIdentity {
    ConnectionRequestIdentity::new_authenticated(
        ConnectionOrigin::WebSocket,
        AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
            source: AuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
            issuer: PROVIDER_ID.to_string(),
            audience: "crewon-app-server".to_string(),
            subject: "user:42".to_string(),
            tenant_id: "7".to_string(),
            space_id: "11".to_string(),
            token_id: "019f6f00-0000-7000-8000-000000000002".to_string(),
            issued_at: now - 60,
            expires_at: now + 3_500,
            binding: AuthenticatedPrincipalBinding::AgentPlatform {
                source_binding_id: SOURCE_BINDING_ID.to_string(),
                source_revision: 1,
            },
        })
        .expect("authenticated principal"),
    )
    .derive(
        crewon_app_server_protocol::RequestIdentityClientRef {
            name: "wave2-vertical-gate".to_string(),
            version: "1.0.0".to_string(),
            capabilities: crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef {
                experimental_api: true,
                request_attestation: false,
            },
        },
        "wave2-vertical-trace".to_string(),
    )
}

fn identity_snapshot(
    identity: &super::RequestIdentity,
    now: i64,
) -> ProviderIdentitySourceSnapshot {
    let actor_id = identity.reference().actor_id.clone();
    let binding_digest = identity_binding_digest(&actor_id, now - 10);
    let wire = json!({
        "schemaVersion": "1.0.0",
        "authorityId": "agent-platform-identity",
        "binding": {
            "sourceBindingId": SOURCE_BINDING_ID,
            "sourceRevision": 1,
            "status": "active",
            "localOwner": {
                "actorId": actor_id,
                "tenantId": "7",
                "spaceId": "11"
            },
            "providerIdentity": {
                "providerId": PROVIDER_ID,
                "subject": "user:42",
                "tenantId": "7",
                "spaceId": "11"
            },
            "createdAt": now - 10,
            "updatedAt": now - 10,
            "bindingDigest": binding_digest
        },
        "freshness": {
            "issuedAt": now - 1,
            "freshUntil": now + 59
        }
    });
    ProviderIdentitySourceSnapshot::parse(
        &serde_json::to_vec(&wire).expect("identity source JSON"),
        now,
    )
    .expect("identity source snapshot")
}

fn identity_binding_digest(actor_id: &str, created_at: i64) -> String {
    let source_revision = "1";
    let created_at = created_at.to_string();
    let parts = [
        "agent-platform-identity",
        SOURCE_BINDING_ID,
        source_revision,
        "active",
        actor_id,
        "7",
        "11",
        PROVIDER_ID,
        "user:42",
        "7",
        "11",
        &created_at,
        &created_at,
    ];
    let mut digest = Sha256::new();
    digest.update(b"crewon.provider-identity-source-binding.v1\0");
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("sha256:{:x}", digest.finalize())
}

fn provider_owner(identity: &super::RequestIdentity) -> ProviderIdentitySourceOwner {
    let reference = identity.reference();
    ProviderIdentitySourceOwner::new(
        reference.actor_id.clone(),
        reference.tenant_id.clone().expect("tenant"),
        reference.space_id.clone().expect("space"),
    )
    .expect("Provider owner")
}

fn identity_lookup(identity: &super::RequestIdentity) -> ProviderIdentityBindingLookup {
    let reference = identity.reference();
    ProviderIdentityBindingLookup {
        local_actor_id: reference.actor_id.clone(),
        local_tenant_id: reference.tenant_id.clone().expect("tenant"),
        local_space_id: reference.space_id.clone().expect("space"),
        provider_id: PROVIDER_ID.to_string(),
    }
}

fn provider_environment(endpoint: &str, key_file: &NamedTempFile) -> HashMap<String, String> {
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
            "wave2-provider-signing".to_string(),
        ),
        (
            "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_PRIVATE_KEY_FILE".to_string(),
            key_file.path().display().to_string(),
        ),
    ])
}

fn private_signing_key_file() -> NamedTempFile {
    let source = crewon_utils_cargo_bin::find_resource!(
        "../provider-agent-platform/tests/fixtures/provider_rs256_test_private.pem"
    )
    .expect("RSA fixture");
    let key = std::fs::read(source).expect("read RSA fixture");
    let file = NamedTempFile::new().expect("private key file");
    std::fs::write(file.path(), key).expect("write private key");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600))
            .expect("private key permissions");
    }
    file
}

fn unix_now() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_secs(),
    )
    .expect("Unix time")
}
