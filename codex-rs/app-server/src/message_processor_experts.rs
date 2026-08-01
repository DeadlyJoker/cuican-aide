use crewon_app_server_protocol::ExpertTeamCreateParams;
use crewon_app_server_protocol::ExpertTeamCreateResponse;
use crewon_app_server_protocol::ExpertTeamListParams;
use crewon_app_server_protocol::ExpertTeamListResponse;
use crewon_app_server_protocol::ExpertTeamReadParams;
use crewon_app_server_protocol::ExpertTeamReadResponse;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::RequestIdentityTransport;
use crewon_app_server_protocol::SceneExecutionTargetSelection;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::WorkspaceBindParams;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;

use super::MessageProcessor;
use crate::error_code::invalid_request;
use crate::platform_control::RequestIdentity;
use crate::platform_control::WorkspaceRegistry;
use crate::request_processors::ExpertTeamAuthority;
use crate::request_processors::ExpertsRequestProcessor;
use crate::request_processors::read_expert_team_record;

const EXPERT_DEFINITION_SCOPE_ID: &str = "expert-team-definitions";

impl MessageProcessor {
    pub(super) async fn authorize_expert_team_thread_start(
        &self,
        identity: &RequestIdentity,
        workspace_registry: &WorkspaceRegistry,
        params: &ThreadStartParams,
    ) -> Result<(), JSONRPCErrorError> {
        let Some(SceneExecutionTargetSelection::Experts { id }) = params
            .scene
            .as_ref()
            .and_then(|scene| scene.execution_target.as_ref())
        else {
            return Ok(());
        };
        let cwd = params
            .cwd
            .as_deref()
            .ok_or_else(|| invalid_request("Expert Team thread/start requires cwd"))?;
        let canonical_cwd = tokio::fs::canonicalize(cwd)
            .await
            .map_err(|_| invalid_request("Expert Team cwd is unavailable"))?;
        let record = read_expert_team_record(&canonical_cwd, id)
            .await?
            .ok_or_else(|| invalid_request("Expert Team execution target is unavailable"))?;
        let workspace_key = params
            .execution_context
            .as_ref()
            .map_or(record.config.workspace_key.as_str(), |context| {
                context.workspace_key.as_str()
            });
        if workspace_key != record.config.workspace_key {
            return Err(invalid_request(
                "Expert Team execution context does not match its definition",
            ));
        }
        let root = workspace_registry
            .registered_root_path_with_state(
                identity,
                &self.workspace_root_catalog,
                self.state_db.as_deref(),
                workspace_key,
            )
            .await?;
        if canonical_cwd != root {
            return Err(invalid_request(
                "Expert Team cwd does not match the authorized workspace",
            ));
        }
        let (_, owner_subject, tenant_id, space_id) = expert_team_identity_scope(identity)?;
        if record.config.workspace_key != workspace_key
            || record.config.owner_subject != owner_subject
            || record.config.tenant_id != tenant_id
            || record.config.space_id != space_id
        {
            return Err(invalid_request(
                "Expert Team execution target is not authorized",
            ));
        }
        Ok(())
    }

    pub(super) async fn expert_team_list(
        &self,
        identity: &RequestIdentity,
        workspace_registry: &WorkspaceRegistry,
        params: ExpertTeamListParams,
    ) -> Result<ExpertTeamListResponse, JSONRPCErrorError> {
        let (root, authority, workspace) = self
            .prepare_expert_team_scope(identity, workspace_registry, &params.workspace_key)
            .await?;
        ExpertsRequestProcessor::new()
            .list(&root, &authority, &workspace, params)
            .await
    }

    pub(super) async fn expert_team_create(
        &self,
        identity: &RequestIdentity,
        workspace_registry: &WorkspaceRegistry,
        params: ExpertTeamCreateParams,
    ) -> Result<ExpertTeamCreateResponse, JSONRPCErrorError> {
        let (root, authority, workspace) = self
            .prepare_expert_team_scope(identity, workspace_registry, &params.workspace_key)
            .await?;
        ExpertsRequestProcessor::new()
            .create(&root, &authority, &workspace, params)
            .await
    }

    pub(super) async fn expert_team_read(
        &self,
        identity: &RequestIdentity,
        workspace_registry: &WorkspaceRegistry,
        params: ExpertTeamReadParams,
    ) -> Result<ExpertTeamReadResponse, JSONRPCErrorError> {
        let (root, authority, workspace) = self
            .prepare_expert_team_scope(identity, workspace_registry, &params.workspace_key)
            .await?;
        ExpertsRequestProcessor::new()
            .read(&root, &authority, &workspace, params)
            .await
    }

    async fn prepare_expert_team_scope(
        &self,
        identity: &RequestIdentity,
        workspace_registry: &WorkspaceRegistry,
        workspace_key: &str,
    ) -> Result<(std::path::PathBuf, ExpertTeamAuthority, WorkspaceRef), JSONRPCErrorError> {
        let (authority, _, _, _) = expert_team_identity_scope(identity)?;
        let root = workspace_registry
            .registered_root_path_with_state(
                identity,
                &self.workspace_root_catalog,
                self.state_db.as_deref(),
                workspace_key,
            )
            .await?;
        let workspace = workspace_registry
            .bind_with_state(
                identity,
                &self.workspace_root_catalog,
                self.state_db.as_deref(),
                WorkspaceBindParams {
                    workspace_key: workspace_key.to_string(),
                    scope: WorkspaceScope::Conversation,
                    scope_id: EXPERT_DEFINITION_SCOPE_ID.to_string(),
                },
            )
            .await?
            .workspace;
        Ok((root, authority, workspace))
    }
}

fn expert_team_identity_scope(
    identity: &RequestIdentity,
) -> Result<(ExpertTeamAuthority, String, Option<String>, Option<String>), JSONRPCErrorError> {
    let (owner_subject, tenant_id, space_id) =
        if let Some(principal) = identity.authenticated_principal() {
            (
                principal.stable_actor_id().to_string(),
                Some(principal.tenant_id().to_string()),
                Some(principal.space_id().to_string()),
            )
        } else {
            match identity.transport() {
                RequestIdentityTransport::Stdio | RequestIdentityTransport::InProcess => {
                    ("local-user".to_string(), None, None)
                }
                RequestIdentityTransport::WebSocket | RequestIdentityTransport::RemoteControl => {
                    return Err(invalid_request(
                        "Expert Team requests require an authenticated principal",
                    ));
                }
            }
        };
    let authority =
        ExpertTeamAuthority::new(owner_subject.clone(), tenant_id.clone(), space_id.clone())?;
    Ok((authority, owner_subject, tenant_id, space_id))
}
