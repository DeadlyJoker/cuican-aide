use std::sync::Arc;

use crewon_keyring_store::tests::MockKeyringStore;
use pretty_assertions::assert_eq;

use super::*;
use crate::SecretsBackendKind;
use crate::SecretsManager;

const CREATED_AT: i64 = 1_800_000_000;

fn owner() -> CredentialOwner {
    CredentialOwner::space_user("actor-1", "tenant-1", "space-1").expect("valid owner")
}

fn create_request(secret: &str) -> CredentialCreateRequest {
    CredentialCreateRequest {
        provider_id: "agent-platform".to_string(),
        owner: owner(),
        scope: CredentialScopeKind::Space,
        granted_scopes: vec![
            GrantedCredentialScope::new("agent:read").expect("valid scope"),
            GrantedCredentialScope::new("agent:run").expect("valid scope"),
        ],
        secret: CredentialSecret::new(secret).expect("valid secret"),
        expires_at: Some(CREATED_AT + 300),
        now: CREATED_AT,
    }
}

fn access_request(
    credential_id: &CredentialId,
    owner: CredentialOwner,
    now: i64,
) -> CredentialAccessRequest {
    CredentialAccessRequest {
        credential_id: credential_id.clone(),
        owner,
        now,
    }
}

#[test]
fn fake_store_enforces_complete_lifecycle_and_owner_boundary() {
    let store = FakeCredentialStore::default();
    let secret = "sensitive-value-one";
    let created = store.create(create_request(secret)).expect("create");
    assert_eq!(
        created,
        CredentialMetadata {
            credential_id: CredentialId::parse("cred_00000000000000000000000000000001")
                .expect("valid id"),
            provider_id: "agent-platform".to_string(),
            owner: owner(),
            scope: CredentialScopeKind::Space,
            granted_scopes: ["agent:read", "agent:run"]
                .into_iter()
                .map(|scope| GrantedCredentialScope::new(scope).expect("valid scope"))
                .collect(),
            status: CredentialStatus::Available,
            expires_at: Some(CREATED_AT + 300),
            revision: 1,
            created_at: CREATED_AT,
            rotated_at: None,
            revoked_at: None,
        }
    );

    let other_owner =
        CredentialOwner::space_user("actor-2", "tenant-1", "space-1").expect("valid owner");
    assert_eq!(
        store.inspect(access_request(
            &created.credential_id,
            other_owner,
            CREATED_AT,
        )),
        Err(CredentialStoreError::NotFound)
    );

    let access = store
        .read(access_request(&created.credential_id, owner(), CREATED_AT))
        .expect("read");
    assert_eq!(access.secret.expose_secret(), secret);

    let rotated = store
        .rotate(CredentialRotateRequest {
            credential_id: created.credential_id.clone(),
            owner: owner(),
            secret: CredentialSecret::new("sensitive-value-two").expect("valid secret"),
            expires_at: Some(CREATED_AT + 600),
            now: CREATED_AT + 10,
        })
        .expect("rotate");
    assert_eq!(
        rotated,
        CredentialMetadata {
            revision: 2,
            expires_at: Some(CREATED_AT + 600),
            rotated_at: Some(CREATED_AT + 10),
            ..created.clone()
        }
    );
    assert_eq!(
        store
            .read(access_request(
                &created.credential_id,
                owner(),
                CREATED_AT + 10,
            ))
            .expect("read rotated")
            .secret
            .expose_secret(),
        "sensitive-value-two"
    );

    let revoked = store
        .revoke(access_request(
            &created.credential_id,
            owner(),
            CREATED_AT + 20,
        ))
        .expect("revoke");
    assert_eq!(
        revoked,
        CredentialMetadata {
            status: CredentialStatus::Revoked,
            revoked_at: Some(CREATED_AT + 20),
            ..rotated
        }
    );
    assert_eq!(
        store.revoke(access_request(
            &created.credential_id,
            owner(),
            CREATED_AT + 30,
        )),
        Ok(revoked)
    );
    assert!(matches!(
        store.read(access_request(
            &created.credential_id,
            owner(),
            CREATED_AT + 30,
        )),
        Err(CredentialStoreError::Revoked)
    ));
}

#[test]
fn fake_store_expires_without_rewriting_history() {
    let store = FakeCredentialStore::default();
    let created = store
        .create(create_request("temporary-sensitive-value"))
        .expect("create");
    let expired_at = created.expires_at.expect("expiry");

    assert_eq!(
        store
            .inspect(access_request(&created.credential_id, owner(), expired_at,))
            .expect("inspect")
            .status,
        CredentialStatus::Expired
    );
    assert!(matches!(
        store.read(access_request(&created.credential_id, owner(), expired_at,)),
        Err(CredentialStoreError::Expired)
    ));
    let rotated = store
        .rotate(CredentialRotateRequest {
            credential_id: created.credential_id,
            owner: owner(),
            secret: CredentialSecret::new("replacement-sensitive-value").expect("valid secret"),
            expires_at: Some(expired_at + 300),
            now: expired_at,
        })
        .expect("expired credential can be rotated");
    assert_eq!(rotated.status, CredentialStatus::Available);
    assert_eq!(rotated.revision, 2);
}

#[test]
fn secret_debug_and_errors_never_include_secret_value() {
    let store = FakeCredentialStore::default();
    let secret = "do-not-print-this-sensitive-value";
    let created = store.create(create_request(secret)).expect("create");
    let access = store
        .read(access_request(&created.credential_id, owner(), CREATED_AT))
        .expect("read");

    let secret_debug = format!("{:?}", access.secret);
    let access_debug = format!("{access:?}");
    assert_eq!(secret_debug, "CredentialSecret([REDACTED])");
    assert!(!access_debug.contains(secret));
    assert!(access_debug.contains("[REDACTED]"));

    let error = CredentialSecret::new(String::new()).expect_err("empty secret must fail");
    assert!(!error.to_string().contains(secret));
    assert!(!format!("{error:?}").contains(secret));
}

#[test]
fn local_store_round_trips_through_encrypted_secrets_backend() {
    let crewon_home = tempfile::tempdir().expect("tempdir");
    let keyring = Arc::new(MockKeyringStore::default());
    let manager = SecretsManager::new_with_keyring_store(
        crewon_home.path().to_path_buf(),
        SecretsBackendKind::Local,
        keyring,
    );
    let store = LocalCredentialStore::new(manager);
    let secret = "local-sensitive-value";
    let created = store.create(create_request(secret)).expect("create");

    let access = store
        .read(access_request(&created.credential_id, owner(), CREATED_AT))
        .expect("read");
    assert_eq!(access.secret.expose_secret(), secret);

    let ciphertext = std::fs::read(crewon_home.path().join("secrets/local.age"))
        .expect("encrypted secrets file");
    assert!(
        !ciphertext
            .windows(secret.len())
            .any(|window| window == secret.as_bytes())
    );
}

#[test]
fn creation_rejects_invalid_scope_expiry_and_unbounded_inputs() {
    let store = FakeCredentialStore::default();

    let mut missing_space = create_request("scope-sensitive-value");
    missing_space.owner =
        CredentialOwner::tenant_user("actor-1", "tenant-1").expect("valid tenant owner");
    assert_eq!(
        store.create(missing_space),
        Err(CredentialStoreError::InvalidInput(
            "space credential requires space owner"
        ))
    );

    let mut expired = create_request("expiry-sensitive-value");
    expired.expires_at = Some(CREATED_AT);
    assert_eq!(
        store.create(expired),
        Err(CredentialStoreError::InvalidInput(
            "credential expiry must be in the future"
        ))
    );

    let mut too_many_scopes = create_request("scopes-sensitive-value");
    too_many_scopes.granted_scopes = (0..=MAX_GRANTED_SCOPES)
        .map(|index| GrantedCredentialScope::new(format!("scope:{index}")).expect("valid scope"))
        .collect();
    assert_eq!(
        store.create(too_many_scopes),
        Err(CredentialStoreError::InvalidInput(
            "invalid credential granted scope count"
        ))
    );

    assert_eq!(
        CredentialSecret::new("x".repeat(MAX_SECRET_BYTES + 1)).expect_err("bounded secret"),
        CredentialStoreError::InvalidInput("invalid credential secret")
    );
}

#[test]
fn credential_value_deserialization_preserves_validation_invariants() {
    assert!(serde_json::from_str::<CredentialId>(r#""not-a-credential-id""#).is_err());
    assert!(serde_json::from_str::<GrantedCredentialScope>(r#""scope with spaces""#).is_err());
    assert!(
        serde_json::from_str::<CredentialOwner>(
            r#"{"actorId":"actor-1","tenantId":null,"spaceId":"space-1"}"#,
        )
        .is_err()
    );
}
