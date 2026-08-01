use std::sync::Mutex;

use rand::TryRngCore;
use rand::rngs::OsRng;

use super::CREDENTIAL_ID_HEX_BYTES;
use super::CredentialAccess;
use super::CredentialAccessRequest;
use super::CredentialCreateRequest;
use super::CredentialId;
use super::CredentialMetadata;
use super::CredentialRotateRequest;
use super::CredentialStore;
use super::CredentialStoreError;
use super::engine::CredentialIdSource;
use super::engine::CredentialRecordBackend;
use super::engine::CredentialStoreEngine;
use super::engine::StoredCredential;
use crate::SecretName;
use crate::SecretScope;
use crate::SecretsManager;

struct RandomCredentialIdSource;

impl CredentialIdSource for RandomCredentialIdSource {
    fn next_id(&self) -> Result<CredentialId, CredentialStoreError> {
        let mut bytes = [0_u8; CREDENTIAL_ID_HEX_BYTES];
        let mut rng = OsRng;
        rng.try_fill_bytes(&mut bytes)
            .map_err(|_| CredentialStoreError::Unavailable("credential id generation failed"))?;
        let mut id = String::with_capacity(5 + bytes.len() * 2);
        id.push_str("cred_");
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for byte in bytes {
            id.push(HEX[usize::from(byte >> 4)] as char);
            id.push(HEX[usize::from(byte & 0x0f)] as char);
        }
        CredentialId::parse(&id)
    }
}

struct LocalCredentialRecordBackend {
    manager: SecretsManager,
    operation_lock: Mutex<()>,
}

impl CredentialRecordBackend for LocalCredentialRecordBackend {
    fn insert(&self, record: &StoredCredential) -> Result<bool, CredentialStoreError> {
        let _guard = self.operation_lock.lock().map_err(lock_error)?;
        let name = credential_secret_name(&record.credential_id)?;
        if self
            .manager
            .get(&SecretScope::Global, &name)
            .map_err(storage_error)?
            .is_some()
        {
            return Ok(false);
        }
        self.save_locked(record, &name)?;
        Ok(true)
    }

    fn load(
        &self,
        credential_id: &CredentialId,
    ) -> Result<Option<StoredCredential>, CredentialStoreError> {
        let _guard = self.operation_lock.lock().map_err(lock_error)?;
        let name = credential_secret_name(credential_id)?;
        let Some(serialized) = self
            .manager
            .get(&SecretScope::Global, &name)
            .map_err(storage_error)?
        else {
            return Ok(None);
        };
        serde_json::from_str(&serialized)
            .map(Some)
            .map_err(|_| CredentialStoreError::Unavailable("invalid credential record"))
    }

    fn save(&self, record: &StoredCredential) -> Result<(), CredentialStoreError> {
        let _guard = self.operation_lock.lock().map_err(lock_error)?;
        let name = credential_secret_name(&record.credential_id)?;
        self.save_locked(record, &name)
    }
}

impl LocalCredentialRecordBackend {
    fn save_locked(
        &self,
        record: &StoredCredential,
        name: &SecretName,
    ) -> Result<(), CredentialStoreError> {
        let serialized = serde_json::to_string(record)
            .map_err(|_| CredentialStoreError::Unavailable("credential encode failed"))?;
        self.manager
            .set(&SecretScope::Global, name, &serialized)
            .map_err(storage_error)
    }
}

/// Desktop Credential adapter backed by the existing encrypted local Secret store and OS keyring.
pub struct LocalCredentialStore {
    engine: CredentialStoreEngine<LocalCredentialRecordBackend, RandomCredentialIdSource>,
}

impl LocalCredentialStore {
    pub fn new(manager: SecretsManager) -> Self {
        Self {
            engine: CredentialStoreEngine {
                backend: LocalCredentialRecordBackend {
                    manager,
                    operation_lock: Mutex::new(()),
                },
                id_source: RandomCredentialIdSource,
            },
        }
    }
}

impl CredentialStore for LocalCredentialStore {
    fn create(
        &self,
        request: CredentialCreateRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        self.engine.create(request)
    }

    fn inspect(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        self.engine.inspect(request)
    }

    fn read(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialAccess, CredentialStoreError> {
        self.engine.read(request)
    }

    fn rotate(
        &self,
        request: CredentialRotateRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        self.engine.rotate(request)
    }

    fn revoke(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        self.engine.revoke(request)
    }
}

fn credential_secret_name(
    credential_id: &CredentialId,
) -> Result<SecretName, CredentialStoreError> {
    SecretName::new(&credential_id.as_str().to_ascii_uppercase())
        .map_err(|_| CredentialStoreError::Unavailable("invalid credential record key"))
}

fn storage_error(_: anyhow::Error) -> CredentialStoreError {
    CredentialStoreError::Unavailable("local secrets backend failed")
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> CredentialStoreError {
    CredentialStoreError::Unavailable("credential store lock poisoned")
}
