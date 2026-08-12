mod control_runtime;
mod provider_credentials;
// N5b2 deliberately keeps this authority private until the supervisor wiring
// lands in the next slice.
#[allow(dead_code)]
mod workspace_native;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());

    // Requests issued from Rust are not subject to the webview's CORS rules.
    // The backend sends no `Access-Control-Allow-Origin`, so a packaged build
    // dialling it from `tauri://localhost` had every request blocked; in dev the
    // Vite proxy made those calls same-origin and hid the problem.
    let builder = builder.plugin(tauri_plugin_http::init());

    // The updater needs `process` to relaunch after installing. Both are desktop
    // only, and the frontend drives them, so registration is all the shell owes.
    // The dialog plugin is what lets the sidebar ask the OS for a folder instead
    // of asking the user to type an absolute path. Desktop only, like the rest.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init());

    builder
        .invoke_handler(tauri::generate_handler![
            control_runtime::control_runtime_bootstrap,
            control_runtime::workspace_status::desktop_workspace_status,
            control_runtime::workspace_coordinator::desktop_workspace_select_and_register,
            control_runtime::workspace_coordinator::desktop_workspace_clear,
            control_runtime::reload::control_runtime_reload_provider,
            provider_credentials::provider_credential_activate,
            provider_credentials::provider_credential_catalog,
            provider_credentials::provider_credential_delete,
            provider_credentials::provider_credential_upsert,
        ])
        .setup(|app| {
            if let Err(error) = provider_credentials::install(app.handle()) {
                eprintln!(
                    "failed to initialize the Provider credential store: {}",
                    error.code()
                );
            }
            if let Err(error) = control_runtime::install(app.handle()) {
                eprintln!(
                    "failed to start the bundled control runtime: {}",
                    error.code()
                );
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Crewon desktop client")
        .run(|app, event| {
            control_runtime::handle_run_event(app, &event);
        });
}
