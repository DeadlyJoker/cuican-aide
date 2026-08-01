use std::sync::Arc;

use crewon_state::ArtifactPayloadStatus;
use crewon_state::CloudAgentTurnRecord;
use crewon_state::StateRuntime;
use sha2::Digest;
use sha2::Sha256;

use super::CloudAgentThreadProjectionError;

const MAX_CONVERSATION_ARTIFACT_BYTES: usize = 64 * 1024;

pub(crate) struct CloudAgentThreadArtifactProjector {
    state: Arc<StateRuntime>,
}

impl CloudAgentThreadArtifactProjector {
    pub(crate) fn new(state: Arc<StateRuntime>) -> Self {
        Self { state }
    }

    pub(crate) async fn read_prompt(
        &self,
        turn: &CloudAgentTurnRecord,
    ) -> Result<String, CloudAgentThreadProjectionError> {
        self.read_text_artifact(
            &turn.prompt_artifact,
            &["text/plain"],
            ArtifactExecutionAuthority::Conversation {
                thread_id: &turn.thread_id,
                turn_id: &turn.turn_id,
            },
        )
        .await
    }

    pub(crate) async fn read_output(
        &self,
        turn: &CloudAgentTurnRecord,
    ) -> Result<String, CloudAgentThreadProjectionError> {
        let artifact = turn
            .primary_output_artifact
            .as_ref()
            .ok_or(CloudAgentThreadProjectionError::InvalidProjection)?;
        let task_id = turn
            .origin
            .task_id()
            .ok_or(CloudAgentThreadProjectionError::InvalidProjection)?;
        self.read_text_artifact(
            artifact,
            &["text/plain", "text/markdown"],
            ArtifactExecutionAuthority::Task { task_id },
        )
        .await
    }

    async fn read_text_artifact(
        &self,
        artifact: &crewon_state::CloudExecutionArtifactRefRecord,
        allowed_media_types: &[&str],
        authority: ArtifactExecutionAuthority<'_>,
    ) -> Result<String, CloudAgentThreadProjectionError> {
        let stored = self
            .state
            .get_artifact_record(&artifact.artifact_id, artifact.revision)
            .await
            .map_err(|_| CloudAgentThreadProjectionError::StateUnavailable)?
            .ok_or(CloudAgentThreadProjectionError::InvalidProjection)?;
        if stored.payload.status != ArtifactPayloadStatus::Available
            || stored.payload.byte_len > MAX_CONVERSATION_ARTIFACT_BYTES as u64
            || !allowed_media_types.contains(&stored.payload.media_type.as_str())
        {
            return Err(CloudAgentThreadProjectionError::InvalidProjection);
        }
        let body = stored
            .payload
            .content
            .ok_or(CloudAgentThreadProjectionError::InvalidProjection)?;
        let manifest: serde_json::Value = serde_json::from_str(&stored.manifest.manifest_json)
            .map_err(|_| CloudAgentThreadProjectionError::InvalidProjection)?;
        let body_digest = format!("sha256:{:x}", Sha256::digest(&body));
        if manifest
            .pointer("/verification")
            .and_then(serde_json::Value::as_str)
            != Some("verified")
            || manifest
                .pointer("/payload/digest")
                .and_then(serde_json::Value::as_str)
                != Some(stored.payload.sha256.as_str())
            || manifest
                .pointer("/payload/byteLen")
                .and_then(serde_json::Value::as_u64)
                != Some(stored.payload.byte_len)
            || manifest
                .pointer("/payload/mediaType")
                .and_then(serde_json::Value::as_str)
                != Some(stored.payload.media_type.as_str())
            || stored.payload.byte_len != body.len() as u64
            || stored.payload.sha256 != body_digest
            || !authority.matches(&manifest)
        {
            return Err(CloudAgentThreadProjectionError::InvalidProjection);
        }
        String::from_utf8(body).map_err(|_| CloudAgentThreadProjectionError::InvalidProjection)
    }
}

enum ArtifactExecutionAuthority<'a> {
    Conversation {
        thread_id: &'a str,
        turn_id: &'a str,
    },
    Task {
        task_id: &'a str,
    },
}

impl ArtifactExecutionAuthority<'_> {
    fn matches(&self, manifest: &serde_json::Value) -> bool {
        match self {
            Self::Conversation { thread_id, turn_id } => {
                manifest
                    .pointer("/execution/type")
                    .and_then(serde_json::Value::as_str)
                    == Some("conversation")
                    && manifest
                        .pointer("/execution/threadId")
                        .and_then(serde_json::Value::as_str)
                        == Some(*thread_id)
                    && manifest
                        .pointer("/execution/turnId")
                        .and_then(serde_json::Value::as_str)
                        == Some(*turn_id)
            }
            Self::Task { task_id } => {
                manifest
                    .pointer("/execution/type")
                    .and_then(serde_json::Value::as_str)
                    == Some("task")
                    && manifest
                        .pointer("/execution/taskId")
                        .and_then(serde_json::Value::as_str)
                        == Some(*task_id)
            }
        }
    }
}
