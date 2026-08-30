use super::TransportAuthenticatedPrincipal;
use super::TransportAuthenticatedPrincipalSource;
use super::TransportAuthentication;
use super::TransportPrincipalBinding;
use super::authenticated_principal::TransportAuthenticatedPrincipalSpec;
use serde::Deserialize;
use serde::Deserializer;

#[derive(Default, Deserialize)]
pub(super) struct WebsocketPrincipalClaims {
    #[serde(
        default,
        rename = "sub",
        deserialize_with = "deserialize_principal_claim"
    )]
    subject: JwtPrincipalClaim<String>,
    #[serde(
        default,
        rename = "tenantId",
        deserialize_with = "deserialize_principal_claim"
    )]
    tenant_id: JwtPrincipalClaim<String>,
    #[serde(
        default,
        rename = "spaceId",
        deserialize_with = "deserialize_principal_claim"
    )]
    space_id: JwtPrincipalClaim<String>,
    #[serde(
        default,
        rename = "jti",
        deserialize_with = "deserialize_principal_claim"
    )]
    token_id: JwtPrincipalClaim<String>,
    #[serde(
        default,
        rename = "iat",
        deserialize_with = "deserialize_principal_claim"
    )]
    issued_at: JwtPrincipalClaim<i64>,
}

pub(super) struct VerifiedWebsocketPrincipalAuthority<'a> {
    pub(super) issuer: Option<&'a str>,
    pub(super) audience: Option<&'a str>,
    pub(super) expires_at: i64,
    pub(super) max_clock_skew_seconds: i64,
    pub(super) now: i64,
}

impl WebsocketPrincipalClaims {
    pub(super) fn into_authentication(
        self,
        authority: VerifiedWebsocketPrincipalAuthority<'_>,
    ) -> Result<TransportAuthentication, InvalidWebsocketPrincipalClaims> {
        let has_principal_claim = self.subject.is_present()
            || self.tenant_id.is_present()
            || self.space_id.is_present()
            || self.token_id.is_present()
            || self.issued_at.is_present();
        if !has_principal_claim {
            return Ok(TransportAuthentication::ConnectionScoped);
        }

        let Some(issuer) = authority.issuer else {
            return Err(InvalidWebsocketPrincipalClaims);
        };
        let Some(audience) = authority.audience else {
            return Err(InvalidWebsocketPrincipalClaims);
        };
        let (
            JwtPrincipalClaim::Value(subject),
            JwtPrincipalClaim::Value(tenant_id),
            JwtPrincipalClaim::Value(space_id),
            JwtPrincipalClaim::Value(token_id),
            JwtPrincipalClaim::Value(issued_at),
        ) = (
            self.subject,
            self.tenant_id,
            self.space_id,
            self.token_id,
            self.issued_at,
        )
        else {
            return Err(InvalidWebsocketPrincipalClaims);
        };
        if authority.expires_at <= authority.now
            || issued_at
                > authority
                    .now
                    .saturating_add(authority.max_clock_skew_seconds)
        {
            return Err(InvalidWebsocketPrincipalClaims);
        }
        let principal = TransportAuthenticatedPrincipal::new(TransportAuthenticatedPrincipalSpec {
            source: TransportAuthenticatedPrincipalSource::WebSocketSignedBearer,
            issuer: issuer.to_string(),
            audience: audience.to_string(),
            subject,
            tenant_id,
            space_id,
            token_id,
            issued_at,
            expires_at: authority.expires_at,
            binding: TransportPrincipalBinding::LegacyUnbound,
        })
        .map_err(|_| InvalidWebsocketPrincipalClaims)?;
        Ok(TransportAuthentication::AuthenticatedPrincipal(Box::new(
            principal,
        )))
    }
}

#[derive(Default)]
enum JwtPrincipalClaim<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<T> JwtPrincipalClaim<T> {
    fn is_present(&self) -> bool {
        !matches!(self, Self::Missing)
    }
}

fn deserialize_principal_claim<'de, D, T>(deserializer: D) -> Result<JwtPrincipalClaim<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(match Option::<T>::deserialize(deserializer)? {
        Some(value) => JwtPrincipalClaim::Value(value),
        None => JwtPrincipalClaim::Null,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct InvalidWebsocketPrincipalClaims;
