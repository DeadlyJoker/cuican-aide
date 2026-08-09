use std::collections::BTreeMap;
use std::fs;
use std::sync::Arc;
use std::sync::Mutex;

use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::tempdir;
use zeroize::Zeroizing;

use super::credential_mutation_result_with_shutdown;
use super::OsProviderSecretStore;
use super::ProviderCredentialKind;
use super::ProviderCredentialManager;
use super::ProviderCredentialMutationError;
use super::ProviderCredentialTargetRequest;
use super::ProviderCredentialUpsertRequest;
use super::ProviderSecretStore;
use super::SecretStoreError;

#[derive(Default)]
struct MemorySecretStore {
    secrets: Mutex<BTreeMap<String, String>>,
}

impl ProviderSecretStore for MemorySecretStore {
    fn delete(&self, provider_id: &str) -> Result<(), SecretStoreError> {
        self.secrets
            .lock()
            .expect("secret store")
            .remove(provider_id);
        Ok(())
    }

    fn get(&self, provider_id: &str) -> Result<Zeroizing<String>, SecretStoreError> {
        self.secrets
            .lock()
            .expect("secret store")
            .get(provider_id)
            .cloned()
            .map(Zeroizing::new)
            .ok_or(SecretStoreError::Missing)
    }

    fn set(&self, provider_id: &str, secret: &str) -> Result<(), SecretStoreError> {
        self.secrets
            .lock()
            .expect("secret store")
            .insert(provider_id.to_string(), secret.to_string());
        Ok(())
    }
}

fn keychain_request(secret: Option<&str>, activate: bool) -> ProviderCredentialUpsertRequest {
    ProviderCredentialUpsertRequest {
        activate,
        credential_kind: ProviderCredentialKind::Keychain,
        endpoint: "https://api.example.com/v1".to_string(),
        environment_variable: None,
        provider_id: "gateway-primary".to_string(),
        secret: secret.map(str::to_string),
    }
}

#[test]
fn persists_only_binding_metadata_and_resolves_active_secret_from_store() {
    let directory = tempdir().expect("temporary directory");
    let catalog_path = directory.path().join("provider-credentials.v1.json");
    let secrets = Arc::new(MemorySecretStore::default());
    let manager = ProviderCredentialManager::open(catalog_path.clone(), secrets.clone())
        .expect("credential manager");

    let view = manager
        .upsert(&keychain_request(Some("provider-secret-value"), true))
        .expect("store binding");
    assert_eq!(
        serde_json::to_value(view).expect("catalog view"),
        json!({
            "activeProviderId": "gateway-primary",
            "bindings": [{
                "credentialAvailable": true,
                "credentialKind": "keychain",
                "endpoint": "https://api.example.com/v1",
                "environmentVariable": null,
                "isActive": true,
                "providerId": "gateway-primary",
            }],
        }),
    );

    let persisted = fs::read_to_string(&catalog_path).expect("catalog metadata");
    assert!(!persisted.contains("provider-secret-value"));
    assert!(!persisted.contains("secret"));

    let reopened =
        ProviderCredentialManager::open(catalog_path, secrets).expect("reopen credential manager");
    let runtime = reopened
        .active_runtime()
        .expect("active runtime")
        .expect("active provider");
    assert_eq!(runtime.binding.provider_id, "gateway-primary");
    assert_eq!(runtime.binding.endpoint, "https://api.example.com/v1");
    assert_eq!(
        runtime.secret.as_ref().map(|secret| secret.as_str()),
        Some("provider-secret-value"),
    );
}

#[test]
fn blank_update_keeps_existing_keychain_secret_and_delete_clears_both_authorities() {
    let directory = tempdir().expect("temporary directory");
    let catalog_path = directory.path().join("provider-credentials.v1.json");
    let secrets = Arc::new(MemorySecretStore::default());
    let manager =
        ProviderCredentialManager::open(catalog_path, secrets.clone()).expect("credential manager");
    manager
        .upsert(&keychain_request(Some("existing-secret"), true))
        .expect("initial binding");

    manager
        .upsert(&keychain_request(None, false))
        .expect("metadata-only update");
    assert_eq!(
        secrets
            .get("gateway-primary")
            .expect("retained secret")
            .as_str(),
        "existing-secret",
    );

    let view = manager
        .delete(&ProviderCredentialTargetRequest {
            provider_id: "gateway-primary".to_string(),
        })
        .expect("delete binding");
    assert_eq!(
        serde_json::to_value(view).expect("catalog view"),
        json!({ "activeProviderId": null, "bindings": [] }),
    );
    assert_eq!(
        secrets.get("gateway-primary"),
        Err(SecretStoreError::Missing),
    );
}

#[test]
fn rejects_cross_shape_secret_and_environment_inputs() {
    let directory = tempdir().expect("temporary directory");
    let manager = ProviderCredentialManager::open(
        directory.path().join("provider-credentials.v1.json"),
        Arc::new(MemorySecretStore::default()),
    )
    .expect("credential manager");

    let mut environment_with_secret = keychain_request(Some("secret"), false);
    environment_with_secret.credential_kind = ProviderCredentialKind::Environment;
    environment_with_secret.environment_variable = Some("PROVIDER_API_KEY".to_string());
    assert_eq!(
        manager
            .upsert(&environment_with_secret)
            .expect_err("secret must not be stored for env binding")
            .code(),
        "provider_credential_request_invalid",
    );

    let mut keychain_with_env = keychain_request(Some("secret"), false);
    keychain_with_env.environment_variable = Some("PROVIDER_API_KEY".to_string());
    assert_eq!(
        manager
            .upsert(&keychain_with_env)
            .expect_err("keychain binding must not carry env metadata")
            .code(),
        "provider_credential_request_invalid",
    );

    let mut cleartext_remote = keychain_request(Some("secret"), false);
    cleartext_remote.endpoint = "http://api.example.com/v1".to_string();
    assert_eq!(
        manager
            .upsert(&cleartext_remote)
            .expect_err("remote bearer endpoint must require TLS")
            .code(),
        "provider_credential_request_invalid",
    );

    let mut loopback = keychain_request(Some("secret"), false);
    loopback.endpoint = "http://[::1]:11434/v1".to_string();
    loopback.provider_id = "loopback".to_string();
    loopback.credential_kind = ProviderCredentialKind::None;
    loopback.secret = None;
    manager.upsert(&loopback).expect("loopback http binding");
}

#[test]
fn catalog_write_failure_deletes_the_new_keychain_orphan() {
    let directory = tempdir().expect("temporary directory");
    let secrets = Arc::new(MemorySecretStore::default());
    let manager = ProviderCredentialManager::open(
        directory
            .path()
            .join("missing-parent/provider-credentials.v1.json"),
        secrets.clone(),
    )
    .expect("credential manager");

    assert_eq!(
        manager
            .upsert(&keychain_request(Some("orphan-secret"), false))
            .expect_err("catalog write must fail")
            .code(),
        "provider_credential_catalog_invalid",
    );
    assert_eq!(
        secrets.get("gateway-primary"),
        Err(SecretStoreError::Missing),
    );
}

#[test]
fn failed_runtime_reload_restores_old_catalog_and_keychain_secret() {
    let directory = tempdir().expect("temporary directory");
    let catalog_path = directory.path().join("provider-credentials.v1.json");
    let secrets = Arc::new(MemorySecretStore::default());
    let manager = ProviderCredentialManager::open(catalog_path.clone(), secrets.clone())
        .expect("credential manager");
    manager
        .upsert(&keychain_request(Some("old-secret"), true))
        .expect("initial binding");
    let mut replacement = keychain_request(Some("new-secret"), false);
    replacement.endpoint = "https://replacement.example.com/v1".to_string();

    let error = manager
        .upsert_with_reload(&replacement, |previous, candidate| {
            assert_eq!(
                previous
                    .and_then(|runtime| { runtime.secret.as_ref().map(|secret| secret.as_str()) }),
                Some("old-secret"),
            );
            assert_eq!(
                candidate
                    .and_then(|runtime| { runtime.secret.as_ref().map(|secret| secret.as_str()) }),
                Some("new-secret"),
            );
            Err("control_runtime_active_run")
        })
        .expect_err("reload must reject active run");
    assert_eq!(
        error,
        ProviderCredentialMutationError::Runtime("control_runtime_active_run"),
    );
    assert_eq!(
        secrets
            .get("gateway-primary")
            .expect("restored secret")
            .as_str(),
        "old-secret",
    );
    let reopened =
        ProviderCredentialManager::open(catalog_path, secrets).expect("reopen credential manager");
    assert_eq!(
        reopened
            .active_binding()
            .expect("active binding")
            .expect("provider")
            .endpoint,
        "https://api.example.com/v1",
    );
}

#[test]
fn failed_activation_keeps_the_previous_active_provider() {
    let directory = tempdir().expect("temporary directory");
    let catalog_path = directory.path().join("provider-credentials.v1.json");
    let secrets = Arc::new(MemorySecretStore::default());
    let manager = ProviderCredentialManager::open(catalog_path.clone(), secrets.clone())
        .expect("credential manager");
    manager
        .upsert(&keychain_request(Some("primary-secret"), true))
        .expect("primary binding");
    let mut secondary = keychain_request(Some("secondary-secret"), false);
    secondary.provider_id = "gateway-secondary".to_string();
    secondary.endpoint = "https://secondary.example.com/v1".to_string();
    manager.upsert(&secondary).expect("secondary binding");

    let error = manager
        .activate_with_reload(
            &ProviderCredentialTargetRequest {
                provider_id: "gateway-secondary".to_string(),
            },
            |previous, candidate| {
                assert_eq!(
                    previous.map(|runtime| runtime.binding.provider_id.as_str()),
                    Some("gateway-primary"),
                );
                assert_eq!(
                    candidate.map(|runtime| runtime.binding.provider_id.as_str()),
                    Some("gateway-secondary"),
                );
                Err("control_runtime_worker_not_ready")
            },
        )
        .expect_err("candidate Worker must fail");
    assert_eq!(
        error,
        ProviderCredentialMutationError::Runtime("control_runtime_worker_not_ready"),
    );

    let reopened =
        ProviderCredentialManager::open(catalog_path, secrets).expect("reopen credential manager");
    assert_eq!(
        reopened
            .active_binding()
            .expect("active binding")
            .expect("provider")
            .provider_id,
        "gateway-primary",
    );
}

#[test]
fn rollback_failure_invokes_the_fail_closed_supervisor_boundary() {
    let directory = tempdir().expect("temporary directory");
    let catalog_path = directory.path().join("provider-credentials.v1.json");
    let manager = ProviderCredentialManager::open(
        catalog_path.clone(),
        Arc::new(MemorySecretStore::default()),
    )
    .expect("credential manager");
    manager
        .upsert(&keychain_request(Some("old-secret"), true))
        .expect("initial binding");

    let mutation =
        manager.upsert_with_reload(&keychain_request(Some("new-secret"), false), |_, _| {
            fs::remove_file(&catalog_path).expect("remove catalog");
            fs::remove_dir(directory.path()).expect("remove catalog directory");
            Err("control_runtime_worker_not_ready")
        });
    let shutdown_called = std::cell::Cell::new(false);
    assert_eq!(
        credential_mutation_result_with_shutdown(mutation, || shutdown_called.set(true))
            .expect_err("rollback failure must fail closed"),
        "provider_credential_rollback_failed",
    );
    assert!(shutdown_called.get());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_keychain_round_trip_is_real_and_test_entry_is_removed() {
    let store = OsProviderSecretStore {
        service: "ai.crewon.desktop.model-provider.tests",
    };
    let provider_id = format!(
        "test-{}",
        hex::encode(getrandom::u64().expect("random provider id").to_be_bytes())
    );
    let secret = Zeroizing::new(format!(
        "secret-{}",
        hex::encode(getrandom::u64().expect("random secret").to_be_bytes())
    ));

    store
        .set(&provider_id, secret.as_str())
        .expect("set keychain");
    let actual = store.get(&provider_id).expect("read keychain");
    assert_eq!(actual.as_str(), secret.as_str());
    store.delete(&provider_id).expect("delete keychain");
    assert_eq!(store.get(&provider_id), Err(SecretStoreError::Missing));
}
