use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    ActivationPolicy, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_positioner::{Position, WindowExt};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const PORT: u16 = 7777;

// Хранит дочерний процесс sidecar, чтобы убить его при выходе.
struct Sidecar(Mutex<Option<CommandChild>>);

// На 7777 уже кто-то слушает? (запущен `npx ai-garage` / прошлый инстанс) — тогда не плодим дубль.
fn panel_up() -> bool {
    TcpStream::connect_timeout(
        &(std::net::Ipv4Addr::LOCALHOST, PORT).into(),
        Duration::from_millis(300),
    )
    .is_ok()
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
        .setup(|app| {
            // Menubar-агент: без иконки в Dock.
            app.set_activation_policy(ActivationPolicy::Accessory);

            // 1) Поднять сервер как sidecar — только если порт ещё свободен.
            if !panel_up() {
                let assets = app.path().resolve("public", BaseDirectory::Resource).ok();
                let cmd = app.shell().sidecar("ai-garage-server").expect("sidecar binary missing");
                let cmd = match assets {
                    Some(p) => cmd.args(["--assets".to_string(), p.to_string_lossy().to_string()]),
                    None => cmd,
                };
                match cmd.spawn() {
                    Ok((_rx, child)) => {
                        app.state::<Sidecar>().0.lock().unwrap().replace(child);
                    }
                    Err(e) => eprintln!("sidecar spawn failed: {e}"),
                }
            }

            // 2) Frameless popover-окно, грузит панель с локального сервера.
            let url = format!("http://127.0.0.1:{PORT}");
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("AI Garage")
                .inner_size(440.0, 660.0)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .build()?;
            {
                let w = win.clone();
                win.on_window_event(move |e| {
                    if let WindowEvent::Focused(false) = e {
                        let _ = w.hide();
                    }
                });
            }

            // 3) Tray-иконка (монохромный template — адаптируется к тёмному/светлому меню-бару, вшита в бинарь)
            //    + popover под ней (positioner); меню: тогл автозапуска и выход.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let launch_item = CheckMenuItem::with_id(app, "toggle-autostart", "Запускать при логине", true, autostart_on, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти из AI Garage", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&launch_item, &quit])?;
            let li = launch_item.clone();
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, ev| {
                    match ev.id().as_ref() {
                        "quit" => app.exit(0),
                        "toggle-autostart" => {
                            let al = app.autolaunch();
                            let now = al.is_enabled().unwrap_or(false);
                            let _ = if now { al.disable() } else { al.enable() };
                            let _ = li.set_checked(!now);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.move_window(Position::TrayBottomCenter);
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // 4) Бейдж статуса в трее: опрос /api/status каждые 3с (в Rust, не во вебвью).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let client = reqwest::Client::new();
                let status_url = format!("http://127.0.0.1:{PORT}/api/status");
                loop {
                    if let Ok(resp) = client.get(&status_url).send().await {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            if let Some(arr) = json.get("services").and_then(|s| s.as_array()) {
                                let total = arr.len();
                                let up = arr
                                    .iter()
                                    .filter(|s| s.get("up").and_then(|v| v.as_bool()).unwrap_or(false))
                                    .count();
                                if let Some(tray) = handle.tray_by_id("main-tray") {
                                    let _ = tray.set_title(Some(format!("{up}/{total}")));
                                }
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            });

            // 5) Автозапуск при логине доступен (плагин + capability подключены), но НЕ включаем
            //    его автоматически: иначе закрепили бы login item на путь текущей сборки (хрупко).
            //    Включение — отдельным тоглом/командой, когда приложение установлено в стабильное место.

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Sidecar>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
