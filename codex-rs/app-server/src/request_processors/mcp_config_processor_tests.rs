use super::*;
use crate::error_code::INVALID_PARAMS_ERROR_CODE;
use crewon_config::CONFIG_TOML_FILE;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

fn processor(temp_dir: &TempDir) -> McpConfigRequestProcessor {
    McpConfigRequestProcessor::new_for_tests(ConfigManager::without_managed_config_for_tests(
        temp_dir.path().to_path_buf(),
    ))
}

#[tokio::test]
async fn save_list_read_and_delete_mcp_server_config() {
    let temp_dir = TempDir::new().expect("tempdir");
    let processor = processor(&temp_dir);
    let docs_config = json!({
        "command": "docs-mcp",
        "args": ["--stdio"],
        "env": {
            "DOCS_TOKEN": "token"
        },
        "enabled": false
    });
    let effective_docs_config = json!({
        "command": "docs-mcp",
        "args": ["--stdio"],
        "env": {
            "DOCS_TOKEN": "token"
        },
        "enabled": false,
        "environment_id": "local",
        "tool_timeout_sec": null
    });

    let save_response = processor
        .save_response(McpServerConfigSaveParams {
            name: "docs".to_string(),
            config: docs_config.clone(),
            expected_version: None,
            reload: false,
        })
        .await
        .expect("save mcp config");
    assert_eq!(save_response.reload_error, None);

    let list_response = processor
        .list_response(McpServerConfigListParams {
            cwd: None,
            cursor: None,
            limit: None,
        })
        .await
        .expect("list mcp configs");
    assert_eq!(
        list_response,
        McpServerConfigListResponse {
            data: vec![McpServerConfigRecord {
                name: "docs".to_string(),
                config: effective_docs_config.clone(),
            }],
            next_cursor: None,
        }
    );

    let read_response = processor
        .read_response(McpServerConfigReadParams {
            cwd: None,
            name: "docs".to_string(),
        })
        .await
        .expect("read mcp config");
    assert_eq!(
        read_response,
        McpServerConfigReadResponse {
            record: Some(McpServerConfigRecord {
                name: "docs".to_string(),
                config: effective_docs_config,
            }),
        }
    );

    let delete_response = processor
        .delete_response(McpServerConfigDeleteParams {
            name: "docs".to_string(),
            expected_version: None,
            reload: false,
        })
        .await
        .expect("delete mcp config");
    assert_eq!(delete_response.reload_error, None);

    let list_response = processor
        .list_response(McpServerConfigListParams {
            cwd: None,
            cursor: None,
            limit: None,
        })
        .await
        .expect("list mcp configs after delete");
    assert_eq!(
        list_response,
        McpServerConfigListResponse {
            data: Vec::new(),
            next_cursor: None,
        }
    );

    let config_contents =
        std::fs::read_to_string(temp_dir.path().join(CONFIG_TOML_FILE)).expect("read config.toml");
    assert!(!config_contents.contains("[mcp_servers.docs]"));
}

#[tokio::test]
async fn reject_mcp_server_names_that_would_split_config_key_paths() {
    let temp_dir = TempDir::new().expect("tempdir");
    let processor = processor(&temp_dir);

    let error = processor
        .save_response(McpServerConfigSaveParams {
            name: "bad.name".to_string(),
            config: json!({
                "command": "docs-mcp",
            }),
            expected_version: None,
            reload: false,
        })
        .await
        .expect_err("server names with dots are rejected");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
}
