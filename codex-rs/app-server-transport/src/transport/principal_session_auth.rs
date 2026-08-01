use std::collections::HashMap;
use std::fmt;

use jsonwebtoken::Algorithm;
use jsonwebtoken::DecodingKey;
use jsonwebtoken::Validation;
use jsonwebtoken::decode;
use jsonwebtoken::decode_header;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use uuid::Uuid;

use super::TransportAuthenticatedPrincipal;
use super::TransportAuthenticatedPrincipalSource;
use super::TransportAuthentication;
use super::TransportPrincipalBinding;
use super::authenticated_principal::TransportAuthenticatedPrincipalSpec;

const EXPECTED_ISSUER: &str = "agent-platform";
const EXPECTED_AUDIENCE: &str = "crewon-app-server";
const EXPECTED_TYPE: &str = "crewon-principal-session+jwt";
const MAX_KEYS: usize = 16;
const MAX_KEY_BYTES: usize = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_CLOCK_SKEW_SECONDS: i64 = 300;

#[derive(Clone)]
pub struct PrincipalSessionRs256AuthConfig {
    keys: HashMap<String, DecodingKey>,
    max_clock_skew_seconds: i64,
}

impl PrincipalSessionRs256AuthConfig {
    pub fn new(
        trusted_public_keys: HashMap<String, String>,
        max_clock_skew_seconds: u64,
    ) -> Result<Self, PrincipalSessionRs256AuthConfigError> {
        if trusted_public_keys.is_empty()
            || trusted_public_keys.len() > MAX_KEYS
            || max_clock_skew_seconds > MAX_CLOCK_SKEW_SECONDS as u64
        {
            return Err(PrincipalSessionRs256AuthConfigError);
        }
        let mut keys = HashMap::with_capacity(trusted_public_keys.len());
        for (key_id, public_key) in trusted_public_keys {
            validate_text(&key_id, 255).map_err(|_| PrincipalSessionRs256AuthConfigError)?;
            if public_key.is_empty() || public_key.len() > MAX_KEY_BYTES {
                return Err(PrincipalSessionRs256AuthConfigError);
            }
            let decoding_key = DecodingKey::from_rsa_pem(public_key.as_bytes())
                .map_err(|_| PrincipalSessionRs256AuthConfigError)?;
            keys.insert(key_id, decoding_key);
        }
        Ok(Self {
            keys,
            max_clock_skew_seconds: max_clock_skew_seconds as i64,
        })
    }

    pub(super) fn verify(
        &self,
        token: &str,
        now: i64,
    ) -> Result<TransportAuthentication, PrincipalSessionRs256AuthRejected> {
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
            return Err(PrincipalSessionRs256AuthRejected);
        }
        let header = decode_header(token).map_err(|_| PrincipalSessionRs256AuthRejected)?;
        if header.alg != Algorithm::RS256
            || header.typ.as_deref() != Some(EXPECTED_TYPE)
            || header.jku.is_some()
            || header.jwk.is_some()
            || header.x5u.is_some()
            || header.x5c.is_some()
        {
            return Err(PrincipalSessionRs256AuthRejected);
        }
        let key_id = header.kid.ok_or(PrincipalSessionRs256AuthRejected)?;
        let key = self
            .keys
            .get(&key_id)
            .ok_or(PrincipalSessionRs256AuthRejected)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.required_spec_claims.clear();
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.validate_aud = false;
        let claims = decode::<PrincipalSessionClaims>(token, key, &validation)
            .map_err(|_| PrincipalSessionRs256AuthRejected)?
            .claims;
        claims.into_authentication(now, self.max_clock_skew_seconds)
    }
}

impl fmt::Debug for PrincipalSessionRs256AuthConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrincipalSessionRs256AuthConfig")
            .field("keys", &"[REDACTED]")
            .field("max_clock_skew_seconds", &self.max_clock_skew_seconds)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrincipalSessionRs256AuthConfigError;

impl fmt::Display for PrincipalSessionRs256AuthConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("principal session RS256 configuration is invalid")
    }
}

impl std::error::Error for PrincipalSessionRs256AuthConfigError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PrincipalSessionRs256AuthRejected;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrincipalSessionClaims {
    iss: String,
    aud: String,
    sub: String,
    actor_id: String,
    tenant_id: String,
    space_id: String,
    source_binding_id: String,
    source_revision: u64,
    jti: String,
    iat: i64,
    exp: i64,
}

impl PrincipalSessionClaims {
    fn into_authentication(
        self,
        now: i64,
        max_clock_skew_seconds: i64,
    ) -> Result<TransportAuthentication, PrincipalSessionRs256AuthRejected> {
        if self.iss != EXPECTED_ISSUER
            || self.aud != EXPECTED_AUDIENCE
            || self.iat < 0
            || self.iat > now.saturating_add(max_clock_skew_seconds)
            || self.exp <= now
            || self.exp <= self.iat
            || self.exp - self.iat > 60 * 60
            || self.source_revision == 0
            || !canonical_uuid(&self.source_binding_id)
            || !canonical_uuid(&self.jti)
            || !canonical_positive_subject(&self.sub)
            || !canonical_positive_integer(&self.tenant_id)
            || !canonical_positive_integer(&self.space_id)
            || self.actor_id != stable_actor_id(&self.iss, &self.sub)
        {
            return Err(PrincipalSessionRs256AuthRejected);
        }
        let principal = TransportAuthenticatedPrincipal::new(TransportAuthenticatedPrincipalSpec {
            source: TransportAuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
            issuer: self.iss,
            audience: self.aud,
            subject: self.sub,
            tenant_id: self.tenant_id,
            space_id: self.space_id,
            token_id: self.jti,
            issued_at: self.iat,
            expires_at: self.exp,
            binding: TransportPrincipalBinding::AgentPlatform {
                actor_id: self.actor_id,
                source_binding_id: self.source_binding_id,
                source_revision: self.source_revision,
            },
        })
        .map_err(|_| PrincipalSessionRs256AuthRejected)?;
        Ok(TransportAuthentication::AuthenticatedPrincipal(Box::new(
            principal,
        )))
    }
}

fn stable_actor_id(issuer: &str, subject: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"crewon.authenticated-principal.v1\0");
    digest.update((issuer.len() as u64).to_be_bytes());
    digest.update(issuer.as_bytes());
    digest.update((subject.len() as u64).to_be_bytes());
    digest.update(subject.as_bytes());
    format!("principal:{:x}", digest.finalize())
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

fn canonical_positive_subject(value: &str) -> bool {
    value
        .strip_prefix("user:")
        .is_some_and(canonical_positive_integer)
}

fn canonical_positive_integer(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value
            .parse::<u64>()
            .is_ok_and(|parsed| parsed > 0 && parsed.to_string() == value)
}

fn validate_text(value: &str, max_bytes: usize) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
#[path = "principal_session_auth_tests.rs"]
mod tests;
