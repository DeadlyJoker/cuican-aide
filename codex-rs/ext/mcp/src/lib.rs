use crewon_core::config::Config;
use crewon_extension_api::ExtensionFuture;
use crewon_extension_api::ExtensionRegistryBuilder;
use crewon_extension_api::McpServerContribution;
use crewon_extension_api::McpServerContributor;
use crewon_mcp::CREWON_APPS_MCP_SERVER_NAME;
use crewon_mcp::hosted_plugin_runtime_mcp_server_config;

struct HostedPluginRuntimeExtension;

impl McpServerContributor<Config> for HostedPluginRuntimeExtension {
    fn contribute<'a>(
        &'a self,
        config: &'a Config,
    ) -> ExtensionFuture<'a, Vec<McpServerContribution>> {
        Box::pin(async move {
            let name = CREWON_APPS_MCP_SERVER_NAME.to_string();
            if !config.features.enabled(crewon_features::Feature::Apps) {
                return vec![McpServerContribution::Remove { name }];
            }

            vec![McpServerContribution::Set {
                name,
                config: Box::new(hosted_plugin_runtime_mcp_server_config(
                    &config.chatgpt_base_url,
                    config.apps_mcp_product_sku.as_deref(),
                )),
            }]
        })
    }
}

pub fn install(builder: &mut ExtensionRegistryBuilder<Config>) {
    builder.mcp_server_contributor(std::sync::Arc::new(HostedPluginRuntimeExtension));
}
