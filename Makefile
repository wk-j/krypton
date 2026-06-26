.PHONY: dev build install uninstall clean extension

APP_NAME := Krypton
BUNDLE_PATH := src-tauri/target/release/bundle/macos/$(APP_NAME).app
INSTALL_DIR := /Applications
CLI_NAME := kryptonctl
CLI_PATH := src-tauri/target/release/$(CLI_NAME)
BRIDGE_NAME := krypton-bridge
BRIDGE_PATH := src-tauri/target/release/$(BRIDGE_NAME)
CLI_INSTALL_DIR ?= $(HOME)/.local/bin

# Start development server with hot-reload
dev:
	npx tauri dev

# Build production app bundle
# Pre-clean stale DMGs: hdiutil convert refuses to overwrite, so a previous
# failed bundle leaves Krypton_*.dmg / rw.*.dmg that break the next run.
build:
	rm -f src-tauri/target/release/bundle/macos/Krypton_*.dmg \
	      src-tauri/target/release/bundle/macos/rw.*.dmg \
	      src-tauri/target/release/bundle/dmg/Krypton_*.dmg
	npx tauri build
	cargo build --release --manifest-path src-tauri/Cargo.toml --bin $(CLI_NAME)
	cargo build --release --manifest-path src-tauri/Cargo.toml --bin $(BRIDGE_NAME)

# Bundle the extension's injected content-extraction script (doc 177).
# esbuild rolls Defuddle into dist/content.bundle.js (IIFE) for on-demand injection.
extension:
	@echo "Building browser-extension content bundle..."
	@npm --prefix extension ci
	@npm --prefix extension run build

# Build and install to /Applications
install: build extension
	@echo "Installing $(APP_NAME).app to $(INSTALL_DIR)..."
	@rm -rf "$(INSTALL_DIR)/$(APP_NAME).app"
	@cp -R "$(BUNDLE_PATH)" "$(INSTALL_DIR)/$(APP_NAME).app"
	@echo "Installed to $(INSTALL_DIR)/$(APP_NAME).app"
	@echo "Installing $(CLI_NAME) to $(CLI_INSTALL_DIR)..."
	@mkdir -p "$(CLI_INSTALL_DIR)"
	@install -m 755 "$(CLI_PATH)" "$(CLI_INSTALL_DIR)/$(CLI_NAME)"
	@echo "Installed to $(CLI_INSTALL_DIR)/$(CLI_NAME)"
	@echo "Installing $(BRIDGE_NAME) (browser-extension native host) to $(CLI_INSTALL_DIR)..."
	@install -m 755 "$(BRIDGE_PATH)" "$(CLI_INSTALL_DIR)/$(BRIDGE_NAME)"
	@echo "Installed to $(CLI_INSTALL_DIR)/$(BRIDGE_NAME)"

# Remove from /Applications
uninstall:
	@echo "Removing $(APP_NAME).app from $(INSTALL_DIR)..."
	@rm -rf "$(INSTALL_DIR)/$(APP_NAME).app"
	@echo "Uninstalled."
	@echo "Removing $(CLI_INSTALL_DIR)/$(CLI_NAME)..."
	@rm -f "$(CLI_INSTALL_DIR)/$(CLI_NAME)"
	@echo "Uninstalled $(CLI_NAME)."
	@rm -f "$(CLI_INSTALL_DIR)/$(BRIDGE_NAME)"
	@echo "Uninstalled $(BRIDGE_NAME)."

# Clean build artifacts
clean:
	cargo clean --manifest-path src-tauri/Cargo.toml
	rm -rf dist
