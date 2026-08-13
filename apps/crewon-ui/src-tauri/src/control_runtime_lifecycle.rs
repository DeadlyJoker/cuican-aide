struct RuntimeLifecycle {
    available: bool,
    candidate_failures: Vec<ProcessRole>,
    control_generation: u64,
    control_api: Option<CommandChild>,
    device: Option<CommandChild>,
    device_generation: u64,
    gateway: Option<CommandChild>,
    gateway_generation: u64,
    worker: Option<CommandChild>,
    worker_generation: u64,
    workspace: Option<Arc<workspace::WorkspaceRuntimeContext>>,
}

impl RuntimeLifecycle {
    fn owns(&self, role: ProcessRole) -> bool {
        match role {
            ProcessRole::ControlApi(generation) => {
                self.control_generation == generation && self.control_api.is_some()
            }
            ProcessRole::Device(generation) => {
                self.device_generation == generation && self.device.is_some()
            }
            ProcessRole::Gateway(generation) => {
                self.gateway_generation == generation && self.gateway.is_some()
            }
            ProcessRole::Worker(generation) => {
                self.worker_generation == generation && self.worker.is_some()
            }
        }
    }

    fn record_candidate_failure(&mut self, role: ProcessRole) {
        if !self.candidate_failures.contains(&role) {
            self.candidate_failures.push(role);
        }
    }
}

#[derive(Default)]
struct ProcessTerminationTracker {
    state: Mutex<Option<PendingProcessTerminations>>,
    changed: Condvar,
}

struct PendingProcessTerminations {
    expected: Vec<ProcessRole>,
    acknowledged: Vec<bool>,
}

struct FailedAdmissionFence {
    database: Option<rusqlite::Connection>,
    expected: Vec<ProcessRole>,
    processes: Vec<CommandChild>,
}

struct StartupQuarantine {
    lease: Option<crate::workspace_native::WorkspaceAuthorityLease>,
    processes: Vec<CommandChild>,
}

/// Managed Tauri state that owns both child lifetimes and ephemeral credentials.
pub struct ControlRuntimeSupervisor {
    candidate_runtime: Mutex<Option<reload::PreparedRuntimeSupervision>>,
    candidate_workspace: Mutex<Option<workspace_switch::StagedWorkspaceCandidate>>,
    failed_admission_fence: Mutex<Option<FailedAdmissionFence>>,
    failed_process_quarantine: Mutex<FailedProcessQuarantine>,
    lifecycle: Mutex<RuntimeLifecycle>,
    reload: Mutex<()>,
    session: Option<SessionMaterial>,
    terminations: ProcessTerminationTracker,
    workspace_authority_lease: Option<crate::workspace_native::WorkspaceAuthorityLease>,
}

#[derive(Default)]
struct FailedProcessQuarantine {
    disables_runtime: bool,
    processes: Vec<CommandChild>,
}

impl ControlRuntimeSupervisor {
    fn unavailable() -> Self {
        let mut startup = STARTUP_QUARANTINE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let workspace_authority_lease = startup.lease.take();
        let processes = std::mem::take(&mut startup.processes);
        drop(startup);
        Self {
            candidate_runtime: Mutex::new(None),
            candidate_workspace: Mutex::new(None),
            failed_admission_fence: Mutex::new(None),
            failed_process_quarantine: Mutex::new(FailedProcessQuarantine {
                disables_runtime: !processes.is_empty(),
                processes,
            }),
            lifecycle: Mutex::new(RuntimeLifecycle {
                available: false,
                candidate_failures: Vec::new(),
                control_generation: 0,
                control_api: None,
                device: None,
                device_generation: 0,
                gateway: None,
                gateway_generation: 0,
                worker: None,
                worker_generation: 0,
                workspace: None,
            }),
            reload: Mutex::new(()),
            session: None,
            terminations: ProcessTerminationTracker::default(),
            workspace_authority_lease,
        }
    }

    fn started(
        session: SessionMaterial,
        control_api: CommandChild,
        worker: CommandChild,
        workspace: Option<Arc<workspace::WorkspaceRuntimeContext>>,
        workspace_authority_lease: Option<crate::workspace_native::WorkspaceAuthorityLease>,
    ) -> Self {
        Self {
            candidate_runtime: Mutex::new(None),
            candidate_workspace: Mutex::new(None),
            failed_admission_fence: Mutex::new(None),
            failed_process_quarantine: Mutex::new(FailedProcessQuarantine::default()),
            lifecycle: Mutex::new(RuntimeLifecycle {
                available: true,
                candidate_failures: Vec::new(),
                control_generation: 1,
                control_api: Some(control_api),
                device: None,
                device_generation: 0,
                gateway: None,
                gateway_generation: 0,
                worker: Some(worker),
                worker_generation: 1,
                workspace,
            }),
            reload: Mutex::new(()),
            session: Some(session),
            terminations: ProcessTerminationTracker::default(),
            workspace_authority_lease,
        }
    }

    fn require_workspace_authority_lease(
        &self,
    ) -> Result<(), workspace_wire::DesktopWorkspaceError> {
        self.workspace_authority_lease
            .as_ref()
            .map(|_| ())
            .ok_or_else(workspace_wire::DesktopWorkspaceError::unavailable)
    }

    fn bootstrap(&self) -> Result<ControlRuntimeBootstrap, &'static str> {
        let Ok(lifecycle) = self.lifecycle.lock() else {
            return Err("control_runtime_unavailable");
        };
        if !lifecycle.available || lifecycle.control_api.is_none() || lifecycle.worker.is_none() {
            return Err("control_runtime_unavailable");
        }
        self.session
            .as_ref()
            .map(SessionMaterial::public_bootstrap)
            .ok_or("control_runtime_unavailable")
    }

    fn runtime_route(&self) -> Result<RuntimeRouteProjection, ControlRuntimeStartError> {
        let lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| ControlRuntimeStartError::RuntimeUnavailable)?;
        match lifecycle.workspace.as_deref() {
            Some(workspace) => workspace.runtime_route(),
            None => Ok(RuntimeRouteProjection::standalone()),
        }
    }

    fn shutdown(&self) {
        let Ok(mut lifecycle) = self.lifecycle.lock() else {
            return;
        };
        lifecycle.available = false;
        lifecycle.candidate_failures.clear();
        let children = [
            lifecycle.control_api.take(),
            lifecycle.worker.take(),
            lifecycle.device.take(),
            lifecycle.gateway.take(),
        ];
        drop(lifecycle);
        let children = children.into_iter().flatten().collect::<Vec<_>>();
        self.quarantine_active_processes(children);
        let candidate = self
            .candidate_runtime
            .lock()
            .ok()
            .and_then(|mut candidate| candidate.take());
        if let Some(candidate) = candidate {
            reload::stop_prepared_runtime(self, candidate);
        }
        workspace_candidate::stop_staged_candidate(self);
        let _ = self.retry_failed_process_quarantine();
    }

    fn quarantine_active_processes(&self, processes: Vec<CommandChild>) {
        self.quarantine_processes(processes, true);
    }

    fn quarantine_candidate_processes(&self, processes: Vec<CommandChild>) {
        self.quarantine_processes(processes, false);
    }

    fn quarantine_processes(&self, processes: Vec<CommandChild>, disables_runtime: bool) {
        self.quarantine_processes_with_terminator(processes, disables_runtime, |processes| {
            terminate_managed_children(processes, TERMINATION_TIMEOUT)
        });
    }

    fn quarantine_processes_with_terminator(
        &self,
        processes: Vec<CommandChild>,
        disables_runtime: bool,
        terminate: impl FnOnce(&[CommandChild]) -> bool,
    ) {
        if processes.is_empty() || terminate(&processes) {
            return;
        }
        if let (true, Ok(mut lifecycle)) = (disables_runtime, self.lifecycle.lock()) {
            lifecycle.available = false;
        }
        let mut quarantine = self
            .failed_process_quarantine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        quarantine.disables_runtime |= disables_runtime;
        quarantine.processes.extend(processes);
    }

    fn retry_failed_process_quarantine(&self) -> bool {
        let mut quarantine = self
            .failed_process_quarantine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if quarantine.processes.is_empty() {
            return true;
        }
        if !terminate_managed_children(&quarantine.processes, TERMINATION_TIMEOUT) {
            return false;
        }
        quarantine.processes.clear();
        quarantine.disables_runtime = false;
        true
    }

    fn require_no_failed_process_quarantine(
        &self,
    ) -> Result<(), workspace_wire::DesktopWorkspaceError> {
        if self.session.is_some() && self.retry_failed_process_quarantine() {
            Ok(())
        } else {
            Err(workspace_wire::DesktopWorkspaceError::aborted())
        }
    }

    fn process_terminated(&self, role: ProcessRole, cleanup_proven: bool) {
        let should_shutdown = match self.lifecycle.lock() {
            Ok(lifecycle) if lifecycle.owns(role) && lifecycle.available => true,
            Ok(mut lifecycle) if lifecycle.owns(role) => {
                lifecycle.record_candidate_failure(role);
                false
            }
            Ok(_) => false,
            Err(_) => true,
        };
        let completed_wait = cleanup_proven && self.terminations.acknowledge(role);
        if completed_wait {
            self.release_failed_admission_fence();
        }
        if should_shutdown {
            self.shutdown();
        }
    }

    fn process_monitor_failed(&self, role: ProcessRole) {
        let should_shutdown = match self.lifecycle.lock() {
            Ok(lifecycle) if lifecycle.owns(role) && lifecycle.available => true,
            Ok(mut lifecycle) if lifecycle.owns(role) => {
                lifecycle.record_candidate_failure(role);
                false
            }
            Ok(_) => false,
            Err(_) => true,
        };
        if should_shutdown {
            self.shutdown();
        }
    }

    fn retain_failed_admission_fence_with_processes(
        &self,
        database: rusqlite::Connection,
        expected: Vec<ProcessRole>,
        processes: Vec<CommandChild>,
    ) {
        if (processes.is_empty() && self.terminations.is_complete(&expected))
            || (!processes.is_empty() && managed_children_are_terminated(&processes))
        {
            let _ = database.execute_batch("ROLLBACK");
            self.terminations.finish(&expected);
            return;
        }
        let Ok(mut fence) = self.failed_admission_fence.lock() else {
            std::mem::forget(database);
            for process in processes {
                std::mem::forget(process);
            }
            return;
        };
        if fence.is_some() {
            std::mem::forget(database);
            for process in processes {
                std::mem::forget(process);
            }
            return;
        }
        *fence = Some(FailedAdmissionFence {
            database: Some(database),
            expected,
            processes,
        });
    }

    fn release_failed_admission_fence(&self) {
        let Ok(mut fence) = self.failed_admission_fence.lock() else {
            return;
        };
        let Some(failed) = fence.as_ref() else {
            return;
        };
        let terminated = if failed.processes.is_empty() {
            self.terminations.is_complete(&failed.expected)
        } else {
            managed_children_are_terminated(&failed.processes)
        };
        if !terminated {
            return;
        }
        let mut failed = fence.take().expect("checked failed admission fence");
        failed.processes.clear();
        if let Some(database) = failed.database.take() {
            let _ = database.execute_batch("ROLLBACK");
        }
        self.terminations.finish(&failed.expected);
    }
}

impl Drop for FailedAdmissionFence {
    fn drop(&mut self) {
        if terminate_managed_children(&self.processes, TERMINATION_TIMEOUT) {
            if let Some(database) = self.database.take() {
                let _ = database.execute_batch("ROLLBACK");
            }
            return;
        }
        if let Some(database) = self.database.take() {
            std::mem::forget(database);
        }
        for process in self.processes.drain(..) {
            std::mem::forget(process);
        }
    }
}

impl ProcessTerminationTracker {
    fn begin(&self, expected: Vec<ProcessRole>) -> Result<(), ControlRuntimeStartError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ControlRuntimeStartError::RuntimeUnavailable)?;
        if state.is_some()
            || expected.is_empty()
            || expected
                .iter()
                .enumerate()
                .any(|(index, role)| expected[..index].contains(role))
        {
            return Err(ControlRuntimeStartError::RuntimeUnavailable);
        }
        let acknowledged = vec![false; expected.len()];
        *state = Some(PendingProcessTerminations {
            expected,
            acknowledged,
        });
        Ok(())
    }

    fn acknowledge(&self, role: ProcessRole) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(pending) = state.as_mut() else {
            return false;
        };
        for (index, expected) in pending.expected.iter().enumerate() {
            if *expected == role {
                pending.acknowledged[index] = true;
            }
        }
        let complete = pending.acknowledged.iter().all(|value| *value);
        if complete {
            self.changed.notify_all();
        }
        complete
    }

    #[cfg(test)]
    fn wait(&self, expected: &[ProcessRole], timeout: Duration) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        let Ok((state, _)) = self.changed.wait_timeout_while(state, timeout, |pending| {
            pending.as_ref().is_some_and(|pending| {
                pending.expected == expected && !pending.acknowledged.iter().all(|value| *value)
            })
        }) else {
            return false;
        };
        state.as_ref().is_some_and(|pending| {
            pending.expected == expected && pending.acknowledged.iter().all(|value| *value)
        })
    }

    fn is_complete(&self, expected: &[ProcessRole]) -> bool {
        self.state.lock().is_ok_and(|state| {
            state.as_ref().is_some_and(|pending| {
                pending.expected == expected && pending.acknowledged.iter().all(|value| *value)
            })
        })
    }

    fn finish(&self, expected: &[ProcessRole]) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state
            .as_ref()
            .is_some_and(|pending| pending.expected == expected)
        {
            *state = None;
        }
    }
}

impl Drop for ControlRuntimeSupervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}
