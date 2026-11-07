.PHONY: dev build install uninstall clean extension remote-runtime

APP_NAME := Krypton
# Honour CARGO_TARGET_DIR and build.target-dir instead of assuming src-tauri/target.
TARGET_DIR := $(shell cargo metadata --format-version 1 --no-deps --manifest-path src-tauri/Cargo.toml | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')
# Recursive so a missing target directory only fails targets that need it.
RELEASE_DIR = $(or $(TARGET_DIR),$(error could not detect the Cargo target directory))/release
BUNDLE_PATH = $(RELEASE_DIR)/bundle/macos/$(APP_NAME).app
INSTALL_DIR := /Applications
CLI_NAME := kryptonctl
CLI_PATH = $(RELEASE_DIR)/$(CLI_NAME)
BRIDGE_NAME := krypton-bridge
BRIDGE_PATH = $(RELEASE_DIR)/$(BRIDGE_NAME)
REMOTE_RUNTIME_PATH = $(RELEASE_DIR)/krypton-remote
CLI_INSTALL_DIR ?= $(HOME)/.local/bin

# Start development server with hot-reload
dev:
	npx tauri dev

# Build production app bundle
# Pre-clean stale DMGs: hdiutil convert refuses to overwrite, so a previous
# failed bundle leaves Krypton_*.dmg / rw.*.dmg that break the next run.
build:
	rm -f "$(RELEASE_DIR)"/bundle/macos/Krypton_*.dmg \
	      "$(RELEASE_DIR)"/bundle/macos/rw.*.dmg \
	      "$(RELEASE_DIR)"/bundle/dmg/Krypton_*.dmg
	npx tauri build
	cargo build --release --manifest-path src-tauri/Cargo.toml --bin $(CLI_NAME)
	cargo build --release --manifest-path src-tauri/Cargo.toml --bin $(BRIDGE_NAME)

# Bundle the extension's injected content-extraction script (doc 177).
# esbuild rolls Defuddle into dist/content.bundle.js (IIFE) for on-demand injection.
extension:
	@echo "Building browser-extension content bundle..."
	@npm --prefix extension ci
	@npm --prefix extension run build

# Build the headless companion locally. Normal app builds stage it automatically.
remote-runtime:
	cargo build --release --manifest-path src-tauri/Cargo.toml -p krypton-remote
	@echo "Built $(REMOTE_RUNTIME_PATH)"

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
