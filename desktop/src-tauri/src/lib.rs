use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const PORT: u16 = 7777;

// В webview ссылки target=_blank сами не уходят в браузер. Перехватываем клики по внешним ссылкам
// и превращаем в top-level навигацию — её ловит on_navigation и открывает в системном браузере.
const LINK_SCRIPT: &str = r#"
window.addEventListener('click', function(e){
  var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if(!a) return;
  var href = a.href || '';
  if(/^https?:\/\//i.test(href)){
    var panel = href.indexOf('127.0.0.1:7777') >= 0 || href.indexOf('localhost:7777') >= 0;
    if(!panel){ e.preventDefault(); window.location.href = 'http://127.0.0.1:7777/__open?u=' + encodeURIComponent(href); }
  }
}, true);
"#;

struct Sidecar(Mutex<Option<CommandChild>>);
// Текущий список сервисов в том же порядке, что и в меню трея (для обработки кликов по пунктам).
struct Services(Mutex<Vec<(String, u16, bool)>>);

fn panel_up() -> bool {
    TcpStream::connect_timeout(
        &(std::net::Ipv4Addr::LOCALHOST, PORT).into(),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// Монохромная template-иконка для строки меню (две «полки» — стойка сервиса), нарисована в коде.
fn tray_image() -> tauri::image::Image<'static> {
    let (w, h) = (36usize, 36usize);
    let mut buf = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            if (5..31).contains(&x) && ((7..15).contains(&y) || (21..29).contains(&y)) {
                buf[(y * w + x) * 4 + 3] = 255; // RGB=0 (чёрный) + alpha на форме; macOS перекрасит
            }
        }
    }
    let leaked: &'static [u8] = Box::leak(buf.into_boxed_slice());
    tauri::image::Image::new(leaked, w as u32, h as u32)
}

// Перестроить меню трея под текущие сервисы (на главном потоке).
fn rebuild_menu(app: &AppHandle, shown: &[(String, u16, bool)], up: usize, total: usize, autostart_on: bool) {
    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
    if let Ok(i) = MenuItem::with_id(app, "panel", "Открыть панель AI Garage", true, None::<&str>) {
        items.push(Box::new(i));
    }
    if let Ok(s) = PredefinedMenuItem::separator(app) {
        items.push(Box::new(s));
    }
    if let Ok(sum) = MenuItem::with_id(app, "summary", format!("Работает {up} из {total}  ·  клик 🟢 — открыть, 🔴 — запустить"), false, None::<&str>) {
        items.push(Box::new(sum));
    }
    for (idx, (name, port, is_up)) in shown.iter().enumerate() {
        let dot = if *is_up { "🟢" } else { "🔴" };
        let label = format!("{dot}  {name}  :{port}");
        if let Ok(it) = MenuItem::with_id(app, format!("svc{idx}"), label, true, None::<&str>) {
            items.push(Box::new(it));
        }
    }
    if let Ok(s) = PredefinedMenuItem::separator(app) {
        items.push(Box::new(s));
    }
    if let Ok(a) = CheckMenuItem::with_id(app, "toggle-autostart", "Запускать при логине", true, autostart_on, None::<&str>) {
        items.push(Box::new(a));
    }
    if let Ok(q) = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>) {
        items.push(Box::new(q));
    }
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|b| b.as_ref()).collect();
    if let Ok(menu) = Menu::with_items(app, &refs) {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(Sidecar(Mutex::new(None)))
        .manage(Services(Mutex::new(Vec::new())))
        .on_menu_event(|app, ev| {
            let id = ev.id().as_ref().to_string();
            if id == "panel" {
                show_main(app);
            } else if id == "quit" {
                app.exit(0);
            } else if id == "toggle-autostart" {
                let al = app.autolaunch();
                let now = al.is_enabled().unwrap_or(false);
                let _ = if now { al.disable() } else { al.enable() };
            } else if let Some(n) = id.strip_prefix("svc") {
                if let Ok(idx) = n.parse::<usize>() {
                    let svc = app
                        .try_state::<Services>()
                        .and_then(|s| s.0.lock().ok().and_then(|v| v.get(idx).cloned()));
                    if let Some((name, port, is_up)) = svc {
                        if is_up {
                            // живой сервис → открыть в системном браузере
                            let _ = app.shell().open(format!("http://localhost:{port}"), None);
                        } else {
                            // выключенный → попытаться запустить через API панели
                            let h = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = reqwest::Client::new()
                                    .post(format!("http://127.0.0.1:{PORT}/api/start"))
                                    .json(&serde_json::json!({ "name": name }))
                                    .send()
                                    .await;
                                let _ = h; // меню обновится при следующем опросе
                            });
                        }
                    }
                }
            }
        })
        .setup(|app| {
            // 1) Sidecar-сервер — только если порт свободен.
            if !panel_up() {
                let assets = app.path().resolve("public", BaseDirectory::Resource).ok();
                let cmd = app
                    .shell()
                    .sidecar("ai-garage-server")
                    .expect("sidecar binary missing");
                let cmd = match assets {
                    Some(p) => cmd.args(["--assets".to_string(), p.to_string_lossy().to_string()]),
                    None => cmd,
                };
                match cmd.spawn() {
                    Ok((mut rx, child)) => {
                        app.state::<Sidecar>().0.lock().unwrap().replace(child);
                        tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });
                    }
                    Err(e) => eprintln!("sidecar spawn failed: {e}"),
                }
            }

            // 2) Окно с панелью. Внешние ссылки открываем в системном браузере (см. LINK_SCRIPT).
            let nav = app.handle().clone();
            let url = format!("http://127.0.0.1:{PORT}");
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("AI Garage")
                .inner_size(1180.0, 800.0)
                .min_inner_size(420.0, 520.0)
                .resizable(true)
                .visible(true)
                .initialization_script(LINK_SCRIPT)
                .on_navigation(move |u| {
                    // спец-маркер из LINK_SCRIPT: /__open?u=<url> → открыть во внешнем браузере.
                    let panel_host = matches!(u.host_str(), Some("127.0.0.1") | Some("localhost")) && u.port() == Some(PORT);
                    if panel_host && u.path() == "/__open" {
                        if let Some((_, val)) = u.query_pairs().find(|(k, _)| k == "u") {
                            let _ = nav.shell().open(val.to_string(), None);
                        }
                        return false; // окно панели не трогаем
                    }
                    true // панель и iframe-превью локальных сервисов — пускаем как есть
                })
                .build()?;
            {
                let w = win.clone();
                win.on_window_event(move |e| {
                    if let WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            // 3) Трей: видимая иконка, левый клик открывает меню.
            let start_panel = MenuItem::with_id(app, "panel", "Открыть панель AI Garage", true, None::<&str>)?;
            let start_quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let start_menu = Menu::with_items(app, &[&start_panel, &start_quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_image())
                .icon_as_template(true)
                .tooltip("AI Garage")
                .menu(&start_menu)
                .show_menu_on_left_click(true)
                .build(app)?;

            // 4) Опрос /api/status: бейдж X/Y + перестроение меню при изменении.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let client = reqwest::Client::new();
                let status_url = format!("http://127.0.0.1:{PORT}/api/status");
                let mut last_sig = String::new();
                loop {
                    if let Ok(resp) = client.get(&status_url).send().await {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            if let Some(arr) = json.get("services").and_then(|s| s.as_array()) {
                                let all: Vec<(String, u16, bool)> = arr
                                    .iter()
                                    .map(|s| {
                                        (
                                            s.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                            s.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
                                            s.get("up").and_then(|v| v.as_bool()).unwrap_or(false),
                                        )
                                    })
                                    .collect();
                                let up = all.iter().filter(|s| s.2).count();
                                let total = all.len();
                                let mut shown = all.clone();
                                shown.sort_by_key(|s| s.2); // выключенные наверх
                                shown.truncate(12);
                                let autostart_on = handle.autolaunch().is_enabled().unwrap_or(false);
                                let sig = format!(
                                    "{autostart_on}|{up}/{total}|{}",
                                    shown.iter().map(|s| format!("{}{}{}", s.0, s.1, s.2)).collect::<Vec<_>>().join(",")
                                );
                                let changed = sig != last_sig;
                                if changed {
                                    last_sig = sig;
                                    if let Some(st) = handle.try_state::<Services>() {
                                        *st.0.lock().unwrap() = shown.clone();
                                    }
                                }
                                let h2 = handle.clone();
                                let _ = handle.run_on_main_thread(move || {
                                    if let Some(tray) = h2.tray_by_id("main-tray") {
                                        let _ = tray.set_title(Some(format!("{up}/{total}")));
                                    }
                                    if changed {
                                        rebuild_menu(&h2, &shown, up, total, autostart_on);
                                    }
                                });
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::Reopen { .. } => show_main(app_handle),
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                if let Some(state) = app_handle.try_state::<Sidecar>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
            _ => {}
        });
}
