use std::path::Path;

use anyhow::Context;
use anyhow::Result;
use jsonwebtoken::Algorithm;
use jsonwebtoken::EncodingKey;
use jsonwebtoken::Header;
use jsonwebtoken::encode;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tempfile::NamedTempFile;

use super::PROVIDER_ID;
use super::SOURCE_BINDING_ID;

pub(super) const KEY_ID: &str = "w3-01-test-key";

const PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1qQF2MqTrGAMDm7wXbjJ
P5sWqGA83tAGUs2ksy7iJXLJdhCg4AtwGm4SFl4f6kxhCSzlN1QdXuZjvRT2wZZi
GUi9xUE28rf4WLrTxSnwqLuTy5knMP08yC0t/0YU/FGPZMcWb14hG05IvZr8UbmR
aVagxSR8H4rSIymRoVwwmFSrqz068XrWGSYNIfLEASyo5GdAaqmk1JALINHgYGQJ
VxMxtwcvDxoVKmC7eltUNymMNBZhsv4E8sx9YNLpBoEibznfEpDU/DGzrM5eZCsQ
zaqbhBOlGd427ifud/Nnd9cPqzgCUc23+0FXSPfpbgksCXAwAmD0OFjQWrgqVdKL
6QIDAQAB
-----END PUBLIC KEY-----"#;
const SESSION_ID: &str = "019f6f00-0000-7000-8000-000000000011";
const SPACE_ID: &str = "11";
const SUBJECT: &str = "user:42";
const TENANT_ID: &str = "7";

pub(super) fn principal_session_token(now: i64, private_key_path: &Path) -> Result<String> {
    let claims = PrincipalSessionClaims {
        iss: PROVIDER_ID,
        aud: "crewon-app-server",
        sub: SUBJECT,
        actor_id: stable_actor_id(),
        tenant_id: TENANT_ID,
        space_id: SPACE_ID,
        source_binding_id: SOURCE_BINDING_ID,
        source_revision: 1,
        jti: SESSION_ID,
        iat: now,
        exp: now + 3_000,
    };
    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some("crewon-principal-session+jwt".to_string());
    header.kid = Some(KEY_ID.to_string());
    let key = std::fs::read(private_key_path).context("read test signing key")?;
    encode(
        &header,
        &claims,
        &EncodingKey::from_rsa_pem(&key).context("parse test signing key")?,
    )
    .context("sign principal session")
}

pub(super) fn snapshot(now: i64) -> Value {
    let actor_id = stable_actor_id();
    let created_at = now - 10;
    json!({
        "schemaVersion": "1.0.0",
        "authorityId": "agent-platform-identity",
        "binding": {
            "sourceBindingId": SOURCE_BINDING_ID,
            "sourceRevision": 1,
            "status": "active",
            "localOwner": {
                "actorId": actor_id,
                "tenantId": TENANT_ID,
                "spaceId": SPACE_ID
            },
            "providerIdentity": {
                "providerId": PROVIDER_ID,
                "subject": SUBJECT,
                "tenantId": TENANT_ID,
                "spaceId": SPACE_ID
            },
            "createdAt": created_at,
            "updatedAt": created_at,
            "bindingDigest": identity_binding_digest(&stable_actor_id(), created_at)
        },
        "freshness": {
            "issuedAt": now - 1,
            "freshUntil": now + 59
        }
    })
}

pub(super) fn stable_actor_id() -> String {
    let mut digest = Sha256::new();
    digest.update(b"crewon.authenticated-principal.v1\0");
    digest.update((PROVIDER_ID.len() as u64).to_be_bytes());
    digest.update(PROVIDER_ID.as_bytes());
    digest.update((SUBJECT.len() as u64).to_be_bytes());
    digest.update(SUBJECT.as_bytes());
    format!("principal:{:x}", digest.finalize())
}

pub(super) fn provider_scopes() -> Vec<String> {
    [
        "provider.discovery",
        "providerKnowledge:search",
        "providerRun:cancel",
        "providerRun:events",
        "providerRun:read",
        "providerRun:start",
        "providerTool:call",
    ]
    .map(str::to_string)
    .to_vec()
}

pub(super) fn private_key_file() -> Result<NamedTempFile> {
    let source = crewon_utils_cargo_bin::find_resource!(
        "../provider-agent-platform/tests/fixtures/provider_rs256_test_private.pem"
    )
    .context("find RSA fixture")?;
    let key = std::fs::read(source).context("read RSA fixture")?;
    let file = NamedTempFile::new().context("create private key file")?;
    std::fs::write(file.path(), key).context("write private key file")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600))
            .context("set private key permissions")?;
    }
    Ok(file)
}

pub(super) fn trusted_key_file() -> Result<NamedTempFile> {
    let file = NamedTempFile::new().context("create trusted key file")?;
    std::fs::write(
        file.path(),
        serde_json::to_vec(&json!({(KEY_ID): PUBLIC_KEY_PEM}))?,
    )
    .context("write trusted key file")?;
    Ok(file)
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
        TENANT_ID,
        SPACE_ID,
        PROVIDER_ID,
        SUBJECT,
        TENANT_ID,
        SPACE_ID,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrincipalSessionClaims<'a> {
    iss: &'a str,
    aud: &'a str,
    sub: &'a str,
    actor_id: String,
    tenant_id: &'a str,
    space_id: &'a str,
    source_binding_id: &'a str,
    source_revision: u64,
    jti: &'a str,
    iat: i64,
    exp: i64,
}
