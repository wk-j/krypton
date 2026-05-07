.PHONY: dev build install uninstall clean

APP_NAME := Krypton
BUNDLE_PATH := src-tauri/target/release/bundle/macos/$(APP_NAME).app
INSTALL_DIR := /Applications

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

# Build and install to /Applications
install: build
	@echo "Installing $(APP_NAME).app to $(INSTALL_DIR)..."
	@rm -rf "$(INSTALL_DIR)/$(APP_NAME).app"
	@cp -R "$(BUNDLE_PATH)" "$(INSTALL_DIR)/$(APP_NAME).app"
	@echo "Installed to $(INSTALL_DIR)/$(APP_NAME).app"

# Remove from /Applications
uninstall:
	@echo "Removing $(APP_NAME).app from $(INSTALL_DIR)..."
	@rm -rf "$(INSTALL_DIR)/$(APP_NAME).app"
	@echo "Uninstalled."

# Clean build artifacts
clean:
	cargo clean --manifest-path src-tauri/Cargo.toml
	rm -rf dist
