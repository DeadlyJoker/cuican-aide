use reqwest::Method;
use reqwest::StatusCode;
use serde::Deserialize;
use serde::Serialize;
use uuid::Uuid;

use crate::AgentPlatformIdentitySourceClient;
use crate::AgentPlatformProviderError;
use crate::IdentitySourceAuthorizationRequest;
use crate::IdentitySourceAuthorizer;
use crate::ProviderIdentitySourceOwner;
use crate::http_client::validate_json_content_type;
use crate::identity_source_client::IdentitySourceErrorWire;
use crate::identity_source_client::map_identity_source_error;
use crate::principal_session_source::PrincipalRevocation;
use crate::principal_session_source::PrincipalRevocationCursor;
use crate::principal_session_source::PrincipalRevocationCursorSpec;
use crate::principal_session_source::PrincipalRevocationReadPage;
use crate::principal_session_source::PrincipalRevocationSnapshotPage;
use crate::principal_session_source::PrincipalRevocationSpec;
use crate::principal_session_source::PrincipalSessionIssued;
use crate::principal_session_source::PrincipalSessionToken;

const MAX_PAGE_SIZE: u32 = 100;
const MAX_SEQUENCE: u64 = i64::MAX as u64;

impl<Authorizer> AgentPlatformIdentitySourceClient<Authorizer>
where
    Authorizer: IdentitySourceAuthorizer,
{
    pub async fn issue_principal_session(
        &self,
        source_binding_id: impl Into<String>,
        owner: ProviderIdentitySourceOwner,
    ) -> Result<PrincipalSessionIssued, AgentPlatformProviderError> {
        let source_binding_id = canonical_request_uuid(source_binding_id.into())?;
        let authorization = self
            .authorizer
            .authorize(IdentitySourceAuthorizationRequest::SessionIssue {
                source_binding_id: source_binding_id.clone(),
                owner,
            })
            .await
            .map_err(super::identity_source_client::map_authorization)?;
        let response = authorization
            .apply(
                self.transport
                    .request(Method::POST, "./principal-sessions:issue")?
                    .json(&SessionIssueRequest {
                        source_binding_id: &source_binding_id,
                    }),
            )
            .send()
            .await
            .map_err(crewon_provider_transport::classify_request_error)?;
        let wire: SessionIssueResponse = self.parse(response).await?;
        if wire.token.is_empty()
            || wire.expires_at < 0
            || wire.source_binding_id != source_binding_id
            || wire.source_revision == 0
            || wire.source_revision > MAX_SEQUENCE
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(PrincipalSessionIssued {
            token: PrincipalSessionToken::new(wire.token),
            expires_at: wire.expires_at,
            source_binding_id: wire.source_binding_id,
            source_revision: wire.source_revision,
        })
    }

    pub async fn principal_revocation_snapshot(
        &self,
        after_sequence: u64,
        watermark_sequence: Option<u64>,
        limit: u32,
        now: i64,
    ) -> Result<PrincipalRevocationSnapshotPage, AgentPlatformProviderError> {
        validate_page(limit, now)?;
        validate_snapshot_request(after_sequence, watermark_sequence)?;
        let wire: SnapshotResponse = self
            .post_revocation(
                "./principal-revocations:snapshot",
                &SnapshotRequest {
                    after_sequence,
                    watermark_sequence,
                    limit,
                },
            )
            .await?;
        let stream_id = canonical_uuid(wire.stream_id)?;
        if wire.watermark_sequence < after_sequence
            || wire.watermark_sequence > MAX_SEQUENCE
            || watermark_sequence.is_some_and(|expected| wire.watermark_sequence != expected)
            || wire.next_after_sequence.is_some_and(|next| {
                next <= after_sequence || next > wire.watermark_sequence || next > MAX_SEQUENCE
            })
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        let data = parse_revocations(wire.data, now, after_sequence, wire.watermark_sequence)?;
        if wire
            .next_after_sequence
            .is_some_and(|next| data.last().map(PrincipalRevocation::sequence) != Some(next))
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(PrincipalRevocationSnapshotPage {
            stream_id,
            watermark_sequence: wire.watermark_sequence,
            data,
            next_after_sequence: wire.next_after_sequence,
        })
    }

    pub async fn principal_revocation_read(
        &self,
        current: &PrincipalRevocationCursor,
        limit: u32,
        now: i64,
    ) -> Result<PrincipalRevocationReadPage, AgentPlatformProviderError> {
        validate_page(limit, now)?;
        let wire: ReadResponse = self
            .post_revocation(
                "./principal-revocations:read",
                &ReadRequest {
                    cursor: CursorWire {
                        stream_id: current.stream_id(),
                        sequence: current.sequence(),
                    },
                    limit,
                },
            )
            .await?;
        let stream_id = canonical_uuid(wire.cursor.stream_id)?;
        if stream_id != current.stream_id()
            || wire.cursor.sequence < current.sequence()
            || wire.cursor.sequence > MAX_SEQUENCE
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        let data = parse_revocations(wire.data, now, current.sequence(), wire.cursor.sequence)?;
        let cursor = PrincipalRevocationCursor::new(PrincipalRevocationCursorSpec {
            stream_id,
            sequence: wire.cursor.sequence,
        })
        .map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
        Ok(PrincipalRevocationReadPage { data, cursor })
    }

    async fn post_revocation<Body: Serialize, Response: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &Body,
    ) -> Result<Response, AgentPlatformProviderError> {
        let authorization = self
            .authorizer
            .authorize(IdentitySourceAuthorizationRequest::RevocationRead)
            .await
            .map_err(super::identity_source_client::map_authorization)?;
        let response = authorization
            .apply(self.transport.request(Method::POST, path)?.json(body))
            .send()
            .await
            .map_err(crewon_provider_transport::classify_request_error)?;
        self.parse(response).await
    }

    async fn parse<Response: for<'de> Deserialize<'de>>(
        &self,
        response: reqwest::Response,
    ) -> Result<Response, AgentPlatformProviderError> {
        let status = response.status();
        validate_json_content_type(response.headers())?;
        let body = self.transport.read_bounded_body(response).await?;
        if status == StatusCode::OK {
            return serde_json::from_slice(&body)
                .map_err(|_| AgentPlatformProviderError::InvalidResponse);
        }
        let error = serde_json::from_slice::<IdentitySourceErrorWire>(&body)
            .map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
        map_identity_source_error(status, error)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionIssueRequest<'a> {
    source_binding_id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionIssueResponse {
    token: String,
    expires_at: i64,
    source_binding_id: String,
    source_revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRequest {
    after_sequence: u64,
    watermark_sequence: Option<u64>,
    limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotResponse {
    stream_id: String,
    watermark_sequence: u64,
    data: Vec<RevocationWire>,
    next_after_sequence: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadRequest<'a> {
    cursor: CursorWire<'a>,
    limit: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorWire<'a> {
    stream_id: &'a str,
    sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadResponse {
    data: Vec<RevocationWire>,
    cursor: OwnedCursorWire,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedCursorWire {
    stream_id: String,
    sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevocationWire {
    sequence: u64,
    issuer: String,
    session_jti: String,
    expires_at: i64,
    revoked_at: i64,
}

fn parse_revocations(
    wire: Vec<RevocationWire>,
    now: i64,
    minimum_sequence: u64,
    maximum_sequence: u64,
) -> Result<Vec<crate::PrincipalRevocation>, AgentPlatformProviderError> {
    if wire.len() > MAX_PAGE_SIZE as usize {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    let mut previous = minimum_sequence;
    wire.into_iter()
        .map(|item| {
            if item.sequence <= previous
                || item.sequence > maximum_sequence
                || item.expires_at <= now
            {
                return Err(AgentPlatformProviderError::InvalidResponse);
            }
            previous = item.sequence;
            PrincipalRevocation::new(PrincipalRevocationSpec {
                sequence: item.sequence,
                issuer: item.issuer,
                session_jti: item.session_jti,
                expires_at: item.expires_at,
                revoked_at: item.revoked_at,
            })
            .map_err(|_| AgentPlatformProviderError::InvalidResponse)
        })
        .collect()
}

fn validate_page(limit: u32, now: i64) -> Result<(), AgentPlatformProviderError> {
    if limit == 0 || limit > MAX_PAGE_SIZE || now < 0 {
        return Err(AgentPlatformProviderError::InvalidRequest);
    }
    Ok(())
}

fn validate_snapshot_request(
    after_sequence: u64,
    watermark_sequence: Option<u64>,
) -> Result<(), AgentPlatformProviderError> {
    if after_sequence > MAX_SEQUENCE
        || watermark_sequence
            .is_some_and(|watermark| watermark > MAX_SEQUENCE || watermark < after_sequence)
    {
        return Err(AgentPlatformProviderError::InvalidRequest);
    }
    Ok(())
}

fn canonical_uuid(value: String) -> Result<String, AgentPlatformProviderError> {
    let parsed =
        Uuid::parse_str(&value).map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
    if parsed.to_string() != value {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    Ok(value)
}

fn canonical_request_uuid(value: String) -> Result<String, AgentPlatformProviderError> {
    let parsed = Uuid::parse_str(&value).map_err(|_| AgentPlatformProviderError::InvalidRequest)?;
    if parsed.to_string() != value {
        return Err(AgentPlatformProviderError::InvalidRequest);
    }
    Ok(value)
}
