use std::{env, ffi::OsString, path::PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DirectoryKind {
    Config,
    Data,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Platform {
    Linux,
    MacOs,
    Windows,
}

fn current_platform() -> Platform {
    if cfg!(target_os = "windows") {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::MacOs
    } else {
        Platform::Linux
    }
}

fn resolve_app_dir(
    kind: DirectoryKind,
    platform: Platform,
    mut variable: impl FnMut(&str) -> Option<OsString>,
    fallback: PathBuf,
) -> PathBuf {
    let override_name = match kind {
        DirectoryKind::Config => "RUST_MEOW_CONFIG_DIR",
        DirectoryKind::Data => "RUST_MEOW_DATA_DIR",
    };
    if let Some(path) = variable(override_name) {
        return path.into();
    }

    let base = match platform {
        Platform::Windows => variable(match kind {
            DirectoryKind::Config => "APPDATA",
            DirectoryKind::Data => "LOCALAPPDATA",
        })
        .map(PathBuf::from),
        Platform::MacOs => variable("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("Library/Application Support")),
        Platform::Linux => variable(match kind {
            DirectoryKind::Config => "XDG_CONFIG_HOME",
            DirectoryKind::Data => "XDG_DATA_HOME",
        })
        .map(PathBuf::from)
        .or_else(|| {
            variable("HOME").map(PathBuf::from).map(|home| {
                home.join(match kind {
                    DirectoryKind::Config => ".config",
                    DirectoryKind::Data => ".local/share",
                })
            })
        }),
    };
    base.unwrap_or(fallback).join("rust-meow")
}

pub(crate) fn config_dir() -> PathBuf {
    resolve_app_dir(
        DirectoryKind::Config,
        current_platform(),
        |name| env::var_os(name),
        env::temp_dir(),
    )
}

pub(crate) fn data_dir() -> PathBuf {
    resolve_app_dir(
        DirectoryKind::Data,
        current_platform(),
        |name| env::var_os(name),
        env::temp_dir(),
    )
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, ffi::OsString, path::PathBuf};

    use super::{DirectoryKind, Platform, resolve_app_dir};

    fn resolve(kind: DirectoryKind, platform: Platform, entries: &[(&str, &str)]) -> PathBuf {
        let variables: HashMap<&str, OsString> = entries
            .iter()
            .map(|(key, value)| (*key, OsString::from(value)))
            .collect();
        resolve_app_dir(
            kind,
            platform,
            |name| variables.get(name).cloned(),
            PathBuf::from("/tmp"),
        )
    }

    #[test]
    fn explicit_overrides_win_on_every_platform() {
        assert_eq!(
            resolve(
                DirectoryKind::Config,
                Platform::Windows,
                &[
                    ("RUST_MEOW_CONFIG_DIR", "/custom/config"),
                    ("APPDATA", "C:/Users/me")
                ],
            ),
            PathBuf::from("/custom/config")
        );
        assert_eq!(
            resolve(
                DirectoryKind::Data,
                Platform::MacOs,
                &[
                    ("RUST_MEOW_DATA_DIR", "/custom/data"),
                    ("HOME", "/Users/me")
                ],
            ),
            PathBuf::from("/custom/data")
        );
    }

    #[test]
    fn platform_defaults_are_centralized() {
        assert_eq!(
            resolve(
                DirectoryKind::Config,
                Platform::Linux,
                &[("HOME", "/home/me")]
            ),
            PathBuf::from("/home/me/.config/rust-meow")
        );
        assert_eq!(
            resolve(
                DirectoryKind::Data,
                Platform::Linux,
                &[("XDG_DATA_HOME", "/data")]
            ),
            PathBuf::from("/data/rust-meow")
        );
        assert_eq!(
            resolve(
                DirectoryKind::Config,
                Platform::MacOs,
                &[("HOME", "/Users/me")]
            ),
            PathBuf::from("/Users/me/Library/Application Support/rust-meow")
        );
        assert_eq!(
            resolve(
                DirectoryKind::Data,
                Platform::Windows,
                &[("LOCALAPPDATA", "C:/Local")]
            ),
            PathBuf::from("C:/Local/rust-meow")
        );
    }
}
