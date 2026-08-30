use crewon_artifact::ArtifactKind;
use crewon_artifact::PayloadSensitivity;
use crewon_artifact::RetentionPolicy;
use crewon_policy::PolicyActor;
use crewon_provider_agent_platform::ProviderArtifactKind;
use crewon_provider_agent_platform::ProviderArtifactMediaType;
use crewon_provider_agent_platform::ProviderArtifactRetention;
use crewon_provider_agent_platform::ProviderArtifactSensitivity;
use crewon_resource_federation::ResourceRef;
use crewon_task_runtime::UnixTimestamp;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

use super::ProviderRunOutputArtifactImportError;
use super::ProviderRunOutputArtifactImportRequest;

pub(super) fn source_digest(
    request: &ProviderRunOutputArtifactImportRequest,
) -> Result<String, ProviderRunOutputArtifactImportError> {
    canonical_digest(
        b"crewon.provider-run-output-source.v1\0",
        &SourceIdentity {
            actor: &request.actor,
            workspace: &request.workspace,
            task_id: &request.task_id,
            run_id: &request.run_id,
            attempt_id: &request.attempt_id,
            thread_id: &request.thread_id,
            turn_id: &request.turn_id,
            provider_run_id: &request.provider_run_id,
            resource: request.content.authorization().resource(),
            provider_artifact_id: request.content.artifact().artifact_id(),
        },
    )
}

pub(super) fn import_digest(
    request: &ProviderRunOutputArtifactImportRequest,
    source_digest: &str,
) -> Result<String, ProviderRunOutputArtifactImportError> {
    let artifact = request.content.artifact();
    canonical_digest(
        b"crewon.provider-run-output-import.v1\0",
        &ImportIdentity {
            source_digest,
            revision: artifact.revision(),
            kind: artifact_kind(artifact.kind()),
            retention: artifact_retention(artifact.retention()),
            created_at: artifact.created_at(),
            media_type: media_type(request.content.media_type()),
            sensitivity: sensitivity(request.content.sensitivity()),
            content_digest: request.content.content_digest(),
            trace: &request.trace,
            observed_at: request.observed_at.get(),
        },
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceIdentity<'a> {
    actor: &'a PolicyActor,
    workspace: &'a crewon_artifact::ArtifactWorkspace,
    task_id: &'a crewon_task_runtime::TaskId,
    run_id: &'a crewon_artifact::RunId,
    attempt_id: &'a crewon_task_runtime::AttemptId,
    thread_id: &'a crewon_artifact::ThreadId,
    turn_id: &'a crewon_artifact::TurnId,
    provider_run_id: &'a str,
    resource: &'a ResourceRef,
    provider_artifact_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportIdentity<'a> {
    source_digest: &'a str,
    revision: u64,
    kind: &'static str,
    retention: &'static str,
    created_at: i64,
    media_type: &'static str,
    sensitivity: &'static str,
    content_digest: &'a str,
    trace: &'a crewon_artifact::TraceContext,
    observed_at: i64,
}

fn canonical_digest(
    domain: &[u8],
    value: &impl Serialize,
) -> Result<String, ProviderRunOutputArtifactImportError> {
    let canonical = serde_json::to_vec(value)
        .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?;
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update(canonical);
    Ok(format!("{:x}", digest.finalize()))
}

pub(super) fn local_artifact_kind(
    kind: ProviderArtifactKind,
) -> Result<ArtifactKind, ProviderRunOutputArtifactImportError> {
    match kind {
        ProviderArtifactKind::File => Ok(ArtifactKind::Document),
        ProviderArtifactKind::Report => Ok(ArtifactKind::Report),
        ProviderArtifactKind::Evidence => Ok(ArtifactKind::EvidenceBundle),
        ProviderArtifactKind::ToolResult => Ok(ArtifactKind::StructuredResult),
        ProviderArtifactKind::Image => {
            Err(ProviderRunOutputArtifactImportError::UnsupportedArtifact)
        }
    }
}

pub(super) const fn local_retention(
    retention: ProviderArtifactRetention,
    expires_at: UnixTimestamp,
) -> Result<RetentionPolicy, ProviderRunOutputArtifactImportError> {
    match retention {
        ProviderArtifactRetention::Session => Ok(RetentionPolicy::Session { expires_at }),
        ProviderArtifactRetention::Task => Ok(RetentionPolicy::Task { expires_at }),
        ProviderArtifactRetention::UserManaged | ProviderArtifactRetention::Compliance => {
            Err(ProviderRunOutputArtifactImportError::UnsupportedArtifact)
        }
    }
}

pub(super) const fn payload_sensitivity(
    sensitivity: ProviderArtifactSensitivity,
) -> PayloadSensitivity {
    match sensitivity {
        ProviderArtifactSensitivity::Public => PayloadSensitivity::Public,
        ProviderArtifactSensitivity::Internal => PayloadSensitivity::Internal,
        ProviderArtifactSensitivity::WorkspaceSensitive => PayloadSensitivity::WorkspaceSensitive,
    }
}

pub(super) const fn artifact_kind(kind: ProviderArtifactKind) -> &'static str {
    match kind {
        ProviderArtifactKind::File => "file",
        ProviderArtifactKind::Image => "image",
        ProviderArtifactKind::Report => "report",
        ProviderArtifactKind::Evidence => "evidence",
        ProviderArtifactKind::ToolResult => "toolResult",
    }
}

pub(super) const fn artifact_retention(retention: ProviderArtifactRetention) -> &'static str {
    match retention {
        ProviderArtifactRetention::Session => "session",
        ProviderArtifactRetention::Task => "task",
        ProviderArtifactRetention::UserManaged => "userManaged",
        ProviderArtifactRetention::Compliance => "compliance",
    }
}

pub(super) const fn media_type(media_type: ProviderArtifactMediaType) -> &'static str {
    match media_type {
        ProviderArtifactMediaType::ApplicationJson => "application/json",
        ProviderArtifactMediaType::TextMarkdown => "text/markdown",
        ProviderArtifactMediaType::TextPlain => "text/plain",
    }
}

pub(super) const fn sensitivity(sensitivity: ProviderArtifactSensitivity) -> &'static str {
    match sensitivity {
        ProviderArtifactSensitivity::Public => "public",
        ProviderArtifactSensitivity::Internal => "internal",
        ProviderArtifactSensitivity::WorkspaceSensitive => "workspaceSensitive",
    }
}
