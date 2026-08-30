use std::collections::HashMap;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use jsonwebtoken::Algorithm;
use jsonwebtoken::DecodingKey;
use jsonwebtoken::EncodingKey;
use jsonwebtoken::Header;
use jsonwebtoken::Validation;
use jsonwebtoken::decode;
use jsonwebtoken::encode;
use pretty_assertions::assert_eq;
use reqwest::Client;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use uuid::Uuid;

use crate::IdentitySourceAuthorizationError;
use crate::IdentitySourceAuthorizationRequest;
use crate::IdentitySourceAuthorizer;
use crate::IdentitySourceBootstrapRs256Verifier;
use crate::IdentitySourceRs256SigningKey;
use crate::ProviderIdentitySourceOwner;
use crate::Rs256IdentitySourceAuthorizer;

const KEY_ID: &str = "identity-signing-2026-07";
const PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1qQF2MqTrGAMDm7wXbjJ\nP5sWqGA83tAGUs2ksy7iJXLJdhCg4AtwGm4SFl4f6kxhCSzlN1QdXuZjvRT2wZZi\nGUi9xUE28rf4WLrTxSnwqLuTy5knMP08yC0t/0YU/FGPZMcWb14hG05IvZr8UbmR\naVagxSR8H4rSIymRoVwwmFSrqz068XrWGSYNIfLEASyo5GdAaqmk1JALINHgYGQJ\nVxMxtwcvDxoVKmC7eltUNymMNBZhsv4E8sx9YNLpBoEibznfEpDU/DGzrM5eZCsQ\nzaqbhBOlGd427ifud/Nnd9cPqzgCUc23+0FXSPfpbgksCXAwAmD0OFjQWrgqVdKL\n6QIDAQAB\n-----END PUBLIC KEY-----\n";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceClaims {
    iss: String,
    aud: String,
    sub: String,
    jti: String,
    iat: u64,
    exp: u64,
    service_audience: String,
    scopes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapClaims {
    iss: &'static str,
    aud: &'static str,
    sub: &'static str,
    jti: String,
    iat: i64,
    exp: i64,
    azp: &'static str,
    actor_id: String,
    auth_session_id: String,
    auth_epoch: i64,
    tenant_id: &'static str,
    space_id: &'static str,
    scopes: [&'static str; 1],
}

#[tokio::test]
async fn verified_bootstrap_binds_owner_and_operation_specific_service_scopes() {
    let now = unix_now();
    let bootstrap_token = bootstrap_token(now);
    let verifier = verifier();
    let bootstrap = verifier
        .verify(bootstrap_token.clone(), now)
        .expect("verified bootstrap");
    let owner = owner();
    assert_eq!(bootstrap.owner(), owner);
    let authorizer = Rs256IdentitySourceAuthorizer::with_bootstrap(signing_key(), bootstrap);

    for (request, expected_scope, expect_principal) in [
        (
            IdentitySourceAuthorizationRequest::Resolve {
                owner: owner.clone(),
            },
            "identityBinding:resolve",
            true,
        ),
        (
            IdentitySourceAuthorizationRequest::SessionIssue {
                source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
                owner: owner.clone(),
            },
            "principalSession:issue",
            true,
        ),
        (
            IdentitySourceAuthorizationRequest::Read {
                source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
                owner: owner.clone(),
            },
            "identityBinding:read",
            false,
        ),
    ] {
        let headers = authorizer
            .authorize(request)
            .await
            .expect("identity authorization");
        let request = headers
            .apply(Client::new().get("https://identity.example.test"))
            .build()
            .expect("request");
        let service_token = request.headers()["authorization"]
            .to_str()
            .expect("authorization")
            .strip_prefix("Bearer ")
            .expect("bearer");
        let claims = decode_service(service_token);
        assert_eq!(claims.scopes, [expected_scope]);
        assert_eq!(claims.iss, "crewon");
        assert_eq!(claims.aud, "agent-platform-identity-source-api");
        assert_eq!(claims.sub, "crewon-app-server");
        assert_eq!(claims.service_audience, "crewon-identity-source");
        assert_eq!(claims.exp - claims.iat, 300);
        assert!(Uuid::parse_str(&claims.jti).is_ok());
        assert_eq!(
            request
                .headers()
                .get("x-crewon-principal-assertion")
                .is_some(),
            expect_principal
        );
        if expect_principal {
            assert_eq!(
                request.headers()["x-crewon-principal-assertion"],
                bootstrap_token
            );
        }
    }
}

#[tokio::test]
async fn service_only_authorizer_supports_feed_but_rejects_principal_operations() {
    let authorizer = Rs256IdentitySourceAuthorizer::service_only(signing_key());
    let headers = authorizer
        .authorize(IdentitySourceAuthorizationRequest::RevocationRead)
        .await
        .expect("revocation authority");
    let request = headers
        .apply(Client::new().get("https://identity.example.test"))
        .build()
        .expect("request");
    let token = request.headers()["authorization"]
        .to_str()
        .expect("authorization")
        .strip_prefix("Bearer ")
        .expect("bearer");
    assert_eq!(decode_service(token).scopes, ["principalRevocation:read"]);
    assert!(
        request
            .headers()
            .get("x-crewon-principal-assertion")
            .is_none()
    );

    assert_eq!(
        authorizer
            .authorize(IdentitySourceAuthorizationRequest::Resolve { owner: owner() })
            .await
            .err(),
        Some(IdentitySourceAuthorizationError::Unauthorized)
    );
}

#[tokio::test]
async fn authorizer_rejects_owner_mismatch_without_issuing_headers() {
    let now = unix_now();
    let bootstrap = verifier()
        .verify(bootstrap_token(now), now)
        .expect("bootstrap");
    let authorizer = Rs256IdentitySourceAuthorizer::with_bootstrap(signing_key(), bootstrap);
    let mismatch = ProviderIdentitySourceOwner::new(
        "principal:0000000000000000000000000000000000000000000000000000000000000000",
        "7",
        "11",
    )
    .expect("mismatch owner");

    assert_eq!(
        authorizer
            .authorize(IdentitySourceAuthorizationRequest::Resolve { owner: mismatch })
            .await
            .err(),
        Some(IdentitySourceAuthorizationError::Unauthorized)
    );
}

#[test]
fn bootstrap_verifier_rejects_claim_drift_and_redacts_tokens() {
    let now = unix_now();
    let mut claims = bootstrap_claims(now);
    claims.scopes = ["principalSession:issue"];
    let drifted = encode_bootstrap(&claims);
    assert_eq!(
        verifier().verify(drifted, now).err(),
        Some(IdentitySourceAuthorizationError::Unauthorized)
    );

    let mut invalid_epoch = bootstrap_claims(now);
    invalid_epoch.auth_epoch = 0;
    assert_eq!(
        verifier()
            .verify(encode_bootstrap(&invalid_epoch), now)
            .err(),
        Some(IdentitySourceAuthorizationError::Unauthorized)
    );

    let verified = verifier()
        .verify(bootstrap_token(now), now)
        .expect("verified");
    assert_eq!(
        format!("{verified:?}"),
        "VerifiedBootstrapPrincipal([REDACTED])"
    );
}

fn verifier() -> IdentitySourceBootstrapRs256Verifier {
    IdentitySourceBootstrapRs256Verifier::new(
        HashMap::from([(KEY_ID.to_string(), PUBLIC_KEY_PEM.to_string())]),
        30,
    )
    .expect("bootstrap verifier")
}

fn signing_key() -> Arc<IdentitySourceRs256SigningKey> {
    Arc::new(
        IdentitySourceRs256SigningKey::from_rsa_pem(KEY_ID, &private_key_pem())
            .expect("identity signing key"),
    )
}

fn owner() -> ProviderIdentitySourceOwner {
    ProviderIdentitySourceOwner::new(stable_actor_id(), "7", "11").expect("owner")
}

fn bootstrap_token(now: i64) -> String {
    encode_bootstrap(&bootstrap_claims(now))
}

fn bootstrap_claims(now: i64) -> BootstrapClaims {
    BootstrapClaims {
        iss: "agent-platform",
        aud: "agent-platform-identity-source-api",
        sub: "user:42",
        jti: Uuid::now_v7().to_string(),
        iat: now,
        exp: now + 300,
        azp: "crewon-app-server",
        actor_id: stable_actor_id(),
        auth_session_id: Uuid::now_v7().to_string(),
        auth_epoch: 1,
        tenant_id: "7",
        space_id: "11",
        scopes: ["identityBinding:resolve"],
    }
}

fn encode_bootstrap(claims: &BootstrapClaims) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some("crewon-principal+jwt".to_string());
    header.kid = Some(KEY_ID.to_string());
    encode(
        &header,
        claims,
        &EncodingKey::from_rsa_pem(&private_key_pem()).expect("encoding key"),
    )
    .expect("bootstrap token")
}

fn decode_service(token: &str) -> ServiceClaims {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&["agent-platform-identity-source-api"]);
    validation.set_issuer(&["crewon"]);
    decode::<ServiceClaims>(
        token,
        &DecodingKey::from_rsa_pem(PUBLIC_KEY_PEM.as_bytes()).expect("decoding key"),
        &validation,
    )
    .expect("service token")
    .claims
}

fn private_key_pem() -> Vec<u8> {
    let path =
        crewon_utils_cargo_bin::find_resource!("tests/fixtures/provider_rs256_test_private.pem")
            .expect("private key fixture");
    std::fs::read(path).expect("private key")
}

fn stable_actor_id() -> String {
    let mut digest = Sha256::new();
    digest.update(b"crewon.authenticated-principal.v1\0");
    digest.update(("agent-platform".len() as u64).to_be_bytes());
    digest.update(b"agent-platform");
    digest.update(("user:42".len() as u64).to_be_bytes());
    digest.update(b"user:42");
    format!("principal:{:x}", digest.finalize())
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_secs() as i64
}
