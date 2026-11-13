use super::*;

struct Library(BackgroundManager);
impl Library {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "krypton-backgrounds-{}",
            crate::connected_computers::random_hex().unwrap()
        ));
        Self(BackgroundManager {
            root: Some(root),
            gate: Mutex::new(()),
        })
    }
    fn import(&self, bytes: &[u8]) -> ImportResult {
        self.0
            .import(
                "source.png".into(),
                base64::engine::general_purpose::STANDARD.encode(bytes),
                &self.0.read().unwrap().1,
            )
            .unwrap()
    }
}
impl Drop for Library {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.0.root().unwrap());
    }
}
fn encoded(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
    let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        width,
        height,
        image::Rgb([40, 90, 120]),
    ));
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, format).unwrap();
    out.into_inner()
}
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for b in bytes {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320_u32 & (0_u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}
fn chunk(tag: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
    bytes.extend(tag);
    bytes.extend(body);
    bytes.extend(crc32(&bytes[4..]).to_be_bytes());
    bytes
}

#[test]
fn defaults_and_backward_read_do_not_write() {
    let lib = Library::new();
    let (m, revision) = lib.0.read().unwrap();
    assert!(matches!(m.active.source, BackgroundSource::Desktop));
    assert!(!m.permission_rule.enabled);
    assert_eq!(revision, hash(&[]));
    assert!(!lib.0.root().unwrap().exists());
    let mut json = serde_json::to_value(m).unwrap();
    json.as_object_mut().unwrap().remove("permissionRule");
    fs::create_dir_all(lib.0.root().unwrap()).unwrap();
    let bytes = serde_json::to_vec(&json).unwrap();
    fs::write(lib.0.owned("library.json").unwrap(), &bytes).unwrap();
    assert!(!lib.0.read().unwrap().0.permission_rule.enabled);
    assert_eq!(
        fs::read(lib.0.owned("library.json").unwrap()).unwrap(),
        bytes
    );
}

#[test]
fn validates_choice_rule_and_strict_relative_metadata() {
    let lib = Library::new();
    let mut m = Manifest::default();
    m.active.source = BackgroundSource::Solid {
        color: "red;opacity:0".into(),
    };
    assert!(lib.0.validate(&m).is_err());
    m.active.source = BackgroundSource::Solid {
        color: "#aBc123".into(),
    };
    assert!(lib.0.validate(&m).is_ok());
    m.active.opacity = f64::NAN;
    assert!(lib.0.validate(&m).is_err());
    m.active.opacity = 1.0;
    m.active.dimming = 0.91;
    assert!(lib.0.validate(&m).is_err());
    m.active = BackgroundChoice::default();
    m.permission_rule.enabled = true;
    assert!(lib.0.validate(&m).is_err());
    m.permission_rule.target = Some(BackgroundChoice::default());
    assert!(lib.0.validate(&m).is_ok());
    assert!(lib.0.owned("../escape.png").is_err());
    assert!(lib.0.owned("/etc/passwd").is_err());
    assert!(serde_json::from_str::<BackgroundChoice>(r##"{"source":{"kind":"solid","color":"#123456","url":"file:///etc/passwd"},"fit":"cover","anchor":"center","opacity":1,"dimming":0}"##).is_err());
}

#[test]
fn imports_supported_bytes_not_extension_and_survives_restart() {
    let lib = Library::new();
    for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
        let bytes = encoded(format, 640, 320);
        let result = lib
            .0
            .import(
                "/not/retained/spoof.svg".into(),
                base64::engine::general_purpose::STANDARD.encode(&bytes),
                &lib.0.read().unwrap().1,
            )
            .unwrap();
        let asset = result
            .state
            .assets
            .iter()
            .find(|a| a.id == result.asset_id)
            .unwrap();
        assert_eq!(asset.name, "spoof.svg");
        assert_eq!(asset.width, 640);
        assert_eq!(fs::read(&asset.image_path).unwrap(), bytes);
        let thumbnail = ImageReader::open(&asset.thumbnail_path)
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!((thumbnail.width(), thumbnail.height()), (320, 160));
    }
    let restarted = BackgroundManager {
        root: lib.0.root.clone(),
        gate: Mutex::new(()),
    };
    let (m, revision) = restarted.read().unwrap();
    assert_eq!(m.assets.len(), 3);
    let disk = fs::read_to_string(lib.0.owned("library.json").unwrap()).unwrap();
    assert!(!disk.contains(lib.0.root().unwrap().to_str().unwrap()));
    assert!(!disk.contains("/not/retained"));
    assert_eq!(revision, hash(disk.as_bytes()));
}

#[test]
fn duplicate_imports_are_idempotent_even_at_the_entry_limit() {
    let lib = Library::new();
    let bytes = encoded(ImageFormat::Png, 2, 2);
    let first = lib.import(&bytes);
    let duplicate = lib.import(&bytes);
    assert_eq!(duplicate.asset_id, first.asset_id);
    assert_eq!(duplicate.state.revision, first.state.revision);
    let (mut m, _) = lib.0.read().unwrap();
    let template = m.assets[0].clone();
    for index in 1..ENTRY_LIMIT {
        let id = hash(&index.to_be_bytes());
        m.assets.push(StoredAsset {
            id: id.clone(),
            image: format!("images/{id}.png"),
            thumbnail: format!("thumbnails/{id}.png"),
            ..template.clone()
        });
    }
    lib.0.commit(m).unwrap();
    assert_eq!(lib.import(&bytes).state.assets.len(), 100);
    let other = encoded(ImageFormat::Png, 3, 3);
    assert!(lib
        .0
        .import(
            "other.png".into(),
            base64::engine::general_purpose::STANDARD.encode(other),
            &lib.0.read().unwrap().1
        )
        .err()
        .unwrap()
        .contains("full"));
}

#[test]
fn rejects_corrupt_unsupported_animated_and_oversized_inputs_without_committing() {
    let lib = Library::new();
    let revision = lib.0.read().unwrap().1;
    for bytes in [b"<svg/>".as_slice(), b"GIF89a", b"\x89PNG\r\n\x1a\ncorrupt"] {
        assert!(lib
            .0
            .import(
                "fake.png".into(),
                base64::engine::general_purpose::STANDARD.encode(bytes),
                &revision
            )
            .is_err());
    }
    let oversized = "A".repeat(SOURCE_LIMIT.div_ceil(3) * 4 + 1);
    assert!(lib
        .0
        .import("big.png".into(), oversized, &revision)
        .is_err());
    let png = encoded(ImageFormat::Png, 1, 1);
    let mut apng = png[..33].to_vec();
    apng.extend(chunk(b"acTL", &[0, 0, 0, 1, 0, 0, 0, 0]));
    apng.extend(&png[33..]);
    assert!(decode_static(&apng).unwrap_err().contains("Animated PNG"));
    for (w, h) in [(8193_u32, 1_u32), (8192, 8192), (0, 1)] {
        let mut bad = png.clone();
        bad[16..20].copy_from_slice(&w.to_be_bytes());
        bad[20..24].copy_from_slice(&h.to_be_bytes());
        let crc = crc32(&bad[12..29]);
        bad[29..33].copy_from_slice(&crc.to_be_bytes());
        assert!(decode_static(&bad).is_err());
    }
    let webp = encoded(ImageFormat::WebP, 1, 1);
    let mut forged = webp.clone();
    forged[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(decode_static(&forged).is_err());
    let mut body = b"WEBPVP8X".to_vec();
    body.extend(10_u32.to_le_bytes());
    body.extend([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // animation flag
    body.extend(&webp[12..]);
    let mut animated = b"RIFF".to_vec();
    animated.extend((body.len() as u32).to_le_bytes());
    animated.extend(body);
    assert!(decode_static(&animated)
        .unwrap_err()
        .contains("Animated WebP"));
    assert!(!lib.0.root().unwrap().exists());
}

#[test]
fn bounds_webp_encoded_frame_as_well_as_extended_canvas_before_decoding() {
    fn riff(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut body = b"WEBP".to_vec();
        for (tag, data) in chunks {
            body.extend(*tag);
            body.extend((data.len() as u32).to_le_bytes());
            body.extend(data);
            if data.len() % 2 != 0 {
                body.push(0);
            }
        }
        let mut result = b"RIFF".to_vec();
        result.extend((body.len() as u32).to_le_bytes());
        result.extend(body);
        result
    }
    let canvas = vec![0; 10]; // 1×1 canvas
    for (w, h, expected) in [
        (8193_u16, 1_u16, "at most"),
        (8192, 8192, "at most"),
        (2, 1, "disagree"),
    ] {
        let mut frame = vec![0, 0, 0, 0x9d, 0x01, 0x2a];
        frame.extend(w.to_le_bytes());
        frame.extend(h.to_le_bytes());
        let bytes = riff(&[(b"VP8X", canvas.clone()), (b"VP8 ", frame)]);
        assert!(validate_webp_container(&bytes)
            .unwrap_err()
            .contains(expected));
    }
    let mut lossless = vec![0x2f];
    lossless.extend((8191_u32 | (8191_u32 << 14)).to_le_bytes());
    assert!(
        validate_webp_container(&riff(&[(b"VP8X", canvas), (b"VP8L", lossless)]))
            .unwrap_err()
            .contains("at most")
    );
}

#[test]
fn thumbnail_matches_jpeg_exif_orientation() {
    let jpeg = encoded(ImageFormat::Jpeg, 4, 2);
    // APP1: Exif + little-endian TIFF, one Orientation SHORT = 6 (90° CW).
    let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut oriented = jpeg[..2].to_vec();
    oriented.extend([0xff, 0xe1]);
    oriented.extend(((exif.len() + 2) as u16).to_be_bytes());
    oriented.extend(exif);
    oriented.extend(&jpeg[2..]);
    let lib = Library::new();
    let result = lib.import(&oriented);
    let a = &result.state.assets[0];
    assert_eq!((a.width, a.height), (2, 4));
    let thumb = ImageReader::open(&a.thumbnail_path)
        .unwrap()
        .decode()
        .unwrap();
    assert_eq!((thumb.width(), thumb.height()), (2, 4));
    assert_eq!(fs::read(&a.image_path).unwrap(), oriented);
}

#[test]
fn revision_conflict_and_failed_atomic_write_preserve_committed_manifest() {
    let lib = Library::new();
    let bytes = encoded(ImageFormat::Png, 1, 1);
    let first = lib.import(&bytes);
    assert!(lib.0.expected(&hash(&[])).unwrap_err().contains("Refresh"));
    let path = lib.0.owned("library.json").unwrap();
    let committed = fs::read(&path).unwrap();
    let directory = lib.0.root().unwrap().join("cannot-replace-directory");
    fs::create_dir(&directory).unwrap();
    assert!(atomic_write(&directory, b"new state").is_err());
    assert_eq!(fs::read(path).unwrap(), committed);
    assert_eq!(lib.0.read().unwrap().1, first.state.revision);
    assert!(!fs::read_dir(lib.0.root().unwrap()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
}

#[test]
fn malformed_and_unknown_versions_are_preserved_not_silently_reset() {
    for bytes in [
        b"not json".as_slice(),
        b"{\"version\":99,\"active\":{},\"assets\":[]}",
    ] {
        let lib = Library::new();
        fs::create_dir_all(lib.0.root().unwrap()).unwrap();
        let path = lib.0.owned("library.json").unwrap();
        fs::write(&path, bytes).unwrap();
        assert!(lib.0.read().is_err());
        assert!(lib.0.expected(&hash(bytes)).is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    let lib = Library::new();
    let m = Manifest {
        version: 2,
        ..Manifest::default()
    };
    assert!(lib.0.commit(m).is_err());
    assert!(!lib.0.root().unwrap().exists());
}

#[test]
fn removing_shared_asset_repairs_base_and_rule_but_never_removes_source() {
    let lib = Library::new();
    let bytes = encoded(ImageFormat::Png, 1, 2);
    let source = std::env::temp_dir().join(format!(
        "krypton-source-{}.png",
        crate::connected_computers::random_hex().unwrap()
    ));
    fs::write(&source, &bytes).unwrap();
    let result = lib.import(&bytes);
    let owned = result.state.assets[0].image_path.clone();
    let (mut m, _) = lib.0.read().unwrap();
    m.active.source = BackgroundSource::Image {
        asset_id: result.asset_id.clone(),
    };
    m.permission_rule = PermissionRule {
        enabled: true,
        target: Some(m.active.clone()),
    };
    let state = lib.0.commit(m).unwrap();
    let removed = lib.0.remove(&result.asset_id, &state.revision).unwrap();
    assert!(matches!(
        removed.state.active.source,
        BackgroundSource::Desktop
    ));
    assert!(!removed.state.permission_rule.enabled);
    assert!(removed.state.permission_rule.target.is_none());
    assert!(removed.state.assets.is_empty());
    assert!(!Path::new(&owned).exists());
    assert_eq!(fs::read(&source).unwrap(), bytes);
    fs::remove_file(source).unwrap();
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_roots_files_directories_and_manifest_paths() {
    use std::os::unix::fs::symlink;
    let outside = Library::new();
    fs::create_dir_all(outside.0.root().unwrap()).unwrap();
    let lib = Library::new();
    fs::create_dir_all(lib.0.root().unwrap()).unwrap();
    symlink(
        outside.0.root().unwrap(),
        lib.0.root().unwrap().join("images"),
    )
    .unwrap();
    assert!(lib.0.owned("images/a.png").is_err());
    symlink(
        outside.0.root().unwrap().join("anything"),
        lib.0.root().unwrap().join("library.json"),
    )
    .unwrap();
    assert!(lib.0.read().is_err());
    let root_link = Library::new();
    symlink(outside.0.root().unwrap(), root_link.0.root().unwrap()).unwrap();
    assert!(root_link.0.read().is_err());
    fs::remove_file(root_link.0.root().unwrap()).unwrap();
    let clean = Library::new();
    let result = clean.import(&encoded(ImageFormat::Png, 1, 1));
    let image = &result.state.assets[0].image_path;
    fs::remove_file(image).unwrap();
    symlink(outside.0.root().unwrap().join("source"), image).unwrap();
    assert!(clean.0.read().is_err());
}
