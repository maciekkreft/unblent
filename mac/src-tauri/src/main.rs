// The Mac app's window (architecture.md 3.4, 10): it starts the packaged local server,
// shows the Mac page once the server answers, stops the server when the app ends, and
// offers updates. The pages know nothing of this shell.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

// mac/serve.py's port: the webview keeps its storage per origin, so it never changes.
const DEFAULT_PORT: u16 = 47321;
const PAGE: &str = "/workshop/apps/macapp";
const READY_PATH: &str = "/api/session/me";
// A first open can be slow while macOS checks every file of the new app once.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
// The window keeps this name whatever title the page sets.
const TITLE: &str = "Unblent";

struct Server(Mutex<Option<Child>>);

fn port() -> u16 {
    std::env::var("UNBLENT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn log_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("Unblent"));
    let _ = fs::create_dir_all(&dir);
    dir
}

/// The shell's own notes go to a file, since a Mac app has no terminal to print to.
fn log(app: &AppHandle, line: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir(app).join("app.log"))
    {
        let _ = writeln!(file, "{line}");
    }
}

fn answers(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET {READY_PATH} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 16];
    let n = stream.read(&mut head).unwrap_or(0);
    String::from_utf8_lossy(&head[..n]).starts_with("HTTP/1.1 200")
        || String::from_utf8_lossy(&head[..n]).starts_with("HTTP/1.0 200")
}

fn port_taken(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn last_line(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
}

/// Starts the server from the app's resources and waits until it answers.
fn start_server(app: &AppHandle) -> Result<(), String> {
    let port = port();
    // serve.py checks this too, but by then its answer would race the other copy's.
    if port_taken(port) {
        return Err(format!(
            "Unblent cannot start: port {port} on 127.0.0.1 is already in use, probably by another copy of Unblent. Quit it and try again."
        ));
    }
    let program = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Unblent cannot find its files: {e}"))?
        .join("unblent-server")
        .join("unblent-server");
    let log_path = log_dir(app).join("server.log");
    let out = File::create(&log_path).map_err(|e| format!("Unblent cannot write its log: {e}"))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(&program)
        .env("UNBLENT_PORT", port.to_string())
        // serve.py stops itself if this process dies without stopping it.
        .env("UNBLENT_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|e| {
            format!(
                "Unblent cannot start its server ({}): {e}",
                program.display()
            )
        })?;
    let state = app.state::<Server>();
    *state.0.lock().unwrap() = Some(child);

    let started = Instant::now();
    loop {
        if let Some(child) = state.0.lock().unwrap().as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                let reason = last_line(&log_path)
                    .unwrap_or_else(|| format!("Unblent's server stopped ({status})."));
                return Err(reason);
            }
        }
        if answers(port) {
            log(app, &format!("server ready after {:?}", started.elapsed()));
            return Ok(());
        }
        if started.elapsed() > READY_TIMEOUT {
            return Err(format!(
                "Unblent's server did not start within {} seconds. Its log is in {}.",
                READY_TIMEOUT.as_secs(),
                log_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// SIGTERM lets the server finish what it is writing; a server that does not stop in
/// time is killed.
fn stop_server(app: &AppHandle) {
    let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() else {
        return;
    };
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let started = Instant::now();
    while started.elapsed() < STOP_TIMEOUT {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn fail(app: &AppHandle, message: &str) {
    log(app, message);
    app.dialog()
        .message(message)
        .title("Unblent cannot open")
        .kind(MessageDialogKind::Error)
        .blocking_show();
    stop_server(app);
    app.exit(1);
}

/// Nothing is installed without the user's yes; any failure is only logged.
async fn offer_update(app: AppHandle) {
    let result: Result<(), String> = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        let yes = app
            .dialog()
            .message(
                "Restart Unblent now to start using it. Your books and notes stay as they are.",
            )
            .title(format!("Version {} is ready", update.version))
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Restart to update".into(),
                "Later".into(),
            ))
            .blocking_show();
        if !yes {
            return Ok(());
        }
        update.install(bytes).map_err(|e| e.to_string())?;
        // The Exit event stops the server before the new version starts its own.
        app.request_restart();
        Ok(())
    }
    .await;
    if let Err(error) = result {
        log(&app, &format!("update: {error}"));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Server(Mutex::new(None)))
        .menu(|app| {
            let app_menu = SubmenuBuilder::new(app, TITLE)
                .about(None)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            // These items are what lets ⌘C, ⌘V and ⌘Z reach the page on macOS.
            let edit = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window = SubmenuBuilder::new(app, "Window")
                .minimize()
                .fullscreen()
                .separator()
                .close_window()
                .build()?;
            MenuBuilder::new(app)
                .items(&[&app_menu, &edit, &window])
                .build()
        })
        .setup(|app| {
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title(TITLE)
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(480.0, 480.0)
                    .on_document_title_changed(|window, _| {
                        let _ = window.set_title(TITLE);
                    })
                    .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || match start_server(&handle) {
                Ok(()) => {
                    let url = format!("http://127.0.0.1:{}{PAGE}", port());
                    if let Err(e) = window.navigate(url.parse().expect("the page's address")) {
                        fail(&handle, &format!("Unblent cannot show its page: {e}"));
                        return;
                    }
                    tauri::async_runtime::spawn(offer_update(handle.clone()));
                }
                Err(message) => fail(&handle, &message),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Unblent could not start its window")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(app);
            }
        });
}
