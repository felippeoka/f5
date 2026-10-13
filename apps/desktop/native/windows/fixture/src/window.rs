use f5_computer_fixture::{Mode, Receipt, SECURE_TEXT};
use std::cell::RefCell;
use std::io::{BufRead, Write};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const STATUS: u32 = WM_APP + 1;
const CLOSE_REQUEST: u32 = WM_APP + 2;
const INPUT_ID: usize = 100;
const PRESS_ID: usize = 101;
const SECURE_ID: usize = 102;
struct State {
    mode: Mode,
    input: HWND,
    secure: HWND,
    receipt: Receipt,
}
thread_local! { static STATE: RefCell<Option<State>> = const { RefCell::new(None) }; }

fn emit(kind: &str, state: Option<serde_json::Value>) {
    let mut output = std::io::stdout().lock();
    let _ = writeln!(
        output,
        "{}",
        serde_json::json!({ "kind": kind, "state": state })
    );
    let _ = output.flush();
}
unsafe extern "system" fn procedure(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match message {
        WM_COMMAND => {
            let id = w.0 & 0xffff;
            let notification = (w.0 >> 16) & 0xffff;
            STATE.with(|slot| {
                if let Some(state) = slot.borrow_mut().as_mut() {
                    if id == PRESS_ID && notification == BN_CLICKED as usize {
                        state.receipt.press();
                        emit("press", Some(state.receipt.summary()));
                    } else if [INPUT_ID, SECURE_ID].contains(&id)
                        && notification == EN_CHANGE as usize
                    {
                        let secure = id == SECURE_ID;
                        let control = if secure { state.secure } else { state.input };
                        let length = GetWindowTextLengthW(control).max(0) as usize;
                        if length > 10_000 {
                            state.receipt.overflow = true;
                        } else {
                            let mut buffer = vec![0u16; length + 1];
                            let read = GetWindowTextW(control, &mut buffer).max(0) as usize;
                            state.receipt.input(&buffer[..read.min(length)], secure);
                            buffer.fill(0);
                        }
                        emit("input", Some(state.receipt.summary()));
                    }
                }
            });
            LRESULT(0)
        }
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut paint);
            let mode = STATE.with(|slot| slot.borrow().as_ref().map(|state| state.mode));
            let color = if mode == Some(Mode::Ungranted) {
                COLORREF(0x0000ff00)
            } else {
                COLORREF(0x00ff0000)
            };
            let brush = CreateSolidBrush(color);
            FillRect(
                dc,
                &RECT {
                    left: 30,
                    top: 25,
                    right: 430,
                    bottom: 65,
                },
                brush,
            );
            let _ = DeleteObject(HGDIOBJ(brush.0));
            let _ = EndPaint(hwnd, &paint);
            LRESULT(0)
        }
        STATUS => {
            STATE.with(|slot| {
                if let Some(state) = slot.borrow().as_ref() {
                    emit("status", Some(state.receipt.summary()));
                }
            });
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, w, l),
    }
}

pub fn run(mode: Mode) -> windows::core::Result<()> {
    unsafe {
        // Coordinates and window geometry remain in physical pixels on each display.
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)?;
        let module = GetModuleHandleW(None)?;
        let instance = HINSTANCE(module.0);
        let class = w!("F5ComputerCertificationFixture");
        let registration = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            ..Default::default()
        };
        if RegisterClassW(&registration) == 0 {
            return Err(windows::core::Error::from_thread());
        }
        let extended = if mode == Mode::Transparent {
            WS_EX_LAYERED | WS_EX_TRANSPARENT
        } else {
            WINDOW_EX_STYLE(0)
        };
        let hwnd = CreateWindowExW(
            extended,
            class,
            w!("Computer Control Windows Fixture"),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            600,
            400,
            None,
            None,
            Some(instance),
            None,
        )?;
        let control = |class: PCWSTR, label: PCWSTR, style: WINDOW_STYLE, y: i32, id: usize| {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                label,
                WS_CHILD | WS_VISIBLE | style,
                30,
                y,
                400,
                36,
                Some(hwnd),
                Some(HMENU(id as *mut _)),
                Some(instance),
                None,
            )
        };
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("Rehearsal input"),
            WS_CHILD | WS_VISIBLE,
            30,
            76,
            400,
            20,
            Some(hwnd),
            None,
            Some(instance),
            None,
        )?;
        let input = control(
            w!("EDIT"),
            w!(""),
            WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
            100,
            INPUT_ID,
        )?;
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("Rehearsal secure field"),
            WS_CHILD | WS_VISIBLE,
            30,
            136,
            400,
            20,
            Some(hwnd),
            None,
            Some(instance),
            None,
        )?;
        let secure = control(
            w!("EDIT"),
            w!(""),
            WS_BORDER | WINDOW_STYLE((ES_PASSWORD | ES_AUTOHSCROLL) as u32),
            160,
            SECURE_ID,
        )?;
        let password = SECURE_TEXT.encode_utf16().chain([0]).collect::<Vec<_>>();
        SetWindowTextW(secure, PCWSTR(password.as_ptr()))?;
        control(
            w!("BUTTON"),
            w!("Rehearsal press"),
            WINDOW_STYLE(BS_PUSHBUTTON as u32),
            220,
            PRESS_ID,
        )?;
        STATE.with(|slot| {
            *slot.borrow_mut() = Some(State {
                mode,
                input,
                secure,
                receipt: Receipt::default(),
            })
        });
        if mode == Mode::Transparent {
            SetLayeredWindowAttributes(hwnd, COLORREF(0), 128, LWA_ALPHA)?;
        }
        if mode == Mode::Shaped {
            let region = CreateEllipticRgn(0, 0, 600, 400);
            if region.0.is_null() || SetWindowRgn(hwnd, Some(region), true) == 0 {
                if !region.0.is_null() {
                    let _ = DeleteObject(HGDIOBJ(region.0));
                }
                return Err(windows::core::Error::from_thread());
            }
            // Successful SetWindowRgn transfers ownership to Windows.
        }
        let _ = ShowWindow(hwnd, SW_SHOW);
        emit(
            "ready",
            Some(serde_json::json!({ "pid": std::process::id(), "protocolVersion": 1 })),
        );
        let gui_thread = GetCurrentThreadId();
        std::thread::spawn(move || {
            // Observation/control of this fixture only. No arbitrary HWND, file,
            // shell, helper message, consent answer or input API is accepted.
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else {
                    break;
                };
                let message = match line.as_str() {
                    "status" => STATUS,
                    "close" => CLOSE_REQUEST,
                    _ => {
                        emit("invalid-command", None);
                        continue;
                    }
                };
                // A window handle can be reused after closure. Only the fixture's
                // process-lifetime GUI thread receives stdin commands; it resolves
                // its own window on that thread before closing anything.
                if PostThreadMessageW(gui_thread, message, WPARAM(0), LPARAM(0)).is_err() {
                    return;
                }
                if message == CLOSE_REQUEST {
                    return;
                }
            }
            let _ = PostThreadMessageW(gui_thread, CLOSE_REQUEST, WPARAM(0), LPARAM(0));
        });
        let mut message = MSG::default();
        loop {
            let result = GetMessageW(&mut message, None, 0, 0).0;
            if result == -1 {
                return Err(windows::core::Error::from_thread());
            }
            if result == 0 {
                break;
            }
            if message.hwnd.0.is_null() {
                match message.message {
                    STATUS => {
                        STATE.with(|slot| {
                            if let Some(state) = slot.borrow().as_ref() {
                                emit("status", Some(state.receipt.summary()));
                            }
                        });
                    }
                    CLOSE_REQUEST => DestroyWindow(hwnd)?,
                    _ => {}
                }
                continue;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        STATE.with(|slot| {
            if let Some(state) = slot.borrow_mut().take() {
                emit("closed", Some(state.receipt.summary()));
            }
        });
        Ok(())
    }
}
