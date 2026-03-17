// Krypton — Context Extension Manager
// Manages built-in extensions that activate when specific processes are
// detected running in terminal panes.

import { listen } from '@tauri-apps/api/event';
import type {
  ActiveExtension,
  ContextExtension,
  ExtensionWidget,
  PaneId,
  ProcessChangedEvent,
  ProcessInfo,
  SessionId,
} from './types';

// ─── Built-in Extension Registry ─────────────────────────────────

// import { javaExtension } from './extensions/java'; // Disabled — buggy

/** All built-in context extensions. Order = priority (first match wins). */
const EXTENSIONS: ContextExtension[] = [
  // javaExtension, // Disabled — buggy
  // Future: sshExtension, vimExtension, pythonExtension, nodeExtension, etc.
];

// ─── Types for Compositor integration ────────────────────────────

/** Minimal interface the ExtensionManager needs from the Compositor. */
export interface ExtensionHost {
  /** Look up which pane a session belongs to. Returns pane element + id, or null. */
  findPaneBySessionId(sessionId: SessionId): { paneId: PaneId; element: HTMLElement } | null;
  /** Trigger addon-fit recalculation + resize_pty for a pane. */
  refitPane(paneId: PaneId): void;
}

// ─── Extension Manager ───────────────────────────────────────────

export class ExtensionManager {
  private paneExtensions: Map<PaneId, ActiveExtension> = new Map();
  private host: ExtensionHost;
  private enabled: boolean = true;
  private unlisten: (() => void) | null = null;

  constructor(host: ExtensionHost) {
    this.host = host;
  }

  /** Start listening for process-changed events from the backend. */
  async start(): Promise<void> {
    this.unlisten = await listen<ProcessChangedEvent>('process-changed', (event) => {
      if (!this.enabled) return;
      const { session_id, process } = event.payload;
      this.onProcessChanged(session_id, process);
    });
  }

  /** Stop listening and deactivate all extensions. */
  stop(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    this.deactivateAll();
  }

  /** Enable or disable all extensions. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.deactivateAll();
    }
  }

  /** Clean up when a pane is destroyed. */
  onPaneDestroyed(paneId: PaneId): void {
    this.deactivateExtension(paneId);
  }

  /** Handle a process-changed event from the backend. */
  private onProcessChanged(sessionId: SessionId, process: ProcessInfo | null): void {
    const paneInfo = this.host.findPaneBySessionId(sessionId);
    if (!paneInfo) return;

    const { paneId, element } = paneInfo;
    const active = this.paneExtensions.get(paneId);

    if (process) {
      const ext = this.findExtension(process.name);

      if (ext) {
        if (active && active.extension.name === ext.name) {
          // Same extension still active — update if process info changed
          if (ext.updateWidgets) {
            ext.updateWidgets(active.widgets, process);
          }
          active.process = process;
        } else {
          // Different extension or first activation — swap
          if (active) {
            this.deactivateExtension(paneId);
          }
          this.activateExtension(paneId, element, ext, process, sessionId);
        }
      } else {
        // No matching extension — deactivate if one was active
        if (active) {
          this.deactivateExtension(paneId);
        }
      }
    } else {
      // No foreground process (shell idle) — deactivate
      if (active) {
        this.deactivateExtension(paneId);
      }
    }
  }

  /** Find a matching extension for a process name. */
  private findExtension(processName: string): ContextExtension | null {
    for (const ext of EXTENSIONS) {
      if (ext.processNames.includes(processName)) {
        return ext;
      }
    }
    return null;
  }

  /** Activate an extension on a pane. */
  private activateExtension(
    paneId: PaneId,
    paneElement: HTMLElement,
    ext: ContextExtension,
    process: ProcessInfo,
    sessionId: SessionId,
  ): void {
    const widgets = ext.createWidgets(process, sessionId);

    // Styling hook only — does NOT change layout mode (pane is always flex column)
    paneElement.classList.add('krypton-pane--has-extension');

    // Use .krypton-pane__terminal as the stable reference node:
    // top widgets go before it, bottom widgets go after it.
    const terminalWrap = paneElement.querySelector('.krypton-pane__terminal');
    for (const widget of widgets) {
      if (widget.position === 'top' && terminalWrap) {
        paneElement.insertBefore(widget.element, terminalWrap);
      } else {
        paneElement.appendChild(widget.element);
      }
    }

    this.paneExtensions.set(paneId, { extension: ext, widgets, process, paneElement });

    // Single refit is sufficient — pane is already flex column, so the
    // browser's flex algorithm instantly recomputes when bars are inserted.
    // No double refit needed.
    requestAnimationFrame(() => {
      this.host.refitPane(paneId);
    });
  }

  /** Deactivate the extension on a pane. */
  private deactivateExtension(paneId: PaneId): void {
    const active = this.paneExtensions.get(paneId);
    if (!active) return;

    // Call custom destroy or default cleanup
    if (active.extension.destroyWidgets) {
      active.extension.destroyWidgets(active.widgets);
    } else {
      for (const widget of active.widgets) {
        if (widget.dispose) widget.dispose();
        widget.element.remove();
      }
    }

    // Remove styling hook class (layout is unchanged — pane stays flex column)
    active.paneElement.classList.remove('krypton-pane--has-extension');

    this.paneExtensions.delete(paneId);

    // Trigger refit after a frame so layout has settled
    requestAnimationFrame(() => {
      this.host.refitPane(paneId);
    });
  }

  /** Deactivate all extensions on all panes. */
  private deactivateAll(): void {
    const paneIds = [...this.paneExtensions.keys()];
    for (const paneId of paneIds) {
      this.deactivateExtension(paneId);
    }
  }
}
