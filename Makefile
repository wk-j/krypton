.PHONY: dev build install uninstall clean

APP_NAME := Krypton
BUNDLE_PATH := src-tauri/target/release/bundle/macos/$(APP_NAME).app
INSTALL_DIR := /Applications
CLI_NAME := kryptonctl
CLI_PATH := src-tauri/target/release/$(CLI_NAME)
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

# Build and install to /Applications
install: build
	@echo "Installing $(APP_NAME).app to $(INSTALL_DIR)..."
	@rm -rf "$(INSTALL_DIR)/$(APP_NAME).app"
	@cp -R "$(BUNDLE_PATH)" "$(INSTALL_DIR)/$(APP_NAME).app"
	@echo "Installed to $(INSTALL_DIR)/$(APP_NAME).app"
	@echo "Installing $(CLI_NAME) to $(CLI_INSTALL_DIR)..."
	@mkdir -p "$(CLI_INSTALL_DIR)"
	@install -m 755 "$(CLI_PATH)" "$(CLI_INSTALL_DIR)/$(CLI_NAME)"
	@echo "Installed to $(CLI_INSTALL_DIR)/$(CLI_NAME)"

# Remove from /Applications
uninstall:
	@echo "Removing $(APP_NAME).app from $(INSTALL_DIR)..."
	@rm -rf "$(INSTALL_DIR)/$(APP_NAME).app"
	@echo "Uninstalled."
	@echo "Removing $(CLI_INSTALL_DIR)/$(CLI_NAME)..."
	@rm -f "$(CLI_INSTALL_DIR)/$(CLI_NAME)"
	@echo "Uninstalled $(CLI_NAME)."

# Clean build artifacts
clean:
	cargo clean --manifest-path src-tauri/Cargo.toml
	rm -rf dist
