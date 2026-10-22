// Desktop shell for the catapult UI (plan phase F6). The UI is bundled; it talks to the orchestrator
// over the tailnet at the server URL set in its Settings tab.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running catapult desktop");
}
