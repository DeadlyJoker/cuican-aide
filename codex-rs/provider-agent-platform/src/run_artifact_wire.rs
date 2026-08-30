use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use serde::Deserialize;

use crate::AgentPlatformProviderError;
use crate::ProviderArtifactKind;
use crate::ProviderArtifactMediaType;
use crate::ProviderArtifactRef;
use crate::ProviderArtifactRetention;
use crate::ProviderArtifactSensitivity;
use crate::ProviderRunArtifactContent;
use crate::ProviderRunArtifactImportRequest;
use crate::ProviderRunArtifactImportResult;
use crate::ProviderRunArtifactReadRequest;
use crate::run_artifact::MAX_ARTIFACT_BYTES;
use crate::run_artifact::digest;
use crate::run_wire::ArtifactRefWire;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportArtifactResponseWire {
    artifact: ArtifactRefWire,
    media_type: ProviderArtifactMediaType,
    sensitivity: ProviderArtifactSensitivity,
    content_digest: String,
    byte_length: u64,
    created: bool,
}

impl ImportArtifactResponseWire {
    pub(crate) fn into_domain(
        self,
        expected: &ProviderRunArtifactImportRequest,
    ) -> Result<ProviderRunArtifactImportResult, AgentPlatformProviderError> {
        let artifact = self.artifact.into_domain()?;
        let byte_length = usize::try_from(self.byte_length)
            .map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
        if artifact != *expected.artifact()
            || self.media_type != expected.media_type()
            || self.sensitivity != expected.sensitivity()
            || self.content_digest != expected.content_digest()
            || byte_length != expected.content().len()
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(ProviderRunArtifactImportResult::from_response(
            artifact,
            self.media_type,
            self.sensitivity,
            self.content_digest,
            byte_length,
            self.created,
        ))
    }
}

pub(crate) fn import_path(artifact: &ProviderArtifactRef) -> String {
    format!(
        "./artifacts/{}/revisions/{}",
        encode_path_segment(artifact.artifact_id()),
        artifact.revision()
    )
}

pub(crate) fn import_headers(
    request: &ProviderRunArtifactImportRequest,
) -> Result<HeaderMap, AgentPlatformProviderError> {
    let mut headers = HeaderMap::new();
    insert_header(&mut headers, CONTENT_TYPE, request.media_type().as_str())?;
    insert_static(&mut headers, "idempotency-key", request.idempotency_key())?;
    insert_static(
        &mut headers,
        "x-crewon-artifact-task-id",
        request.artifact().task_id(),
    )?;
    insert_static(
        &mut headers,
        "x-crewon-artifact-kind",
        artifact_kind(request.artifact().kind()),
    )?;
    insert_static(
        &mut headers,
        "x-crewon-artifact-retention",
        artifact_retention(request.artifact().retention()),
    )?;
    insert_static(
        &mut headers,
        "x-crewon-artifact-created-at",
        &request.artifact().created_at().to_string(),
    )?;
    insert_static(
        &mut headers,
        "x-crewon-artifact-expires-at",
        &request.expires_at().to_string(),
    )?;
    insert_static(
        &mut headers,
        "x-crewon-artifact-sensitivity",
        request.sensitivity().as_str(),
    )?;
    insert_static(
        &mut headers,
        "x-crewon-content-digest",
        request.content_digest(),
    )?;
    Ok(headers)
}

pub(crate) fn validate_read_response(
    headers: &HeaderMap,
    body: Vec<u8>,
    request: &ProviderRunArtifactReadRequest,
) -> Result<ProviderRunArtifactContent, AgentPlatformProviderError> {
    let expected = request.artifact();
    if body.len() > MAX_ARTIFACT_BYTES || std::str::from_utf8(&body).is_err() {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    let media_type = match single_header(headers, CONTENT_TYPE.as_str())?
        .split(';')
        .next()
        .map(str::trim)
    {
        Some("application/json") => ProviderArtifactMediaType::ApplicationJson,
        Some("text/markdown") => ProviderArtifactMediaType::TextMarkdown,
        Some("text/plain") => ProviderArtifactMediaType::TextPlain,
        _ => return Err(AgentPlatformProviderError::InvalidResponse),
    };
    let artifact_id = single_header(headers, "x-crewon-artifact-id")?;
    let revision = single_header(headers, "x-crewon-artifact-revision")?
        .parse::<u64>()
        .map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
    let sensitivity = match single_header(headers, "x-crewon-artifact-sensitivity")? {
        "public" => ProviderArtifactSensitivity::Public,
        "internal" => ProviderArtifactSensitivity::Internal,
        "workspaceSensitive" => ProviderArtifactSensitivity::WorkspaceSensitive,
        _ => return Err(AgentPlatformProviderError::InvalidResponse),
    };
    let content_digest = single_header(headers, "x-crewon-content-digest")?.to_string();
    if artifact_id != expected.artifact_id()
        || revision != expected.revision()
        || content_digest != digest(&body)
    {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    ProviderRunArtifactContent::new(
        request.authorization().clone(),
        expected.clone(),
        media_type,
        sensitivity,
        content_digest,
        body,
    )
}

fn insert_static(
    headers: &mut HeaderMap,
    name: &'static str,
    value: &str,
) -> Result<(), AgentPlatformProviderError> {
    insert_header(headers, HeaderName::from_static(name), value)
}

fn insert_header(
    headers: &mut HeaderMap,
    name: HeaderName,
    value: &str,
) -> Result<(), AgentPlatformProviderError> {
    headers.insert(
        name,
        HeaderValue::from_str(value).map_err(|_| AgentPlatformProviderError::InvalidRequest)?,
    );
    Ok(())
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

const fn artifact_kind(kind: ProviderArtifactKind) -> &'static str {
    match kind {
        ProviderArtifactKind::File => "file",
        ProviderArtifactKind::Image => "image",
        ProviderArtifactKind::Report => "report",
        ProviderArtifactKind::Evidence => "evidence",
        ProviderArtifactKind::ToolResult => "toolResult",
    }
}

const fn artifact_retention(retention: ProviderArtifactRetention) -> &'static str {
    match retention {
        ProviderArtifactRetention::Session => "session",
        ProviderArtifactRetention::Task => "task",
        ProviderArtifactRetention::UserManaged => "userManaged",
        ProviderArtifactRetention::Compliance => "compliance",
    }
}

fn encode_path_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}
