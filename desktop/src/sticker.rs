use std::{fs, io::Cursor, path::Path};

use image::{ImageFormat, Rgba, RgbaImage, imageops::FilterType};

pub const STICKER_EDGE: u32 = 512;
pub const MAX_STATIC_STICKER_BYTES: usize = 100 * 1024;
pub const MAX_ANIMATED_STICKER_BYTES: usize = 500 * 1024;
const MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SOURCE_PIXELS: u64 = 100_000_000;

#[derive(Debug)]
pub struct PreparedSticker {
    pub webp_data: Vec<u8>,
}

pub fn prepare(path: &Path) -> Result<PreparedSticker, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("The selected sticker cannot be read: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("The selected sticker is not a non-empty file".into());
    }
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err("Sticker source is larger than the 32 MiB limit".into());
    }
    let source =
        fs::read(path).map_err(|error| format!("The selected sticker cannot be read: {error}"))?;
    let format = image::guess_format(&source)
        .map_err(|_| "Choose a JPEG, PNG, GIF, or WebP image".to_string())?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err("Choose a JPEG, PNG, GIF, or WebP image".into());
    }
    let dimensions = image::ImageReader::with_format(Cursor::new(&source), format)
        .into_dimensions()
        .map_err(|error| format!("Could not read sticker dimensions: {error}"))?;
    validate_dimensions(dimensions.0, dimensions.1)?;

    if format == ImageFormat::WebP && webp_is_animated(&source) {
        if dimensions != (STICKER_EDGE, STICKER_EDGE) {
            return Err("Animated WebP stickers must already be 512×512".into());
        }
        if source.len() > MAX_ANIMATED_STICKER_BYTES {
            return Err("Animated WebP stickers must be 500 KiB or smaller".into());
        }
        return Ok(PreparedSticker { webp_data: source });
    }

    let decoded = image::load_from_memory_with_format(&source, format)
        .map_err(|error| format!("Could not decode sticker image: {error}"))?
        .to_rgba8();
    let quality_steps = [82.0, 68.0, 54.0, 40.0, 28.0, 18.0];
    let edge_steps = [512_u32, 448, 384, 320, 256];
    for max_edge in edge_steps {
        let canvas = sticker_canvas(&decoded, max_edge);
        for quality in quality_steps {
            let encoded = webp::Encoder::from_rgba(canvas.as_raw(), STICKER_EDGE, STICKER_EDGE)
                .encode_simple(false, quality)
                .map_err(|error| format!("Could not encode sticker WebP: {error:?}"))?;
            if encoded.len() <= MAX_STATIC_STICKER_BYTES {
                return Ok(PreparedSticker {
                    webp_data: encoded.to_vec(),
                });
            }
        }
    }
    Err("This image could not be compressed below WhatsApp's 100 KiB sticker limit".into())
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), String> {
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if width == 0 || height == 0 || pixels > MAX_SOURCE_PIXELS {
        return Err("Sticker dimensions are invalid or too large".into());
    }
    Ok(())
}

fn sticker_canvas(source: &RgbaImage, max_edge: u32) -> RgbaImage {
    let (width, height) = source.dimensions();
    let scale = (max_edge as f64 / width as f64).min(max_edge as f64 / height as f64);
    let resized_width = ((width as f64 * scale).round() as u32).clamp(1, max_edge);
    let resized_height = ((height as f64 * scale).round() as u32).clamp(1, max_edge);
    let resized =
        image::imageops::resize(source, resized_width, resized_height, FilterType::Lanczos3);
    let mut canvas = RgbaImage::from_pixel(STICKER_EDGE, STICKER_EDGE, Rgba([0, 0, 0, 0]));
    image::imageops::overlay(
        &mut canvas,
        &resized,
        i64::from((STICKER_EDGE - resized_width) / 2),
        i64::from((STICKER_EDGE - resized_height) / 2),
    );
    canvas
}

fn webp_is_animated(data: &[u8]) -> bool {
    if data.len() < 12 || &data[..4] != b"RIFF" || &data[8..12] != b"WEBP" {
        return false;
    }
    let mut offset: usize = 12;
    while offset.checked_add(8).is_some_and(|end| end <= data.len()) {
        let kind = &data[offset..offset + 4];
        let size = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let payload_start = offset + 8;
        let Some(payload_end) = payload_start.checked_add(size) else {
            return false;
        };
        if payload_end > data.len() {
            return false;
        }
        if kind == b"ANIM" || kind == b"ANMF" {
            return true;
        }
        if kind == b"VP8X" && size >= 1 && data[payload_start] & 0x02 != 0 {
            return true;
        }
        let Some(next) = payload_end.checked_add(size % 2) else {
            return false;
        };
        offset = next;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_a_centered_size_capped_static_webp() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("wide.png");
        let source = RgbaImage::from_fn(800, 400, |x, y| {
            Rgba([(x % 255) as u8, (y % 255) as u8, ((x + y) % 255) as u8, 255])
        });
        source.save_with_format(&path, ImageFormat::Png).unwrap();

        let prepared = prepare(&path).unwrap();
        assert!(!webp_is_animated(&prepared.webp_data));
        assert!(prepared.webp_data.len() <= MAX_STATIC_STICKER_BYTES);
        assert_eq!(&prepared.webp_data[..4], b"RIFF");
        assert_eq!(&prepared.webp_data[8..12], b"WEBP");
        let decoded = image::load_from_memory(&prepared.webp_data).unwrap();
        assert_eq!(
            (decoded.width(), decoded.height()),
            (STICKER_EDGE, STICKER_EDGE)
        );
        let rgba = decoded.to_rgba8();
        assert_eq!(rgba.get_pixel(0, 0).0[3], 0);
        assert_eq!(rgba.get_pixel(STICKER_EDGE / 2, STICKER_EDGE / 2).0[3], 255);
    }

    #[test]
    fn detects_extended_animated_webp_headers() {
        let mut data = b"RIFF\x0a\x00\x00\x00WEBPVP8X\x01\x00\x00\x00\x02\x00".to_vec();
        assert!(webp_is_animated(&data));
        data[20] = 0;
        assert!(!webp_is_animated(&data));
    }
}
