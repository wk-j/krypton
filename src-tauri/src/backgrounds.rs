//! Spec 395: local, revisioned workspace-background library. No config/theme writes.
use std::{
    fs::{self, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use base64::Engine;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SOURCE_LIMIT: usize = 10 * 1024 * 1024;
const PIXEL_LIMIT: u64 = 16_777_216;
const ENTRY_LIMIT: usize = 100;
const MANIFEST_LIMIT: u64 = 256 * 1024;

#[cfg(test)]
#[path = "backgrounds_tests.rs"]
mod tests;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum BackgroundSource {
    Desktop,
    Solid {
        color: String,
    },
    Gradient {
        from: String,
        to: String,
        angle: u16,
    },
    Image {
        #[serde(rename = "assetId")]
        asset_id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    Cover,
    Contain,
    Stretch,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Anchor {
    TopLeft,
    Top,
    TopRight,
    Left,
    Center,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundChoice {
    source: BackgroundSource,
    fit: Fit,
    anchor: Anchor,
    opacity: f64,
    dimming: f64,
}
impl Default for BackgroundChoice {
    fn default() -> Self {
        Self {
            source: BackgroundSource::Desktop,
            fit: Fit::Cover,
            anchor: Anchor::Center,
            opacity: 1.0,
            dimming: 0.0,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionRule {
    enabled: bool,
    target: Option<BackgroundChoice>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAsset {
    id: String,
    name: String,
    image: String,
    thumbnail: String,
    width: u32,
    height: u32,
    bytes: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u8,
    active: BackgroundChoice,
    #[serde(default)]
    permission_rule: PermissionRule,
    assets: Vec<StoredAsset>,
}
impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: 1,
            active: BackgroundChoice::default(),
            permission_rule: PermissionRule::default(),
            assets: Vec::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    id: String,
    name: String,
    image_path: String,
    thumbnail_path: String,
    width: u32,
    height: u32,
    bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundState {
    version: u8,
    revision: String,
    active: BackgroundChoice,
    permission_rule: PermissionRule,
    assets: Vec<Asset>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    state: BackgroundState,
    asset_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    state: BackgroundState,
    cleanup_warning: Option<String>,
}

pub struct BackgroundManager {
    root: Option<PathBuf>,
    gate: Mutex<()>,
}
impl BackgroundManager {
    pub fn new() -> Self {
        Self {
            root: crate::config::config_dir().map(|p| p.join("backgrounds")),
            gate: Mutex::new(()),
        }
    }
    fn root(&self) -> Result<&Path, String> {
        self.root
            .as_deref()
            .ok_or_else(|| "Cannot locate Krypton's configuration directory".into())
    }
    /// All paths are generated/validated relative names. Reject symlinks even when
    /// they point back inside the root: display paths are never mutation authority.
    fn owned(&self, relative: &str) -> Result<PathBuf, String> {
        let root = self.root()?;
        if Path::new(relative)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Invalid background-library path".into());
        }
        for path in [
            root.to_path_buf(),
            root.join(relative).parent().unwrap_or(root).to_path_buf(),
            root.join(relative),
        ] {
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(
                        "Background library contains a symlink; repair it before continuing".into(),
                    )
                }
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
                _ => {}
            }
        }
        Ok(root.join(relative))
    }
    fn read(&self) -> Result<(Manifest, String), String> {
        let path = self.owned("library.json")?;
        let bytes = match fs::File::open(path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(MANIFEST_LIMIT + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() as u64 > MANIFEST_LIMIT {
                    return Err("Background manifest is too large; repair library.json".into());
                }
                bytes
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok((Manifest::default(), hash(&[])))
            }
            Err(e) => return Err(e.to_string()),
        };
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Repair backgrounds/library.json before saving: {e}"))?;
        self.validate(&manifest)?;
        Ok((manifest, hash(&bytes)))
    }
    fn validate(&self, m: &Manifest) -> Result<(), String> {
        if m.version != 1 {
            return Err("Unsupported background manifest version; file preserved".into());
        }
        if m.assets.len() > ENTRY_LIMIT {
            return Err("Background library exceeds 100 images".into());
        }
        let mut ids = std::collections::HashSet::new();
        for a in &m.assets {
            if !valid_id(&a.id)
                || !ids.insert(&a.id)
                || a.name.is_empty()
                || a.name.chars().count() > 120
                || a.name.contains(['/', '\\'])
                || a.name.chars().any(char::is_control)
                || !valid_dimensions(a.width, a.height)
                || a.bytes == 0
                || a.bytes > SOURCE_LIMIT
                || !["png", "jpg", "webp"]
                    .iter()
                    .any(|ext| a.image == format!("images/{}.{}", a.id, ext))
                || a.thumbnail != format!("thumbnails/{}.png", a.id)
            {
                return Err("Invalid background asset in library.json; file preserved".into());
            }
            self.owned(&a.image)?;
            self.owned(&a.thumbnail)?;
        }
        validate_choice(&m.active, &m.assets)?;
        if m.permission_rule.enabled && m.permission_rule.target.is_none() {
            return Err("Choose a permission background before enabling the rule".into());
        }
        if let Some(target) = &m.permission_rule.target {
            validate_choice(target, &m.assets)?;
        }
        Ok(())
    }
    fn project(&self, m: Manifest, revision: String) -> Result<BackgroundState, String> {
        let mut assets = Vec::new();
        for a in m.assets {
            assets.push(Asset {
                image_path: self.owned(&a.image)?.to_string_lossy().into_owned(),
                thumbnail_path: self.owned(&a.thumbnail)?.to_string_lossy().into_owned(),
                id: a.id,
                name: a.name,
                width: a.width,
                height: a.height,
                bytes: a.bytes,
            });
        }
        Ok(BackgroundState {
            version: m.version,
            revision,
            active: m.active,
            permission_rule: m.permission_rule,
            assets,
        })
    }
    fn expected(&self, revision: &str) -> Result<Manifest, String> {
        let (m, current) = self.read()?;
        if current != revision {
            return Err("Background library changed; Refresh and retry your change".into());
        }
        Ok(m)
    }
    fn commit(&self, m: Manifest) -> Result<BackgroundState, String> {
        self.validate(&m)?;
        let bytes = serde_json::to_vec_pretty(&m).map_err(|e| e.to_string())?;
        fs::create_dir_all(self.root()?).map_err(|e| e.to_string())?;
        atomic_write(&self.owned("library.json")?, &bytes)?;
        self.project(m, hash(&bytes))
    }
    fn import(
        &self,
        name: String,
        encoded: String,
        revision: &str,
    ) -> Result<ImportResult, String> {
        let mut m = self.expected(revision)?;
        if encoded.len() > SOURCE_LIMIT.div_ceil(3) * 4 {
            return Err("Image exceeds 10 MiB; choose a smaller file".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid image encoding")?;
        if bytes.len() > SOURCE_LIMIT {
            return Err("Image exceeds 10 MiB".into());
        }
        let id = hash(&bytes);
        if m.assets.iter().any(|a| a.id == id) {
            let (_, revision) = self.read()?;
            return Ok(ImportResult {
                state: self.project(m, revision)?,
                asset_id: id,
            });
        }
        if m.assets.len() >= ENTRY_LIMIT {
            return Err("Library is full (100 images); remove an image first".into());
        }
        let (image, ext) = decode_static(&bytes)?;
        let width = image.width();
        let height = image.height();
        let thumbnail = if width <= 320 && height <= 320 {
            image.clone()
        } else {
            image.thumbnail(320, 320)
        };
        let mut png = Cursor::new(Vec::new());
        thumbnail
            .write_to(&mut png, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let image_name = format!("images/{id}.{ext}");
        let thumb_name = format!("thumbnails/{id}.png");
        let image_path = self.owned(&image_name)?;
        let thumb_path = self.owned(&thumb_name)?;
        fs::create_dir_all(image_path.parent().ok_or("Invalid image directory")?)
            .map_err(|e| e.to_string())?;
        fs::create_dir_all(thumb_path.parent().ok_or("Invalid thumbnail directory")?)
            .map_err(|e| e.to_string())?;
        atomic_write(&image_path, &bytes)?;
        atomic_write(&thumb_path, png.get_ref())?;
        let name: String = name
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("Image")
            .chars()
            .filter(|c| !c.is_control())
            .take(120)
            .collect();
        m.assets.push(StoredAsset {
            id: id.clone(),
            name: if name.is_empty() {
                "Image".into()
            } else {
                name
            },
            image: image_name,
            thumbnail: thumb_name,
            width,
            height,
            bytes: bytes.len(),
        });
        // Decode/IO may take time: detect external edits again at commit, too.
        self.expected(revision)?;
        Ok(ImportResult {
            state: self.commit(m)?,
            asset_id: id,
        })
    }
    fn remove(&self, id: &str, revision: &str) -> Result<RemoveResult, String> {
        let mut m = self.expected(revision)?;
        let index = m
            .assets
            .iter()
            .position(|a| a.id == id)
            .ok_or("Image is no longer in the library")?;
        let a = m.assets.remove(index);
        if references(&m.active, id) {
            m.active = BackgroundChoice::default();
        }
        if m.permission_rule
            .target
            .as_ref()
            .is_some_and(|c| references(c, id))
        {
            m.permission_rule = PermissionRule::default();
        }
        let state = self.commit(m)?;
        let mut warnings = Vec::new();
        for name in [&a.image, &a.thumbnail] {
            let result = self
                .owned(name)
                .and_then(|p| fs::remove_file(p).map_err(|e| e.to_string()));
            if let Err(e) = result {
                warnings.push(e);
            }
        }
        Ok(RemoveResult {
            state,
            cleanup_warning: if warnings.is_empty() {
                None
            } else {
                Some(format!(
                    "Image removed; owned-file cleanup needs attention: {}",
                    warnings.join("; ")
                ))
            },
        })
    }
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}
fn valid_dimensions(w: u32, h: u32) -> bool {
    w > 0 && h > 0 && w <= 8192 && h <= 8192 && u64::from(w) * u64::from(h) <= PIXEL_LIMIT
}
fn references(c: &BackgroundChoice, id: &str) -> bool {
    matches!(&c.source, BackgroundSource::Image { asset_id } if asset_id == id)
}
fn validate_choice(c: &BackgroundChoice, assets: &[StoredAsset]) -> Result<(), String> {
    let source_ok = match &c.source {
        BackgroundSource::Desktop => true,
        BackgroundSource::Solid { color: c } => color(c),
        BackgroundSource::Gradient { from, to, angle } => {
            *angle == 135
                && [("#101828", "#302338"), ("#06131e", "#12383b")]
                    .contains(&(from.as_str(), to.as_str()))
        }
        BackgroundSource::Image { asset_id } => {
            valid_id(asset_id) && assets.iter().any(|a| a.id == *asset_id)
        }
    };
    if !source_ok
        || !c.opacity.is_finite()
        || !(0.0..=1.0).contains(&c.opacity)
        || !c.dimming.is_finite()
        || !(0.0..=0.9).contains(&c.dimming)
    {
        return Err(
            "Invalid background choice; use a library image, preset gradient or #RRGGBB colour"
                .into(),
        );
    }
    Ok(())
}

fn decode_static(bytes: &[u8]) -> Result<(DynamicImage, &'static str), String> {
    let format =
        image::guess_format(bytes).map_err(|_| "Choose a PNG, JPEG or static WebP image")?;
    let ext = match format {
        ImageFormat::Png => {
            let decoder =
                image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes), decode_limits())
                    .map_err(|e| e.to_string())?;
            if decoder.is_apng().map_err(|e| e.to_string())? {
                return Err("Animated PNG is not supported; choose a static image".into());
            }
            "png"
        }
        ImageFormat::Jpeg => "jpg",
        ImageFormat::WebP => {
            validate_webp_container(bytes)?;
            if image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
                .map_err(|e| e.to_string())?
                .has_animation()
            {
                return Err("Animated WebP is not supported; choose a static image".into());
            }
            "webp"
        }
        _ => return Err("Choose a PNG, JPEG or static WebP image (not GIF, SVG or video)".into()),
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(decode_limits());
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("Cannot read image: {e}"))?;
    let (width, height) = decoder.dimensions();
    if !valid_dimensions(width, height) {
        return Err("Image must be at most 8192px per axis and 16,777,216 pixels".into());
    }
    // Browsers orient the preserved source via EXIF. Match that for thumbnails.
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image =
        DynamicImage::from_decoder(decoder).map_err(|e| format!("Cannot decode image: {e}"))?;
    image.apply_orientation(orientation);
    Ok((image, ext))
}
/// Bound RIFF ranges before the decoder/EXIF reader sees them. A tiny encoded
/// file must not reserve memory for a forged, multi-gigabyte metadata chunk.
fn validate_webp_container(bytes: &[u8]) -> Result<(), String> {
    let size = bytes
        .get(4..8)
        .and_then(|s| <[u8; 4]>::try_from(s).ok())
        .map(u32::from_le_bytes)
        .ok_or("Truncated WebP header")? as usize;
    if size.checked_add(8) != Some(bytes.len()) || bytes.len() < 12 {
        return Err("Truncated or corrupt WebP container".into());
    }
    let mut offset = 12_usize;
    let mut canvas = None;
    let mut frame = None;
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset + 8)
            .ok_or("Truncated WebP chunk")?;
        let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or("WebP chunk exceeds source bytes")?;
        if &header[..4] == b"ANIM"
            || &header[..4] == b"ANMF"
            || (&header[..4] == b"VP8X" && bytes.get(start).is_some_and(|flags| flags & 2 != 0))
        {
            return Err("Animated WebP is not supported; choose a static image".into());
        }
        let data = &bytes[start..end];
        let dimensions = match &header[..4] {
            b"VP8X" => {
                let h = data.get(..10).ok_or("Truncated extended WebP header")?;
                let w = 1 + u32::from_le_bytes([h[4], h[5], h[6], 0]);
                let height = 1 + u32::from_le_bytes([h[7], h[8], h[9], 0]);
                if canvas.replace((w, height)).is_some() {
                    return Err("Duplicate WebP canvas".into());
                }
                Some((w, height))
            }
            b"VP8 " => {
                let h = data.get(..10).ok_or("Truncated lossy WebP frame")?;
                Some((
                    u32::from(u16::from_le_bytes([h[6], h[7]]) & 0x3fff),
                    u32::from(u16::from_le_bytes([h[8], h[9]]) & 0x3fff),
                ))
            }
            b"VP8L" => {
                let h = data.get(..5).ok_or("Truncated lossless WebP frame")?;
                let bits = u32::from_le_bytes([h[1], h[2], h[3], h[4]]);
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            _ => None,
        };
        if let Some((w, h)) = dimensions {
            if !valid_dimensions(w, h) {
                return Err(
                    "WebP canvas and frame must be at most 8192px per axis and 16,777,216 pixels"
                        .into(),
                );
            }
            if (&header[..4] == b"VP8 " || &header[..4] == b"VP8L")
                && frame.replace((w, h)).is_some()
            {
                return Err("Multiple static WebP frames are not supported".into());
            }
        }
        offset = end
            .checked_add(length % 2)
            .ok_or("Invalid WebP chunk size")?;
        if offset > bytes.len() {
            return Err("Truncated WebP chunk padding".into());
        }
    }
    if let (Some(canvas), Some(frame)) = (canvas, frame) {
        if canvas != frame {
            return Err("WebP canvas and frame dimensions disagree".into());
        }
    }
    Ok(())
}

fn decode_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid background path")?;
    let temp = parent.join(format!(
        ".background-{}.tmp",
        crate::connected_computers::random_hex()?
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

async fn blocking<T: Send + 'static>(
    manager: Arc<BackgroundManager>,
    f: impl FnOnce(&BackgroundManager) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = manager
            .gate
            .lock()
            .map_err(|_| "Background library lock unavailable")?;
        f(&manager)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn background_list(
    manager: tauri::State<'_, Arc<BackgroundManager>>,
) -> Result<BackgroundState, String> {
    blocking(manager.inner().clone(), |m| {
        let (state, revision) = m.read()?;
        m.project(state, revision)
    })
    .await
}
#[tauri::command]
pub async fn background_import(
    manager: tauri::State<'_, Arc<BackgroundManager>>,
    name: String,
    data_base64: String,
    expected_revision: String,
) -> Result<ImportResult, String> {
    blocking(manager.inner().clone(), move |m| {
        m.import(name, data_base64, &expected_revision)
    })
    .await
}
#[tauri::command]
pub async fn background_apply(
    manager: tauri::State<'_, Arc<BackgroundManager>>,
    choice: BackgroundChoice,
    expected_revision: String,
) -> Result<BackgroundState, String> {
    blocking(manager.inner().clone(), move |m| {
        let mut state = m.expected(&expected_revision)?;
        state.active = choice;
        m.commit(state)
    })
    .await
}
#[tauri::command]
pub async fn background_rule_save(
    manager: tauri::State<'_, Arc<BackgroundManager>>,
    rule: PermissionRule,
    expected_revision: String,
) -> Result<BackgroundState, String> {
    blocking(manager.inner().clone(), move |m| {
        let mut state = m.expected(&expected_revision)?;
        state.permission_rule = rule;
        m.commit(state)
    })
    .await
}
#[tauri::command]
pub async fn background_reset(
    manager: tauri::State<'_, Arc<BackgroundManager>>,
    expected_revision: String,
) -> Result<BackgroundState, String> {
    blocking(manager.inner().clone(), move |m| {
        let mut state = m.expected(&expected_revision)?;
        state.active = BackgroundChoice::default();
        state.permission_rule.enabled = false;
        m.commit(state)
    })
    .await
}
#[tauri::command]
pub async fn background_remove(
    manager: tauri::State<'_, Arc<BackgroundManager>>,
    asset_id: String,
    expected_revision: String,
) -> Result<RemoveResult, String> {
    blocking(manager.inner().clone(), move |m| {
        m.remove(&asset_id, &expected_revision)
    })
    .await
}
