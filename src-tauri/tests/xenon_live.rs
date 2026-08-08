// Wire-compatibility test between Krypton's Xenon publisher and a real Xenon
// server (spec 212).
//
// Ignored by default because it needs a running server. The two halves live in
// separate repos, so nothing else catches a drift in the manifest shape, the
// `missing`/`unchanged` contract, or the commit handshake — a unit test against
// a mock would just re-assert our own assumptions.
//
//   cd ~/Source/xenon && cargo build
//   XENON_PORT=8791 XENON_DATA_DIR=/tmp/x XENON_SESSION_SECRET=$(openssl rand -hex 32) \
//     XENON_INSECURE_COOKIES=1 ./target/debug/xenon &
//   # register at http://127.0.0.1:8791/register, mint a token, then:
//   XENON_TEST_URL=http://127.0.0.1:8791 XENON_TEST_TOKEN=xen_... \
//     cargo test --test xenon_live -- --ignored --nocapture

use std::collections::BTreeMap;

use app_lib::xenon::{LocalResource, Publisher, PushOutcome, ResourceManifest};

fn publisher(force: bool) -> Option<Publisher> {
    let url = std::env::var("XENON_TEST_URL").ok()?;
    let token = std::env::var("XENON_TEST_TOKEN").ok()?;
    Publisher::with_token(&url, &token, "krypton-live-test", force).ok()
}

fn resource(kind: &str, slug: &str, files: &[(&str, &[u8])]) -> LocalResource {
    let mut inline = BTreeMap::new();
    for (path, bytes) in files {
        inline.insert((*path).to_string(), bytes.to_vec());
    }
    LocalResource {
        manifest: ResourceManifest {
            kind: kind.to_string(),
            slug: slug.to_string(),
            title: format!("live test {slug}"),
            origin: serde_json::json!({ "hostname": "test" }),
            meta: serde_json::json!({ "lane": "Claude-2" }),
            files: Vec::new(),
        },
        sources: BTreeMap::new(),
        inline,
    }
}

#[tokio::test]
#[ignore = "requires a running Xenon server (see the header comment)"]
async fn publisher_speaks_the_servers_protocol() {
    let Some(publisher) = publisher(false) else {
        panic!("set XENON_TEST_URL and XENON_TEST_TOKEN");
    };

    // Unique per run so repeated runs exercise create-then-update, not a
    // pre-seeded fixture.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let slug = format!("2026-08-07-live-{stamp}");

    // 1. First push: manifest → blobs → commit.
    let first = publisher
        .push_resource(resource(
            "review",
            &slug,
            &[
                ("review.md", b"# review\n\nfirst\n"),
                ("response.md", b"note: thinking\n"),
            ],
        ))
        .await;
    match &first.outcome {
        PushOutcome::Pushed { url, uploaded } => {
            assert_eq!(*uploaded, 2, "both blobs are new on a first push");
            assert!(
                url.contains(&slug),
                "permalink should name the resource: {url}"
            );
        }
        other => panic!("expected a push, got {other:?}"),
    }

    // 2. Identical re-push must short-circuit without transferring anything.
    let repeat = publisher
        .push_resource(resource(
            "review",
            &slug,
            &[
                ("review.md", b"# review\n\nfirst\n"),
                ("response.md", b"note: thinking\n"),
            ],
        ))
        .await;
    assert!(
        matches!(repeat.outcome, PushOutcome::Unchanged { .. }),
        "identical content must be reported unchanged, got {:?}",
        repeat.outcome
    );

    // 3. Editing one file uploads exactly one blob — the dedupe claim.
    let edited = publisher
        .push_resource(resource(
            "review",
            &slug,
            &[
                ("review.md", b"# review\n\nfirst\n"),
                ("response.md", b"note: ship it\n"),
            ],
        ))
        .await;
    match &edited.outcome {
        PushOutcome::Pushed { uploaded, .. } => {
            assert_eq!(*uploaded, 1, "only the changed file should transfer");
        }
        other => panic!("expected a push, got {other:?}"),
    }

    // 4. A fileless attention record round-trips.
    let attention = publisher
        .push_resource(resource("attention", &format!("jdg-live-{stamp}"), &[]))
        .await;
    assert!(
        matches!(attention.outcome, PushOutcome::Pushed { .. }),
        "a fileless resource must still commit, got {:?}",
        attention.outcome
    );
}

#[tokio::test]
#[ignore = "requires a running Xenon server (see the header comment)"]
async fn secret_scan_blocks_before_anything_leaves_the_machine() {
    let Some(publisher) = publisher(false) else {
        panic!("set XENON_TEST_URL and XENON_TEST_TOKEN");
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let blocked = publisher
        .push_resource(resource(
            "review",
            &format!("2026-08-07-secret-{stamp}"),
            &[(
                "review.md",
                b"token = ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
            )],
        ))
        .await;
    match &blocked.outcome {
        PushOutcome::Blocked { reason } => assert!(reason.contains("GitHub token"), "{reason}"),
        other => panic!("a credential must be blocked, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires a running Xenon server (see the header comment)"]
async fn a_bad_token_fails_without_being_queued_for_retry() {
    let Some(url) = std::env::var("XENON_TEST_URL").ok() else {
        panic!("set XENON_TEST_URL");
    };
    let publisher = Publisher::with_token(
        &url,
        "xen_aaaaaaaaaaaa_bbbbbbbbbbbb",
        "krypton-live-test",
        false,
    )
    .unwrap();

    let item = publisher
        .push_resource(resource("review", "2026-08-07-bad-token", &[]))
        .await;
    match &item.outcome {
        PushOutcome::Failed { retryable, reason } => {
            assert!(
                !retryable,
                "an auth failure must not be retried forever: {reason}"
            );
            assert!(
                reason.contains("settings/tokens"),
                "should point at the fix: {reason}"
            );
        }
        other => panic!("expected an auth failure, got {other:?}"),
    }
}
