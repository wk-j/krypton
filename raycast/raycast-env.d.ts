/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Hook Server Port - Port of Krypton's loopback hook server ([hooks] port in krypton.toml) — used only to build browser URLs for the dashboard/gallery/docs surfaces */
  "hookPort": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `lanes` command */
  export type Lanes = ExtensionPreferences & {}
  /** Preferences accessible in the `attention` command */
  export type Attention = ExtensionPreferences & {}
  /** Preferences accessible in the `permissions` command */
  export type Permissions = ExtensionPreferences & {}
  /** Preferences accessible in the `menubar` command */
  export type Menubar = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `lanes` command */
  export type Lanes = {}
  /** Arguments passed to the `attention` command */
  export type Attention = {}
  /** Arguments passed to the `permissions` command */
  export type Permissions = {}
  /** Arguments passed to the `menubar` command */
  export type Menubar = {}
}

