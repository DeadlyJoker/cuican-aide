fn validated_binding(
    request: &ProviderCredentialUpsertRequest,
) -> Result<ProviderBinding, ProviderCredentialError> {
    validate_provider_id(&request.provider_id)?;
    let endpoint = validate_endpoint(&request.endpoint)?;
    let environment_variable = match request.credential_kind {
        ProviderCredentialKind::Environment => Some(validate_environment_variable(
            request
                .environment_variable
                .as_deref()
                .ok_or(ProviderCredentialError::InvalidRequest)?,
        )?),
        ProviderCredentialKind::Keychain | ProviderCredentialKind::None => {
            if request.environment_variable.is_some() {
                return Err(ProviderCredentialError::InvalidRequest);
            }
            None
        }
    };
    match request.credential_kind {
        ProviderCredentialKind::Keychain => {
            if let Some(secret) = request.secret.as_deref() {
                validate_secret(secret)?;
            }
        }
        ProviderCredentialKind::Environment | ProviderCredentialKind::None => {
            if request.secret.is_some() {
                return Err(ProviderCredentialError::InvalidRequest);
            }
        }
    }
    Ok(ProviderBinding {
        credential_kind: request.credential_kind,
        endpoint,
        environment_variable,
        provider_id: request.provider_id.clone(),
    })
}

fn validate_catalog(
    catalog: &ProviderCredentialCatalogFile,
) -> Result<(), ProviderCredentialError> {
    if catalog.schema_version != CATALOG_SCHEMA_VERSION {
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    for (provider_id, binding) in &catalog.bindings {
        if provider_id != &binding.provider_id {
            return Err(ProviderCredentialError::CatalogInvalid);
        }
        validate_provider_id(provider_id).map_err(|_| ProviderCredentialError::CatalogInvalid)?;
        validate_endpoint(&binding.endpoint)
            .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
        match binding.credential_kind {
            ProviderCredentialKind::Environment => {
                validate_environment_variable(
                    binding
                        .environment_variable
                        .as_deref()
                        .ok_or(ProviderCredentialError::CatalogInvalid)?,
                )
                .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
            }
            ProviderCredentialKind::Keychain | ProviderCredentialKind::None => {
                if binding.environment_variable.is_some() {
                    return Err(ProviderCredentialError::CatalogInvalid);
                }
            }
        }
    }
    if catalog
        .active_provider_id
        .as_ref()
        .is_some_and(|provider_id| !catalog.bindings.contains_key(provider_id))
    {
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    if catalog.active_provider_id.is_some() != catalog.active_runtime_binding_id.is_some()
        || catalog
            .active_runtime_binding_id
            .as_deref()
            .is_some_and(|binding_id| validate_runtime_binding_id(binding_id).is_err())
    {
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    Ok(())
}

fn validate_runtime_binding_id(binding_id: &str) -> Result<(), ProviderCredentialError> {
    if binding_id.is_empty()
        || binding_id.len() > 128
        || !binding_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    Ok(())
}

fn new_runtime_binding_id() -> Result<String, ProviderCredentialError> {
    let random = getrandom::u64().map_err(|_| ProviderCredentialError::StateUnavailable)?;
    Ok(format!("desktop-supervisor:{random:016x}"))
}

fn validate_provider_id(provider_id: &str) -> Result<(), ProviderCredentialError> {
    if provider_id.is_empty()
        || provider_id.len() > MAX_PROVIDER_ID_BYTES
        || !provider_id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'-' | b'_'))
        })
    {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    Ok(())
}

fn validate_endpoint(endpoint: &str) -> Result<String, ProviderCredentialError> {
    if endpoint.is_empty() || endpoint.len() > MAX_ENDPOINT_BYTES {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    let parsed = url::Url::parse(endpoint).map_err(|_| ProviderCredentialError::InvalidRequest)?;
    let is_loopback = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if !matches!(parsed.scheme(), "http" | "https")
        || (parsed.scheme() == "http" && !is_loopback)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    Ok(endpoint.to_string())
}

fn validate_environment_variable(variable: &str) -> Result<String, ProviderCredentialError> {
    if variable.is_empty()
        || variable.len() > 128
        || !variable.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic() || byte == b'_' || (index > 0 && byte.is_ascii_digit())
        })
    {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    Ok(variable.to_string())
}

fn validate_secret(secret: &str) -> Result<(), ProviderCredentialError> {
    if secret.is_empty()
        || secret.len() > MAX_SECRET_BYTES
        || secret.trim() != secret
        || secret.chars().any(char::is_control)
    {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    Ok(())
}

#[cfg(test)]
#[path = "provider_credentials_tests.rs"]
mod tests;
