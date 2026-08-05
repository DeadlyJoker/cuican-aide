mod sidecar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());

    // The updater needs `process` to relaunch after installing. Both are desktop
    // only, and the frontend drives them, so registration is all the shell owes.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .setup(|app| {
            // A packaged build has no dev server to start the backend, so the
            // shell owns it. Failing to spawn is not fatal: the window still opens
            // and reports its connection state instead of dying silently.
            if let Err(error) = sidecar::spawn(app.handle()) {
                eprintln!("failed to start the bundled app-server: {error}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Crewon desktop client")
        .run(sidecar::handle_run_event);
}
