use age::secrecy::ExposeSecret;
use age::secrecy::SecretString;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

use super::CredentialAccess;
use super::CredentialAccessRequest;
use super::CredentialCreateRequest;
use super::CredentialId;
use super::CredentialMetadata;
use super::CredentialOwner;
use super::CredentialRotateRequest;
use super::CredentialScopeKind;
use super::CredentialSecret;
use super::CredentialStatus;
use super::CredentialStoreError;
use super::GrantedCredentialScope;
use super::MAX_CREATE_ATTEMPTS;
use super::MAX_GRANTED_SCOPES;
use super::MAX_SECRET_BYTES;
use super::normalize_scopes;
use super::validate_expiry;
use super::validate_identifier;
use super::validate_owner_scope;
use super::validate_provider_id;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredCredential {
    pub(super) credential_id: CredentialId,
    pub(super) provider_id: String,
    pub(super) owner: CredentialOwner,
    pub(super) scope: CredentialScopeKind,
    pub(super) granted_scopes: std::collections::BTreeSet<GrantedCredentialScope>,
    #[serde(
        serialize_with = "serialize_secret",
        deserialize_with = "deserialize_secret"
    )]
    pub(super) secret: SecretString,
    pub(super) expires_at: Option<i64>,
    pub(super) revision: u64,
    pub(super) created_at: i64,
    pub(super) rotated_at: Option<i64>,
    pub(super) revoked_at: Option<i64>,
}

pub(super) trait CredentialRecordBackend: Send + Sync {
    fn insert(&self, record: &StoredCredential) -> Result<bool, CredentialStoreError>;
    fn load(
        &self,
        credential_id: &CredentialId,
    ) -> Result<Option<StoredCredential>, CredentialStoreError>;
    fn save(&self, record: &StoredCredential) -> Result<(), CredentialStoreError>;
}

pub(super) trait CredentialIdSource: Send + Sync {
    fn next_id(&self) -> Result<CredentialId, CredentialStoreError>;
}

pub(super) struct CredentialStoreEngine<B, I> {
    pub(super) backend: B,
    pub(super) id_source: I,
}

impl<B, I> CredentialStoreEngine<B, I>
where
    B: CredentialRecordBackend,
    I: CredentialIdSource,
{
    pub(super) fn create(
        &self,
        request: CredentialCreateRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        validate_provider_id(&request.provider_id)?;
        validate_owner_scope(&request.owner, request.scope)?;
        validate_expiry(request.expires_at, request.now)?;
        let granted_scopes = normalize_scopes(request.granted_scopes)?;
        let secret = request.secret.into_inner();
        for _ in 0..MAX_CREATE_ATTEMPTS {
            let credential_id = self.id_source.next_id()?;
            let record = StoredCredential {
                credential_id,
                provider_id: request.provider_id.clone(),
                owner: request.owner.clone(),
                scope: request.scope,
                granted_scopes: granted_scopes.clone(),
                secret: secret.clone(),
                expires_at: request.expires_at,
                revision: 1,
                created_at: request.now,
                rotated_at: None,
                revoked_at: None,
            };
            if self.backend.insert(&record)? {
                return Ok(metadata_at(&record, request.now));
            }
        }
        Err(CredentialStoreError::Unavailable(
            "failed to allocate credential id",
        ))
    }

    pub(super) fn inspect(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        let record = self.load_owned(&request.credential_id, &request.owner)?;
        Ok(metadata_at(&record, request.now))
    }

    pub(super) fn read(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialAccess, CredentialStoreError> {
        let record = self.load_owned(&request.credential_id, &request.owner)?;
        match status_at(&record, request.now) {
            CredentialStatus::Available => Ok(CredentialAccess {
                metadata: metadata_at(&record, request.now),
                secret: CredentialSecret::from_inner(record.secret),
            }),
            CredentialStatus::Expired => Err(CredentialStoreError::Expired),
            CredentialStatus::Revoked => Err(CredentialStoreError::Revoked),
        }
    }

    pub(super) fn rotate(
        &self,
        request: CredentialRotateRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        validate_expiry(request.expires_at, request.now)?;
        let mut record = self.load_owned(&request.credential_id, &request.owner)?;
        if matches!(status_at(&record, request.now), CredentialStatus::Revoked) {
            return Err(CredentialStoreError::Revoked);
        }
        record.revision = record
            .revision
            .checked_add(1)
            .ok_or(CredentialStoreError::RevisionExhausted)?;
        record.secret = request.secret.into_inner();
        record.expires_at = request.expires_at;
        record.rotated_at = Some(request.now);
        self.backend.save(&record)?;
        Ok(metadata_at(&record, request.now))
    }

    pub(super) fn revoke(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        let mut record = self.load_owned(&request.credential_id, &request.owner)?;
        if record.revoked_at.is_none() {
            record.revoked_at = Some(request.now);
            self.backend.save(&record)?;
        }
        Ok(metadata_at(&record, request.now))
    }

    fn load_owned(
        &self,
        credential_id: &CredentialId,
        owner: &CredentialOwner,
    ) -> Result<StoredCredential, CredentialStoreError> {
        let record = self
            .backend
            .load(credential_id)?
            .ok_or(CredentialStoreError::NotFound)?;
        validate_stored_record(&record, credential_id)?;
        if &record.owner != owner {
            return Err(CredentialStoreError::NotFound);
        }
        Ok(record)
    }
}

fn metadata_at(record: &StoredCredential, now: i64) -> CredentialMetadata {
    CredentialMetadata {
        credential_id: record.credential_id.clone(),
        provider_id: record.provider_id.clone(),
        owner: record.owner.clone(),
        scope: record.scope,
        granted_scopes: record.granted_scopes.clone(),
        status: status_at(record, now),
        expires_at: record.expires_at,
        revision: record.revision,
        created_at: record.created_at,
        rotated_at: record.rotated_at,
        revoked_at: record.revoked_at,
    }
}

fn status_at(record: &StoredCredential, now: i64) -> CredentialStatus {
    if record.revoked_at.is_some() {
        CredentialStatus::Revoked
    } else if record
        .expires_at
        .is_some_and(|expires_at| expires_at <= now)
    {
        CredentialStatus::Expired
    } else {
        CredentialStatus::Available
    }
}

fn validate_stored_record(
    record: &StoredCredential,
    expected_id: &CredentialId,
) -> Result<(), CredentialStoreError> {
    if &record.credential_id != expected_id
        || record.revision == 0
        || record.granted_scopes.is_empty()
        || record.granted_scopes.len() > MAX_GRANTED_SCOPES
        || record.secret.expose_secret().is_empty()
        || record.secret.expose_secret().len() > MAX_SECRET_BYTES
    {
        return Err(CredentialStoreError::Unavailable(
            "invalid credential record",
        ));
    }
    validate_provider_id(&record.provider_id).map_err(|_| invalid_record())?;
    validate_identifier(record.owner.actor_id(), "invalid credential actor")
        .map_err(|_| invalid_record())?;
    if let Some(tenant_id) = record.owner.tenant_id() {
        validate_identifier(tenant_id, "invalid credential tenant")
            .map_err(|_| invalid_record())?;
    }
    if let Some(space_id) = record.owner.space_id() {
        validate_identifier(space_id, "invalid credential space").map_err(|_| invalid_record())?;
    }
    validate_owner_scope(&record.owner, record.scope).map_err(|_| invalid_record())?;
    for scope in &record.granted_scopes {
        GrantedCredentialScope::new(scope.as_str()).map_err(|_| invalid_record())?;
    }
    Ok(())
}

fn invalid_record() -> CredentialStoreError {
    CredentialStoreError::Unavailable("invalid credential record")
}

fn serialize_secret<S>(secret: &SecretString, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(secret.expose_secret())
}

fn deserialize_secret<'de, D>(deserializer: D) -> Result<SecretString, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer).map(SecretString::from)
}
