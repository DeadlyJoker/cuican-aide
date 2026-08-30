use std::collections::VecDeque;
use std::sync::Arc;

use async_trait::async_trait;
use crewon_protocol::ThreadId;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::UserInputOnceMarkerPhase;
use crewon_thread_store::AppendThreadItemsParams;
use crewon_thread_store::ArchiveThreadParams;
use crewon_thread_store::CreateThreadParams;
use crewon_thread_store::DeleteThreadParams;
use crewon_thread_store::ListThreadsParams;
use crewon_thread_store::LoadThreadHistoryParams;
use crewon_thread_store::ReadThreadByRolloutPathParams;
use crewon_thread_store::ReadThreadParams;
use crewon_thread_store::ResumeThreadParams;
use crewon_thread_store::StoredThread;
use crewon_thread_store::StoredThreadHistory;
use crewon_thread_store::ThreadPage;
use crewon_thread_store::ThreadStore;
use crewon_thread_store::ThreadStoreError;
use crewon_thread_store::ThreadStoreResult;
use crewon_thread_store::UpdateThreadMetadataParams;
use tokio::sync::Mutex;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WriterFault {
    RejectAppend(UserInputOnceMarkerPhase),
    DropAppend(UserInputOnceMarkerPhase),
    CommitAppendThenFail(UserInputOnceMarkerPhase),
    FailFlush,
    FailLoadHistory,
}

pub struct FaultThreadStore {
    inner: Arc<dyn ThreadStore>,
    faults: Mutex<VecDeque<WriterFault>>,
}

impl FaultThreadStore {
    pub fn new(inner: Arc<dyn ThreadStore>) -> Self {
        Self {
            inner,
            faults: Mutex::new(VecDeque::new()),
        }
    }

    pub async fn enqueue(&self, fault: WriterFault) {
        self.faults.lock().await.push_back(fault);
    }

    async fn take_append_fault(&self, params: &AppendThreadItemsParams) -> Option<WriterFault> {
        let phase = params.items.iter().find_map(|item| match item {
            RolloutItem::UserInputOnceMarker(marker) => Some(marker.phase),
            _ => None,
        })?;
        let mut faults = self.faults.lock().await;
        let matches = matches!(
            faults.front(),
            Some(
                WriterFault::RejectAppend(expected)
                    | WriterFault::DropAppend(expected)
                    | WriterFault::CommitAppendThenFail(expected)
            ) if *expected == phase
        );
        matches.then(|| faults.pop_front().expect("matching fault must exist"))
    }

    async fn take_exact_fault(&self, expected: WriterFault) -> bool {
        let mut faults = self.faults.lock().await;
        if faults.front() != Some(&expected) {
            return false;
        }
        faults.pop_front();
        true
    }
}

#[async_trait]
impl ThreadStore for FaultThreadStore {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    async fn create_thread(&self, params: CreateThreadParams) -> ThreadStoreResult<()> {
        self.inner.create_thread(params).await
    }

    async fn resume_thread(&self, params: ResumeThreadParams) -> ThreadStoreResult<()> {
        self.inner.resume_thread(params).await
    }

    async fn append_items(&self, params: AppendThreadItemsParams) -> ThreadStoreResult<()> {
        match self.take_append_fault(&params).await {
            Some(WriterFault::RejectAppend(_)) => Err(ThreadStoreError::Internal {
                message: "test fault rejected append".to_string(),
            }),
            Some(WriterFault::DropAppend(_)) => Ok(()),
            Some(WriterFault::CommitAppendThenFail(_)) => {
                self.inner.append_items(params).await?;
                Err(ThreadStoreError::Internal {
                    message: "test fault failed after append commit".to_string(),
                })
            }
            Some(WriterFault::FailFlush | WriterFault::FailLoadHistory) => {
                unreachable!("non-append fault cannot match append")
            }
            None => self.inner.append_items(params).await,
        }
    }

    async fn persist_thread(&self, thread_id: ThreadId) -> ThreadStoreResult<()> {
        self.inner.persist_thread(thread_id).await
    }

    async fn flush_thread(&self, thread_id: ThreadId) -> ThreadStoreResult<()> {
        if self.take_exact_fault(WriterFault::FailFlush).await {
            return Err(ThreadStoreError::Internal {
                message: "test fault failed flush".to_string(),
            });
        }
        self.inner.flush_thread(thread_id).await
    }

    async fn shutdown_thread(&self, thread_id: ThreadId) -> ThreadStoreResult<()> {
        self.inner.shutdown_thread(thread_id).await
    }

    async fn discard_thread(&self, thread_id: ThreadId) -> ThreadStoreResult<()> {
        self.inner.discard_thread(thread_id).await
    }

    async fn load_history(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreResult<StoredThreadHistory> {
        if self.take_exact_fault(WriterFault::FailLoadHistory).await {
            return Err(ThreadStoreError::Internal {
                message: "test fault failed history load".to_string(),
            });
        }
        self.inner.load_history(params).await
    }

    async fn read_thread(&self, params: ReadThreadParams) -> ThreadStoreResult<StoredThread> {
        self.inner.read_thread(params).await
    }

    async fn read_thread_by_rollout_path(
        &self,
        params: ReadThreadByRolloutPathParams,
    ) -> ThreadStoreResult<StoredThread> {
        self.inner.read_thread_by_rollout_path(params).await
    }

    async fn list_threads(&self, params: ListThreadsParams) -> ThreadStoreResult<ThreadPage> {
        self.inner.list_threads(params).await
    }

    async fn update_thread_metadata(
        &self,
        params: UpdateThreadMetadataParams,
    ) -> ThreadStoreResult<StoredThread> {
        self.inner.update_thread_metadata(params).await
    }

    async fn archive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreResult<()> {
        self.inner.archive_thread(params).await
    }

    async fn unarchive_thread(
        &self,
        params: ArchiveThreadParams,
    ) -> ThreadStoreResult<StoredThread> {
        self.inner.unarchive_thread(params).await
    }

    async fn delete_thread(&self, params: DeleteThreadParams) -> ThreadStoreResult<()> {
        self.inner.delete_thread(params).await
    }
}
