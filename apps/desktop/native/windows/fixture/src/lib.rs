//! Synthetic fixture state only. No helper protocol, grants or input injection.
pub const EXPECTED_TEXT: &str = "F5_WINDOWS_REHEARSAL Ω🙂";
pub const SECURE_TEXT: &str = "F5_SYNTHETIC_PASSWORD_SENTINEL";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Granted,
    Ungranted,
    Shaped,
    Transparent,
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Check,
    Run(Mode),
}

pub fn command(args: &[String]) -> Result<Command, &'static str> {
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--check"] => Ok(Command::Check),
        ["--run"] => Ok(Command::Run(Mode::Granted)),
        ["--run", "--ungranted"] => Ok(Command::Run(Mode::Ungranted)),
        ["--run", "--shaped"] => Ok(Command::Run(Mode::Shaped)),
        ["--run", "--transparent"] => Ok(Command::Run(Mode::Transparent)),
        _ => Err("Explicit --check or --run [--ungranted|--shaped|--transparent] required"),
    }
}

#[derive(Default)]
pub struct Receipt {
    pub presses: u32,
    pub input_events: u32,
    pub secure_events: u32,
    pub expected_text_received: bool,
    pub overflow: bool,
}
impl Receipt {
    pub fn press(&mut self) {
        self.presses = self.presses.saturating_add(1);
        self.overflow |= self.presses > 100;
    }
    pub fn input(&mut self, text: &[u16], secure: bool) {
        if secure {
            self.secure_events = self.secure_events.saturating_add(1);
        } else {
            self.input_events = self.input_events.saturating_add(1);
            self.expected_text_received |= text.iter().copied().eq(EXPECTED_TEXT.encode_utf16());
        }
        self.overflow |=
            text.len() > 10_000 || self.input_events > 10_000 || self.secure_events > 10_000;
    }
    pub fn summary(&self) -> serde_json::Value {
        serde_json::json!({
            "presses": self.presses.min(100),
            "inputEvents": self.input_events.min(10_000),
            "secureEvents": self.secure_events.min(10_000),
            "expectedSyntheticTextReceived": self.expected_text_received,
            "overflow": self.overflow,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn check_cannot_launch_and_run_requires_explicit_scope() {
        assert_eq!(command(&["--check".into()]), Ok(Command::Check));
        assert_eq!(command(&["--run".into()]), Ok(Command::Run(Mode::Granted)));
        for args in [
            vec![],
            vec!["--check", "--run"],
            vec!["--run", "--shell"],
            vec!["--run", "--shaped", "--transparent"],
        ] {
            assert!(command(&args.into_iter().map(String::from).collect::<Vec<_>>()).is_err());
        }
    }
    #[test]
    fn receipts_never_include_editable_or_secure_text() {
        let mut state = Receipt::default();
        state.input(
            &"PRIVATE_SENTINEL".encode_utf16().collect::<Vec<_>>(),
            false,
        );
        state.input(&SECURE_TEXT.encode_utf16().collect::<Vec<_>>(), true);
        assert!(!state.expected_text_received);
        let summary = state.summary().to_string();
        assert!(!summary.contains("PRIVATE_SENTINEL"));
        assert!(!summary.contains(SECURE_TEXT));
        assert_eq!(state.secure_events, 1);
    }
    #[test]
    fn exact_unicode_value_is_independently_observed_and_counts_are_bounded() {
        let mut state = Receipt::default();
        state.input(&EXPECTED_TEXT.encode_utf16().collect::<Vec<_>>(), false);
        assert!(state.expected_text_received);
        for _ in 0..101 {
            state.press();
        }
        assert!(state.overflow);
        assert_eq!(state.summary()["presses"], 100);
        assert!(!state.summary().to_string().contains(EXPECTED_TEXT));
    }
}
