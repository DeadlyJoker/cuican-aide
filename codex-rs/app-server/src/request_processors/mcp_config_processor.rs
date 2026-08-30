use super::*;
use crate::config_manager_service::ConfigManagerError;

const MAX_MCP_CONFIGS: usize = 100;

#[derive(Clone)]
pub(crate) struct McpConfigRequestProcessor {
    config_manager: ConfigManager,
    thread_manager: Option<Arc<ThreadManager>>,
}

impl McpConfigRequestProcessor {
    pub(crate) fn new(config_manager: ConfigManager, thread_manager: Arc<ThreadManager>) -> Self {
        Self {
            config_manager,
            thread_manager: Some(thread_manager),
        }
    }

    #[cfg(test)]
    fn new_for_tests(config_manager: ConfigManager) -> Self {
        Self {
            config_manager,
            thread_manager: None,
        }
    }

    pub(crate) async fn list(
        &self,
        params: McpServerConfigListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.list_response(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn read(
        &self,
        params: McpServerConfigReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.read_response(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn save(
        &self,
        params: McpServerConfigSaveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.save_response(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn delete(
        &self,
        params: McpServerConfigDeleteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.delete_response(params)
            .await
            .map(|response| Some(response.into()))
    }

    async fn list_response(
        &self,
        params: McpServerConfigListParams,
    ) -> Result<McpServerConfigListResponse, JSONRPCErrorError> {
        let config = self
            .config_manager
            .read(ConfigReadParams {
                include_layers: false,
                cwd: params.cwd,
            })
            .await
            .map_err(map_config_error)?;
        let mut data = mcp_server_records(&config.config.additional);
        data.sort_by(|left, right| left.name.cmp(&right.name));

        let offset = parse_mcp_cursor(params.cursor)?;
        let limit = normalize_mcp_limit(params.limit);
        let next_cursor = if data.len() > offset + limit {
            Some((offset + limit).to_string())
        } else {
            None
        };
        let data = data.into_iter().skip(offset).take(limit).collect();
        Ok(McpServerConfigListResponse { data, next_cursor })
    }

    async fn read_response(
        &self,
        params: McpServerConfigReadParams,
    ) -> Result<McpServerConfigReadResponse, JSONRPCErrorError> {
        let name = validate_mcp_server_name(&params.name)?;
        let list = self
            .list_response(McpServerConfigListParams {
                cwd: params.cwd,
                cursor: None,
                limit: None,
            })
            .await?;
        let record = list.data.into_iter().find(|record| record.name == name);
        Ok(McpServerConfigReadResponse { record })
    }

    async fn save_response(
        &self,
        params: McpServerConfigSaveParams,
    ) -> Result<McpServerConfigSaveResponse, JSONRPCErrorError> {
        let McpServerConfigSaveParams {
            name,
            config,
            expected_version,
            reload,
        } = params;
        let name = validate_mcp_server_name(&name)?;
        let response = self
            .config_manager
            .batch_write(ConfigBatchWriteParams {
                edits: vec![crewon_app_server_protocol::ConfigEdit {
                    key_path: mcp_server_key_path(name),
                    value: config,
                    merge_strategy: MergeStrategy::Replace,
                }],
                file_path: None,
                expected_version,
                reload_user_config: true,
            })
            .await
            .map_err(map_config_error)?;
        let reload_error = self.reload_if_requested(reload).await;
        Ok(McpServerConfigSaveResponse {
            write: mcp_config_write_result(response),
            reload_error,
        })
    }

    async fn delete_response(
        &self,
        params: McpServerConfigDeleteParams,
    ) -> Result<McpServerConfigDeleteResponse, JSONRPCErrorError> {
        let McpServerConfigDeleteParams {
            name,
            expected_version,
            reload,
        } = params;
        let name = validate_mcp_server_name(&name)?;
        let response = self
            .config_manager
            .batch_write(ConfigBatchWriteParams {
                edits: vec![crewon_app_server_protocol::ConfigEdit {
                    key_path: mcp_server_key_path(name),
                    value: serde_json::Value::Null,
                    merge_strategy: MergeStrategy::Replace,
                }],
                file_path: None,
                expected_version,
                reload_user_config: true,
            })
            .await
            .map_err(map_config_error)?;
        let reload_error = self.reload_if_requested(reload).await;
        Ok(McpServerConfigDeleteResponse {
            write: mcp_config_write_result(response),
            reload_error,
        })
    }

    async fn reload_if_requested(&self, reload: bool) -> Option<String> {
        if !reload {
            return None;
        }
        let Some(thread_manager) = self.thread_manager.as_ref() else {
            return Some("MCP refresh is unavailable".to_string());
        };
        crate::mcp_refresh::queue_strict_refresh(thread_manager, &self.config_manager)
            .await
            .err()
            .map(|err| err.to_string())
    }
}

fn mcp_server_records(
    additional: &std::collections::HashMap<String, serde_json::Value>,
) -> Vec<McpServerConfigRecord> {
    additional
        .get("mcp_servers")
        .and_then(serde_json::Value::as_object)
        .map(|servers| {
            servers
                .iter()
                .map(|(name, config)| McpServerConfigRecord {
                    name: name.clone(),
                    config: config.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn validate_mcp_server_name(name: &str) -> Result<&str, JSONRPCErrorError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid_params("name must not be empty"));
    }
    if name.len() > 128 {
        return Err(invalid_params("name must be 128 characters or fewer"));
    }
    if name
        .chars()
        .any(|ch| ch == '.' || ch == '"' || ch == '\\' || ch == '\n' || ch == '\r')
    {
        return Err(invalid_params(
            "name must not contain dots, quotes, backslashes, or newlines",
        ));
    }
    Ok(name)
}

fn mcp_server_key_path(name: &str) -> String {
    format!("mcp_servers.{name}")
}

fn mcp_config_write_result(response: ConfigWriteResponse) -> McpServerConfigWriteResult {
    let status = serde_json::to_value(response.status)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "ok".to_string());
    McpServerConfigWriteResult {
        status,
        version: response.version,
        file_path: response.file_path.as_path().display().to_string(),
    }
}

fn normalize_mcp_limit(limit: Option<u32>) -> usize {
    limit
        .and_then(|limit| usize::try_from(limit).ok())
        .filter(|limit| *limit > 0)
        .map(|limit| limit.min(MAX_MCP_CONFIGS))
        .unwrap_or(MAX_MCP_CONFIGS)
}

fn parse_mcp_cursor(cursor: Option<String>) -> Result<usize, JSONRPCErrorError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    cursor
        .parse::<usize>()
        .map_err(|err| invalid_params(format!("invalid cursor: {err}")))
}

fn map_config_error(err: ConfigManagerError) -> JSONRPCErrorError {
    if let Some(code) = err.write_error_code() {
        let mut error = invalid_request(err.to_string());
        error.data = Some(serde_json::json!({
            "config_write_error_code": code,
        }));
        return error;
    }

    internal_error(err.to_string())
}

#[cfg(test)]
#[path = "mcp_config_processor_tests.rs"]
mod tests;
