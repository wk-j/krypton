// Spec 301/302 — what a component directory must declare about itself.
//
// One component = one directory = one entry in `registry.ts`. Adding a
// component is creating the folder and adding one import + one array entry;
// removing it is deleting the folder and those two lines, because the CSS, the
// scheme override and the listeners all live inside the folder.

export interface ComponentDef {
  /** Directory name. Unique across the registry. */
  readonly id: string;
  /**
   * The BEM blocks this directory's stylesheet is allowed to declare.
   *
   * Ownership is DECLARED, not derived from the directory name: the
   * parameterised primitives (`Chip`, `Card`, `OverlayShell`, `ListPicker`,
   * `TabStrip`, `KeyHintBar`, `StatList`, `EmptyState`) take `block` as a prop
   * and own no block at all, so their list is empty and they ship no sheet.
   * `styles-ownership.test.ts` reads this list, not the folder name.
   */
  readonly blocks: readonly string[];
}
