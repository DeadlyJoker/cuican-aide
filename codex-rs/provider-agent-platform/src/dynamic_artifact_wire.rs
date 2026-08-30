use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderMap;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

use crate::AgentPlatformProviderError;
use crate::ProviderDynamicArtifactContent;
use crate::ProviderDynamicArtifactReadRequest;

const MAX_ARTIFACT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ReadDynamicArtifactCommandType {
    ReadDynamicArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadDynamicArtifactCommandWire {
    #[serde(rename = "type")]
    command_type: ReadDynamicArtifactCommandType,
    command_id: String,
    call_id: String,
    action_digest: String,
    artifact_id: String,
    revision: u64,
    content_digest: String,
}

impl ReadDynamicArtifactCommandWire {
    pub(crate) fn from_domain(request: &ProviderDynamicArtifactReadRequest) -> Self {
        Self {
            command_type: ReadDynamicArtifactCommandType::ReadDynamicArtifact,
            command_id: request.command_id().to_string(),
            call_id: request.authorization().call_id().to_string(),
            action_digest: request.authorization().action_digest().to_string(),
            artifact_id: request.artifact().artifact_id().to_string(),
            revision: request.artifact().revision(),
            content_digest: request.artifact().content_digest().as_str().to_string(),
        }
    }
}

pub(crate) fn validate_dynamic_artifact_response(
    headers: &HeaderMap,
    body: Vec<u8>,
    expected: &crate::ProviderDynamicArtifactRef,
) -> Result<ProviderDynamicArtifactContent, AgentPlatformProviderError> {
    if body.is_empty() || body.len() > MAX_ARTIFACT_BYTES {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    let media_type = single_header(headers, CONTENT_TYPE.as_str())?
        .split(';')
        .next()
        .map(str::trim)
        .filter(|value| matches!(*value, "application/json" | "text/markdown" | "text/plain"))
        .ok_or(AgentPlatformProviderError::InvalidResponse)?
        .to_string();
    let artifact_id = single_header(headers, "x-crewon-artifact-id")?;
    let revision = single_header(headers, "x-crewon-artifact-revision")?
        .parse::<u64>()
        .map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
    let sensitivity = single_header(headers, "x-crewon-artifact-sensitivity")?;
    let content_digest = single_header(headers, "x-crewon-content-digest")?;
    let actual_digest = format!("sha256:{:x}", Sha256::digest(&body));
    if artifact_id != expected.artifact_id()
        || revision != expected.revision()
        || content_digest != expected.content_digest().as_str()
        || content_digest != actual_digest
    {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    let workspace_sensitive = match sensitivity {
        "internal" => false,
        "workspaceSensitive" => true,
        _ => return Err(AgentPlatformProviderError::InvalidResponse),
    };
    ProviderDynamicArtifactContent::new(body, media_type, workspace_sensitive)
}

fn single_header<'a>(
    headers: &'a HeaderMap,
    name: &str,
) -> Result<&'a str, AgentPlatformProviderError> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or(AgentPlatformProviderError::InvalidResponse)?;
    if values.next().is_some() {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    Ok(value)
}
