# 4. Non-Functional Requirements

## 4.1 Performance

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-PERF-001 | Keypress-to-render latency | < 16 ms |
| NFR-PERF-002 | Throughput for raw data output (e.g., `cat large_file`) | >= 500 MB/s parsing rate |
| NFR-PERF-003 | Application cold start time | < 500 ms |
| NFR-PERF-004 | Idle CPU usage (single session, no output) | < 1% |
| NFR-PERF-005 | Memory usage per session (idle) | < 50 MB |

## 4.2 Reliability

| ID | Requirement |
|----|-------------|
| NFR-REL-001 | The application shall not crash on malformed escape sequences; it shall silently discard or best-effort render them. |
| NFR-REL-002 | A crash in one tab/pane shall not affect other sessions. |
| NFR-REL-003 | The application shall gracefully handle shell process crashes. |

## 4.3 Portability

| ID | Requirement |
|----|-------------|
| NFR-PORT-001 | The application shall build and run on macOS (12+), Linux (X11 and Wayland), and Windows (10+). |
| NFR-PORT-002 | The application shall use platform-native webview (WebKit on macOS, WebKitGTK on Linux, WebView2 on Windows). |
| NFR-PORT-003 | The fullscreen, borderless, transparent native shell shall work correctly on all supported platforms (requires platform-specific Tauri transparency configuration). |

## 4.4 Security

| ID | Requirement |
|----|-------------|
| NFR-SEC-001 | The Tauri IPC bridge shall only expose explicitly defined commands; no arbitrary shell execution from the frontend. |
| NFR-SEC-002 | The application shall not transmit any data externally unless initiated by the user (e.g., update check opt-in). |
| NFR-SEC-003 | Clipboard access shall require explicit user action (no silent clipboard reads). |

## 4.5 Accessibility

| ID | Requirement |
|----|-------------|
| NFR-ACC-001 | The system shall support configurable font sizes and contrast ratios. |
| NFR-ACC-002 | The system shall support system-level zoom/scale settings. |
| NFR-ACC-003 | **Every feature** shall be fully operable via keyboard alone. Mouse is optional. |
| NFR-ACC-004 | The focused window and active UI element shall always have a clear visual indicator. |
| NFR-ACC-005 | Keyboard mode indicators (compositor mode, resize mode, move mode) shall be clearly displayed in the UI. |

## 4.6 Animation & Compositor Performance

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-PERF-010 | Workspace transition animation frame rate | 60 FPS constant |
| NFR-PERF-011 | Workspace switch total time (including animation) | < 500 ms |
| NFR-PERF-012 | Window focus switch latency (keyboard navigation) | < 5 ms |
| NFR-PERF-013 | Window resize/move response (keyboard-driven) | < 16 ms per step |
| NFR-PERF-014 | Command palette open-to-ready time | < 50 ms |
| NFR-PERF-015 | Transparent workspace compositing overhead vs. opaque | < 5% additional GPU usage |
| NFR-PERF-016 | Theme switch (hot-reload) apply time | < 100 ms |

## 4.7 Sound Engine Performance

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-SND-001 | Sound synthesis latency (action trigger to audible output) | < 10 ms |
| NFR-SND-002 | Sound engine CPU overhead during playback | < 2% additional CPU |
| NFR-SND-003 | Sound engine idle CPU (no sounds playing) | 0% (no active audio nodes) |
| NFR-SND-004 | Maximum concurrent sounds without clipping or dropout | >= 4 simultaneous |
| NFR-SND-005 | Audio node cleanup after sound completion | < 100 ms (disconnect + GC-eligible) |
| NFR-SND-006 | Sound engine initialization time (AudioContext creation) | < 20 ms |
| NFR-SND-007 | Memory per active sound (oscillator graph) | < 1 KB |
| NFR-SND-008 | Graceful degradation when Web Audio API is unavailable | No errors, no crashes, silent no-op |
