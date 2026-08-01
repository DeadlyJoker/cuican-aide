use std::collections::HashMap;
use std::collections::HashSet;

use chrono::DateTime;
use chrono::Utc;
use crewon_install_context::InstallContext;
use crewon_protocol::ThreadId;
use crewon_rollout::RolloutConfig;
use crewon_rollout::find_thread_names_by_ids;
use crewon_rollout::first_rollout_content_match_snippet;
use crewon_rollout::parse_cursor;
use crewon_rollout::search_rollout_matches;

use super::LocalThreadStore;
use super::helpers::distinct_thread_metadata_title;
use super::helpers::set_thread_name_from_title;
use super::helpers::stored_thread_from_rollout_item;
use super::list_threads::list_rollout_threads;
use crate::ListThreadsParams;
use crate::SearchThreadsParams;
use crate::SortDirection;
use crate::StoredThreadSearchResult;
use crate::ThreadSearchPage;
use crate::ThreadSortKey;
use crate::ThreadStoreError;
use crate::ThreadStoreResult;

struct ThreadSearchItem {
    item: crewon_rollout::ThreadItem,
    snippet: String,
}

pub(super) async fn search_threads(
    store: &LocalThreadStore,
    params: SearchThreadsParams,
) -> ThreadStoreResult<ThreadSearchPage> {
    let search_term = params.search_term.as_str();
    if search_term.is_empty() {
        return Err(ThreadStoreError::InvalidRequest {
            message: "thread/search requires search_term".to_string(),
        });
    }
    let cursor = params
        .cursor
        .as_deref()
        .map(|cursor| {
            parse_cursor(cursor).ok_or_else(|| ThreadStoreError::InvalidRequest {
                message: format!("invalid cursor: {cursor}"),
            })
        })
        .transpose()?;
    let sort_key = match params.sort_key {
        ThreadSortKey::CreatedAt => crewon_rollout::ThreadSortKey::CreatedAt,
        ThreadSortKey::UpdatedAt => crewon_rollout::ThreadSortKey::UpdatedAt,
    };
    let sort_direction = match params.sort_direction {
        SortDirection::Asc => crewon_rollout::SortDirection::Asc,
        SortDirection::Desc => crewon_rollout::SortDirection::Desc,
    };
    store.cloud_agent_thread_index_active().await?;
    let state_db = store.state_db().await;
    let rollout_config = RolloutConfig {
        codex_home: store.config.codex_home.clone(),
        sqlite_home: store.config.sqlite_home.clone(),
        cwd: store.config.codex_home.clone(),
        model_provider_id: store.config.default_model_provider_id.clone(),
        generate_memories: false,
    };
    let rg_command = InstallContext::current().rg_command();
    let matching_rollouts = search_rollout_matches(
        rg_command.as_path(),
        store.config.codex_home.as_path(),
        params.archived,
        search_term,
    )
    .await
    .map_err(|err| ThreadStoreError::Internal {
        message: format!("failed to search rollout contents: {err}"),
    })?;
    if matching_rollouts.is_empty() && state_db.is_none() {
        return Ok(ThreadSearchPage {
            items: Vec::new(),
            next_cursor: None,
        });
    }
    let metadata_page = if state_db.is_some() {
        let metadata_params = ListThreadsParams {
            page_size: params.page_size.saturating_add(1),
            cursor: params.cursor.clone(),
            sort_key: params.sort_key,
            sort_direction: params.sort_direction,
            allowed_sources: params.allowed_sources.clone(),
            model_providers: None,
            cwd_filters: None,
            archived: params.archived,
            search_term: Some(search_term.to_string()),
            use_state_db_only: true,
        };
        Some(
            list_rollout_threads(
                state_db.clone(),
                &rollout_config,
                store.config.default_model_provider_id.as_str(),
                &metadata_params,
                cursor.as_ref(),
                sort_key,
                sort_direction,
            )
            .await?,
        )
    } else {
        None
    };
    let metadata_more_available = metadata_page
        .as_ref()
        .is_some_and(|page| page.next_cursor.is_some());
    let metadata_items = metadata_page
        .into_iter()
        .flat_map(|page| page.items)
        .map(|item| ThreadSearchItem {
            snippet: item
                .preview
                .clone()
                .unwrap_or_else(|| search_term.to_string()),
            item,
        })
        .collect::<Vec<_>>();
    let mut content_items = Vec::new();
    let mut page_cursor = cursor;
    let scan_page_size = params.page_size.saturating_mul(8).clamp(256, 2048);
    let scan_params = ListThreadsParams {
        page_size: scan_page_size,
        cursor: None,
        sort_key: params.sort_key,
        sort_direction: params.sort_direction,
        allowed_sources: params.allowed_sources.clone(),
        model_providers: None,
        cwd_filters: None,
        archived: params.archived,
        search_term: None,
        use_state_db_only: false,
    };
    let mut remaining_rollouts = matching_rollouts;

    loop {
        let page = list_rollout_threads(
            state_db.clone(),
            &rollout_config,
            store.config.default_model_provider_id.as_str(),
            &scan_params,
            page_cursor.as_ref(),
            sort_key,
            sort_direction,
        )
        .await?;
        for item in page.items {
            let logical_path = crewon_rollout::plain_rollout_path(item.path.as_path());
            let rollout_snippet = match remaining_rollouts.remove(logical_path.as_path()) {
                Some(Some(snippet)) => Some(snippet),
                Some(None) => first_rollout_content_match_snippet(item.path.as_path(), search_term)
                    .await
                    .map_err(|err| ThreadStoreError::Internal {
                        message: format!("failed to read rollout search match: {err}"),
                    })?,
                None => None,
            };
            let metadata_snippet = item
                .preview
                .as_deref()
                .filter(|preview| preview.contains(search_term))
                .map(ToString::to_string);
            let Some(snippet) = rollout_snippet.or(metadata_snippet) else {
                continue;
            };
            content_items.push(ThreadSearchItem { item, snippet });
            if content_items.len() > params.page_size {
                break;
            }
        }
        page_cursor = page.next_cursor;
        if content_items.len() > params.page_size
            || remaining_rollouts.is_empty()
            || page_cursor.is_none()
        {
            break;
        }
    }

    let content_more_available = content_items.len() > params.page_size;
    let mut deduplicated = HashMap::new();
    for item in metadata_items {
        deduplicated.insert(thread_search_item_key(&item), item);
    }
    for item in content_items {
        deduplicated
            .entry(thread_search_item_key(&item))
            .and_modify(|existing| existing.snippet.clone_from(&item.snippet))
            .or_insert(item);
    }
    let mut matching_items = deduplicated.into_values().collect::<Vec<_>>();
    matching_items.sort_by(|left, right| {
        compare_thread_search_items(left, right, params.sort_key, params.sort_direction)
    });
    let more_matches_available = matching_items.len() > params.page_size
        || content_more_available
        || metadata_more_available;
    matching_items.truncate(params.page_size);
    let next_cursor = if more_matches_available {
        matching_items
            .last()
            .and_then(|item| cursor_from_thread_search_item(item, params.sort_key))
    } else {
        None
    }
    .as_ref()
    .and_then(|cursor| serde_json::to_value(cursor).ok())
    .and_then(|value| value.as_str().map(str::to_owned));

    let mut items = matching_items
        .into_iter()
        .filter_map(|item| {
            stored_thread_from_rollout_item(
                item.item,
                params.archived,
                store.config.default_model_provider_id.as_str(),
            )
            .map(|thread| StoredThreadSearchResult {
                thread,
                snippet: item.snippet,
            })
        })
        .collect::<Vec<_>>();
    set_thread_search_result_names(store, &mut items).await;

    Ok(ThreadSearchPage { items, next_cursor })
}

#[cfg(test)]
#[path = "search_threads_tests.rs"]
mod tests;

fn cursor_from_thread_search_item(
    item: &ThreadSearchItem,
    sort_key: ThreadSortKey,
) -> Option<crewon_rollout::Cursor> {
    let timestamp = match sort_key {
        ThreadSortKey::CreatedAt => item.item.created_at.as_deref()?,
        ThreadSortKey::UpdatedAt => item
            .item
            .updated_at
            .as_deref()
            .or(item.item.created_at.as_deref())?,
    };
    parse_cursor(timestamp)
}

fn thread_search_item_key(item: &ThreadSearchItem) -> String {
    item.item
        .thread_id
        .map(|thread_id| thread_id.to_string())
        .unwrap_or_else(|| item.item.path.display().to_string())
}

fn compare_thread_search_items(
    left: &ThreadSearchItem,
    right: &ThreadSearchItem,
    sort_key: ThreadSortKey,
    sort_direction: SortDirection,
) -> std::cmp::Ordering {
    let ordering = thread_search_item_timestamp(left, sort_key)
        .cmp(&thread_search_item_timestamp(right, sort_key))
        .then_with(|| thread_search_item_key(left).cmp(&thread_search_item_key(right)));
    match sort_direction {
        SortDirection::Asc => ordering,
        SortDirection::Desc => ordering.reverse(),
    }
}

fn thread_search_item_timestamp(
    item: &ThreadSearchItem,
    sort_key: ThreadSortKey,
) -> Option<DateTime<Utc>> {
    let timestamp = match sort_key {
        ThreadSortKey::CreatedAt => item.item.created_at.as_deref(),
        ThreadSortKey::UpdatedAt => item
            .item
            .updated_at
            .as_deref()
            .or(item.item.created_at.as_deref()),
    }?;
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

async fn set_thread_search_result_names(
    store: &LocalThreadStore,
    items: &mut [StoredThreadSearchResult],
) {
    let thread_ids = items
        .iter()
        .map(|item| item.thread.thread_id)
        .collect::<HashSet<_>>();
    let mut names = HashMap::<ThreadId, String>::with_capacity(thread_ids.len());
    if let Some(state_db_ctx) = store.state_db().await {
        for &thread_id in &thread_ids {
            let Ok(Some(metadata)) = state_db_ctx.get_thread(thread_id).await else {
                continue;
            };
            if let Some(title) = distinct_thread_metadata_title(&metadata) {
                names.insert(thread_id, title);
            }
        }
    }
    if names.len() < thread_ids.len()
        && let Ok(legacy_names) =
            find_thread_names_by_ids(store.config.codex_home.as_path(), &thread_ids).await
    {
        for (thread_id, title) in legacy_names {
            names.entry(thread_id).or_insert(title);
        }
    }
    for item in items {
        if let Some(title) = names.get(&item.thread.thread_id).cloned() {
            set_thread_name_from_title(&mut item.thread, title);
        }
    }
}
