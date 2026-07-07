use std::sync::Arc;

use crewon_config::McpServerTransportConfig;
use crewon_core::McpManager;
use crewon_core::config::Config;
use crewon_core::config::ConfigBuilder;
use crewon_core_plugins::PluginsManager;
use crewon_extension_api::ExtensionRegistryBuilder;
use crewon_extension_api::McpServerContribution;
use crewon_extension_api::McpServerContributor;
use crewon_login::CrewonAuth;
use crewon_mcp::CREWON_APPS_MCP_SERVER_NAME;
use pretty_assertions::assert_eq;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn contributes_hosted_plugin_runtime_without_an_executor() -> TestResult {
    let codex_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .fallback_cwd(Some(codex_home.path().to_path_buf()))
        .config_overrides(vec![
            ("features.apps".to_string(), true.into()),
            ("chatgpt_base_url".to_string(), "https://chatgpt.com".into()),
        ])
        .build()
        .await?;
    let auth = CrewonAuth::create_dummy_chatgpt_auth_for_testing();
    let manager = installed_manager(&config);

    let servers = manager.effective_servers(&config, Some(&auth)).await;
    let server = servers
        .get(CREWON_APPS_MCP_SERVER_NAME)
        .and_then(|server| server.configured_config())
        .ok_or("hosted plugin runtime should be contributed as a configured server")?;
    let McpServerTransportConfig::StreamableHttp { url, .. } = &server.transport else {
        panic!("hosted plugin runtime should use streamable HTTP");
    };
    assert_eq!(url, "https://chatgpt.com/backend-api/ps/mcp");

    Ok(())
}

#[tokio::test]
async fn runtime_overlay_preserves_disabled_server() -> TestResult {
    let codex_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .fallback_cwd(Some(codex_home.path().to_path_buf()))
        .config_overrides(vec![
            ("features.apps".to_string(), true.into()),
            (
                "mcp_servers.crewon_apps.url".to_string(),
                "https://example.com/mcp".into(),
            ),
            ("mcp_servers.crewon_apps.enabled".to_string(), false.into()),
        ])
        .build()
        .await?;
    let auth = CrewonAuth::create_dummy_chatgpt_auth_for_testing();
    let manager = installed_manager(&config);

    let servers = manager.effective_servers(&config, Some(&auth)).await;
    let server = servers
        .get(CREWON_APPS_MCP_SERVER_NAME)
        .ok_or("hosted plugin runtime should remain configured")?;

    assert!(!server.enabled());
    Ok(())
}

#[tokio::test]
async fn legacy_fallback_overwrites_reserved_config_without_an_extension() -> TestResult {
    let codex_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .fallback_cwd(Some(codex_home.path().to_path_buf()))
        .config_overrides(vec![
            ("features.apps".to_string(), true.into()),
            (
                "mcp_servers.crewon_apps.url".to_string(),
                "https://example.com/mcp".into(),
            ),
        ])
        .build()
        .await?;
    let auth = CrewonAuth::create_dummy_chatgpt_auth_for_testing();
    let manager = McpManager::new(Arc::new(PluginsManager::new(
        config.codex_home.to_path_buf(),
    )));

    let servers = manager.effective_servers(&config, Some(&auth)).await;
    let server = servers
        .get(CREWON_APPS_MCP_SERVER_NAME)
        .and_then(|server| server.configured_config())
        .ok_or("legacy Apps MCP should be present")?;
    let McpServerTransportConfig::StreamableHttp { url, .. } = &server.transport else {
        panic!("legacy Apps MCP should use streamable HTTP");
    };
    assert_eq!(url, "https://chatgpt.com/backend-api/wham/apps");

    Ok(())
}

#[tokio::test]
async fn extension_can_remove_legacy_fallback_while_apps_are_enabled() -> TestResult {
    let codex_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .fallback_cwd(Some(codex_home.path().to_path_buf()))
        .config_overrides(vec![("features.apps".to_string(), true.into())])
        .build()
        .await?;
    let auth = CrewonAuth::create_dummy_chatgpt_auth_for_testing();
    let mut builder = ExtensionRegistryBuilder::new();
    builder.mcp_server_contributor(Arc::new(RemoveCrewonApps));
    let manager = McpManager::new_with_extensions(
        Arc::new(PluginsManager::new(config.codex_home.to_path_buf())),
        Arc::new(builder.build()),
    );

    let servers = manager.effective_servers(&config, Some(&auth)).await;

    assert!(!servers.contains_key(CREWON_APPS_MCP_SERVER_NAME));
    Ok(())
}

#[tokio::test]
async fn hosted_apps_mcp_requires_chatgpt_auth() -> TestResult {
    let codex_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .fallback_cwd(Some(codex_home.path().to_path_buf()))
        .config_overrides(vec![("features.apps".to_string(), true.into())])
        .build()
        .await?;
    let auth = CrewonAuth::from_api_key("test");
    let manager = installed_manager(&config);

    let servers = manager.effective_servers(&config, Some(&auth)).await;
    assert!(!servers.contains_key(CREWON_APPS_MCP_SERVER_NAME));

    Ok(())
}

#[tokio::test]
async fn disabled_apps_remove_reserved_server_config() -> TestResult {
    let codex_home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .fallback_cwd(Some(codex_home.path().to_path_buf()))
        .config_overrides(vec![
            ("features.apps".to_string(), false.into()),
            (
                "mcp_servers.crewon_apps.url".to_string(),
                "https://example.com/mcp".into(),
            ),
        ])
        .build()
        .await?;
    let manager = installed_manager(&config);

    let servers = manager.runtime_servers(&config).await;

    assert!(!servers.contains_key(CREWON_APPS_MCP_SERVER_NAME));
    Ok(())
}

fn installed_manager(config: &Config) -> McpManager {
    let mut builder = ExtensionRegistryBuilder::new();
    crewon_mcp_extension::install(&mut builder);
    McpManager::new_with_extensions(
        Arc::new(PluginsManager::new(config.codex_home.to_path_buf())),
        Arc::new(builder.build()),
    )
}

struct RemoveCrewonApps;

impl McpServerContributor<Config> for RemoveCrewonApps {
    fn contribute<'a>(
        &'a self,
        _config: &'a Config,
    ) -> crewon_extension_api::ExtensionFuture<'a, Vec<McpServerContribution>> {
        Box::pin(async move {
            vec![McpServerContribution::Remove {
                name: CREWON_APPS_MCP_SERVER_NAME.to_string(),
            }]
        })
    }
}
