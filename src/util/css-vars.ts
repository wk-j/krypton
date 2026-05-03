export function setCssVars(target: HTMLElement, vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    target.style.setProperty(k, v);
  }
}
