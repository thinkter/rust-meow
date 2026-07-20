use std::{fs, io::Write as _, path::Path};

fn settings_path() -> std::path::PathBuf {
    crate::paths::config_dir().join("settings")
}

fn load_from(path: &Path) -> Option<f32> {
    fs::read_to_string(path)
        .ok()
        .and_then(|value| value.trim().parse::<f32>().ok())
}

fn save_to(path: &Path, scale: f32) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "settings path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    let existing_permissions = fs::metadata(path)
        .ok()
        .map(|metadata| metadata.permissions());
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    if let Some(permissions) = existing_permissions {
        temporary.as_file().set_permissions(permissions)?;
    }
    temporary.write_all(format!("{scale:.1}\n").as_bytes())?;
    temporary.as_file_mut().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub(crate) fn load_ui_scale() -> Option<f32> {
    load_from(&settings_path())
}

pub(crate) fn save_ui_scale(scale: f32) -> std::io::Result<()> {
    save_to(&settings_path(), scale)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{load_from, save_to};

    #[test]
    fn settings_round_trip_through_atomic_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings");
        save_to(&path, 1.2).unwrap();
        assert_eq!(load_from(&path), Some(1.2));
        save_to(&path, 1.4).unwrap();
        assert_eq!(load_from(&path), Some(1.4));
        assert_eq!(fs::read_to_string(path).unwrap(), "1.4\n");
    }

    #[cfg(unix)]
    #[test]
    fn replacement_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings");
        fs::write(&path, "1.0\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        save_to(&path, 1.3).unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}
