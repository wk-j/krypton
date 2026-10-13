//! Font subsets for `<img>`-loaded SVG figures in the ACP harness (spec 283).
//!
//! WebKit renders an SVG image in its own page with user-installed fonts
//! disabled (`SVGImage::dataChanged` → `setShouldAllowUserInstalledFonts(false)`),
//! so `[font] family` names from krypton.toml that live in `~/Library/Fonts`
//! fall back to a generic face inside a figure. The frontend embeds the subsets
//! returned here as `@font-face` data URLs instead.

use std::collections::BTreeSet;
use std::path::PathBuf;

use base64::Engine;
use fontcull_klippa::{subset_font, Plan, SubsetFlags, DEFAULT_LAYOUT_FEATURES};
use fontcull_skrifa::raw::collections::IntSet;
use fontcull_skrifa::raw::{FileRef, FontRef};
use fontcull_skrifa::string::StringId;
use fontcull_skrifa::{MetadataProvider, Tag};
use serde::Serialize;

/// One embeddable face: the CSS family name it answers to and a base64 TrueType/OpenType subset.
#[derive(Debug, Serialize)]
pub struct SvgFontFace {
    pub family: String,
    pub data: String,
}

/// A family's default face as the OS font matcher resolves it.
struct LocatedFace {
    path: PathBuf,
    /// Picks the face inside a `.ttc` collection.
    postscript_name: String,
}

/// Printable ASCII is always requested so Latin-only figures share one subset.
fn requested_chars(text: &str) -> BTreeSet<char> {
    (' '..='~')
        .chain(text.chars().filter(|c| !c.is_control()))
        .collect()
}

/// Fonts under `/System/` (including downloadable system assets) stay usable
/// inside an SVG image, so they never need embedding.
fn is_system_font(path: &std::path::Path) -> bool {
    path.starts_with("/System/")
}

fn face_in_file<'a>(bytes: &'a [u8], postscript_name: &str) -> Option<FontRef<'a>> {
    match FileRef::new(bytes).ok()? {
        FileRef::Font(font) => Some(font),
        FileRef::Collection(collection) => collection.iter().filter_map(Result::ok).find(|font| {
            font.localized_strings(StringId::POSTSCRIPT_NAME)
                .english_or_first()
                .is_some_and(|name| name.chars().eq(postscript_name.chars()))
        }),
    }
}

/// Subset keeping the default layout features (GSUB/GPOS), so scripts that
/// need shaping — Thai mark placement, for one — still draw correctly.
fn subset(font: &FontRef, chars: &BTreeSet<char>) -> Result<Vec<u8>, String> {
    let unicodes: IntSet<u32> = chars.iter().map(|&c| u32::from(c)).collect();
    let features: IntSet<Tag> = DEFAULT_LAYOUT_FEATURES.iter().copied().collect();
    let plan = Plan::new(
        &IntSet::empty(),
        &unicodes,
        font,
        SubsetFlags::default(),
        &IntSet::empty(),
        &IntSet::all(),
        &features,
        &IntSet::empty(),
        &IntSet::empty(),
    );
    subset_font(font, &plan).map_err(|e| format!("{e:?}"))
}

/// Walk the stack the way CSS font fallback does: each family only claims the
/// characters no earlier family covers. System families claim characters but
/// are not embedded; families the OS cannot find are skipped.
fn subset_font_stack(
    families: &[String],
    text: &str,
    locate: impl Fn(&str) -> Option<LocatedFace>,
) -> Vec<SvgFontFace> {
    let mut remaining = requested_chars(text);
    let mut faces = Vec::new();
    for family in families {
        if remaining.is_empty() {
            break;
        }
        let Some(located) = locate(family) else {
            continue;
        };
        let bytes = match std::fs::read(&located.path) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::warn!("svg font {family}: read {}: {e}", located.path.display());
                continue;
            }
        };
        let Some(font) = face_in_file(&bytes, &located.postscript_name) else {
            log::warn!(
                "svg font {family}: no face {} in {}",
                located.postscript_name,
                located.path.display()
            );
            continue;
        };
        let charmap = font.charmap();
        let covered: BTreeSet<char> = remaining
            .iter()
            .copied()
            .filter(|&c| charmap.map(c).is_some())
            .collect();
        if covered.is_empty() {
            continue;
        }
        remaining.retain(|c| !covered.contains(c));
        if is_system_font(&located.path) {
            continue;
        }
        match subset(&font, &covered) {
            Ok(data) => faces.push(SvgFontFace {
                family: family.clone(),
                data: base64::engine::general_purpose::STANDARD.encode(data),
            }),
            Err(e) => log::warn!("svg font {family}: subset failed: {e}"),
        }
    }
    faces
}

#[cfg(target_os = "macos")]
fn locate_family(family: &str) -> Option<LocatedFace> {
    use objc2_core_foundation::{CFDictionary, CFString, CFURL};
    use objc2_core_text::{
        kCTFontFamilyNameAttribute, kCTFontNameAttribute, kCTFontURLAttribute, CTFontDescriptor,
    };

    let name = CFString::from_str(family);
    // SAFETY: Core Text's attribute-key statics are immutable CFStrings, and
    // every descriptor call receives valid CF objects that outlive it.
    unsafe {
        let attributes = CFDictionary::<CFString, CFString>::from_slices(
            &[kCTFontFamilyNameAttribute],
            &[&name],
        );
        let matched = CTFontDescriptor::with_attributes(attributes.as_opaque())
            .matching_font_descriptor(None)?;
        // The matcher substitutes the nearest family when the name is unknown.
        let matched_family = matched
            .attribute(kCTFontFamilyNameAttribute)?
            .downcast::<CFString>()
            .ok()?;
        if !matched_family.to_string().eq_ignore_ascii_case(family) {
            return None;
        }
        let url = matched
            .attribute(kCTFontURLAttribute)?
            .downcast::<CFURL>()
            .ok()?;
        let postscript_name = matched
            .attribute(kCTFontNameAttribute)?
            .downcast::<CFString>()
            .ok()?;
        Some(LocatedFace {
            path: url.to_file_path()?,
            postscript_name: postscript_name.to_string(),
        })
    }
}

#[cfg(not(target_os = "macos"))]
fn locate_family(_family: &str) -> Option<LocatedFace> {
    None
}

/// Subsets of the user-installed families in `families` (CSS fallback order)
/// covering printable ASCII plus every character of `text`.
#[tauri::command]
pub async fn svg_font_faces(
    families: Vec<String>,
    text: String,
) -> Result<Vec<SvgFontFace>, String> {
    tauri::async_runtime::spawn_blocking(move || subset_font_stack(&families, &text, locate_family))
        .await
        .map_err(|e| format!("svg_font_faces task: {e}"))
}
