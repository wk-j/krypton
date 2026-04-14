import type { ContentView, PaneContentType } from './types';
import type { VaultIndex, VaultFile } from './vault-parser';
import { buildVaultIndex, readVaultFile } from './vault-parser';

type SidebarMode = 'files' | 'backlinks' | 'outline' | 'tags';

export class VaultContentView implements ContentView {
  readonly type: PaneContentType = 'vault';
  readonly element: HTMLElement;

  private vaultRoot: string;
  private index: VaultIndex | null = null;
  private currentFile: string | null = null;
  private jumpHistory: string[] = [];
  private forwardHistory: string[] = [];
  private _navigatingHistory = false;
  private sidebarMode: SidebarMode = 'files';
  private filterText = '';
  private filterActive = false;
  private selectedIndex = 0;
  private activeTag: string | null = null;
  private closeCb: (() => void) | null = null;
  private linkHintActive = false;
  private linkHintLabels: HTMLElement[] = [];
  private linkHintMap: Map<string, HTMLAnchorElement> = new Map();
  private linkHintInput = '';

  private sidebarEl: HTMLElement;
  private sidebarHeaderEl: HTMLElement;
  private sidebarTabsEl: HTMLElement;
  private filterEl: HTMLElement;
  private filterInputEl: HTMLInputElement;
  private sidebarListEl: HTMLElement;
  private mainEl: HTMLElement;
  private breadcrumbEl: HTMLElement;
  private contentEl: HTMLElement;
  private statusBarEl: HTMLElement;

  constructor(vaultRoot: string, container: HTMLElement) {
    this.vaultRoot = vaultRoot;

    this.element = document.createElement('div');
    this.element.className = 'krypton-vault';
    this.element.tabIndex = 0;

    // Sidebar
    this.sidebarEl = document.createElement('div');
    this.sidebarEl.className = 'krypton-vault__sidebar';

    this.sidebarHeaderEl = document.createElement('div');
    this.sidebarHeaderEl.className = 'krypton-vault__sidebar-header';

    const title = document.createElement('div');
    title.className = 'krypton-vault__sidebar-title';
    title.textContent = 'VAULT INDEX';
    this.sidebarHeaderEl.appendChild(title);

    this.sidebarTabsEl = document.createElement('div');
    this.sidebarTabsEl.className = 'krypton-vault__sidebar-tabs';
    this.renderSidebarTabs();
    this.sidebarHeaderEl.appendChild(this.sidebarTabsEl);

    this.filterEl = document.createElement('div');
    this.filterEl.className = 'krypton-vault__filter';
    this.filterEl.style.display = 'none';

    this.filterInputEl = document.createElement('input');
    this.filterInputEl.className = 'krypton-vault__filter-input';
    this.filterInputEl.type = 'text';
    this.filterInputEl.placeholder = 'Filter...';
    this.filterInputEl.addEventListener('input', () => {
      this.filterText = this.filterInputEl.value;
      this.selectedIndex = 0;
      this.renderSidebarList();
    });
    this.filterInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeFilter();
        e.stopPropagation();
      } else if (e.key === 'Enter') {
        this.filterActive = false;
        this.filterEl.style.display = 'none';
        this.element.focus();
        this.openSelectedItem();
        e.stopPropagation();
      }
    });
    this.filterEl.appendChild(this.filterInputEl);

    this.sidebarListEl = document.createElement('div');
    this.sidebarListEl.className = 'krypton-vault__sidebar-list';

    this.sidebarEl.appendChild(this.sidebarHeaderEl);
    this.sidebarEl.appendChild(this.filterEl);
    this.sidebarEl.appendChild(this.sidebarListEl);

    // Main content
    this.mainEl = document.createElement('div');
    this.mainEl.className = 'krypton-vault__main';

    this.breadcrumbEl = document.createElement('div');
    this.breadcrumbEl.className = 'krypton-vault__breadcrumb';

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'krypton-vault__content';

    this.statusBarEl = document.createElement('div');
    this.statusBarEl.className = 'krypton-vault__status-bar';

    this.mainEl.appendChild(this.breadcrumbEl);
    this.mainEl.appendChild(this.contentEl);
    this.mainEl.appendChild(this.statusBarEl);

    this.element.appendChild(this.sidebarEl);
    this.element.appendChild(this.mainEl);
    container.appendChild(this.element);

    this.init();
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  private async init(): Promise<void> {
    this.statusBarEl.textContent = 'INDEXING VAULT...';
    this.index = await buildVaultIndex(this.vaultRoot);
    this.renderSidebarList();

    const fileCount = this.index.files.size;
    const linkCount = [...this.index.backlinks.values()].reduce((sum, arr) => sum + arr.length, 0);
    this.statusBarEl.textContent = `FILES: ${fileCount}  LINKS: ${linkCount}`;

    if (fileCount > 0) {
      const readme = this.findFile('README.md') ?? this.findFile('index.md');
      if (readme) {
        this.openFile(readme);
      } else {
        const first = [...this.index.files.keys()][0];
        this.openFile(first);
      }
    }
  }

  private findFile(name: string): string | null {
    if (!this.index) return null;
    const lower = name.toLowerCase();
    for (const key of this.index.files.keys()) {
      if (key.toLowerCase() === lower || key.toLowerCase().endsWith('/' + lower)) {
        return key;
      }
    }
    return null;
  }

  private getListItems(): string[] {
    if (!this.index) return [];

    switch (this.sidebarMode) {
      case 'files': {
        let all = [...this.index.files.keys()]
          .filter((f) => {
            const file = this.index!.files.get(f);
            return file != null && file.frontmatterTags.length > 0;
          })
          .sort();
        if (this.activeTag) {
          const tagged = new Set(this.index.tags.get(this.activeTag) ?? []);
          all = all.filter((f) => tagged.has(f));
        }
        if (this.filterText) {
          const lower = this.filterText.toLowerCase();
          all = all.filter((f) => f.toLowerCase().includes(lower));
        }
        return all;
      }
      case 'backlinks': {
        if (!this.currentFile) return [];
        return this.index.backlinks.get(this.currentFile) ?? [];
      }
      case 'outline': {
        if (!this.currentFile) return [];
        const file = this.index.files.get(this.currentFile);
        if (!file) return [];
        return file.headings.map((h) => '  '.repeat(h.level - 1) + h.text);
      }
      case 'tags': {
        const allTags = [...this.index.tags.keys()].sort();
        if (!this.filterText) return allTags;
        const lower = this.filterText.toLowerCase();
        return allTags.filter((t) => t.toLowerCase().includes(lower));
      }
    }
  }

  private renderSidebarTabs(): void {
    this.sidebarTabsEl.innerHTML = '';
    const modes: SidebarMode[] = ['files', 'backlinks', 'outline', 'tags'];
    const labels = ['FILE', 'LINK', 'HEAD', 'TAG'];

    for (let i = 0; i < modes.length; i++) {
      const tab = document.createElement('span');
      tab.className = 'krypton-vault__sidebar-tab';
      if (modes[i] === this.sidebarMode) {
        tab.classList.add('krypton-vault__sidebar-tab--active');
      }
      let text = `${i + 1}:${labels[i]}`;
      if (modes[i] === 'files' && this.activeTag) {
        text += ` #${this.activeTag}`;
      }
      tab.textContent = text;
      this.sidebarTabsEl.appendChild(tab);
    }
  }

  private renderSidebarList(): void {
    this.sidebarListEl.innerHTML = '';
    const items = this.getListItems();

    for (let i = 0; i < items.length; i++) {
      const el = document.createElement('div');
      el.className = 'krypton-vault__sidebar-item';
      if (i === this.selectedIndex) {
        el.classList.add('krypton-vault__sidebar-item--selected');
      }
      if (this.sidebarMode === 'files' && items[i] === this.currentFile) {
        el.classList.add('krypton-vault__sidebar-item--current');
      }

      let label: string;
      if (this.sidebarMode === 'files') {
        const filename = items[i].split('/').pop() ?? items[i];
        const parts = items[i].split('/');
        const isDuplicate = items.some(
          (other, j) => j !== i && (other.split('/').pop() ?? other) === filename
        );
        label = isDuplicate && parts.length > 1
          ? `${parts[parts.length - 2]}/${filename}`
          : filename;
      } else if (this.sidebarMode === 'tags') {
        const count = this.index?.tags.get(items[i])?.length ?? 0;
        label = `#${items[i]}  (${count})`;
      } else {
        label = items[i];
      }
      el.textContent = label;
      this.sidebarListEl.appendChild(el);
    }
  }

  private async openFile(relativePath: string): Promise<void> {
    if (!this.index) return;
    const file = this.index.files.get(relativePath);
    if (!file) return;

    if (this.currentFile && this.currentFile !== relativePath) {
      this.jumpHistory.push(this.currentFile);
      if (!this._navigatingHistory) this.forwardHistory.length = 0;
    }
    this.currentFile = relativePath;

    this.breadcrumbEl.textContent = file.title;

    const content = await readVaultFile(file.path);
    this.renderMarkdown(content, file);
    this.updateStatusBar(file);
    this.renderSidebarList();
  }

  private renderMarkdown(content: string, file: VaultFile): void {
    this.contentEl.innerHTML = '';

    if (Object.keys(file.frontmatter).length > 0) {
      const fmEl = document.createElement('div');
      fmEl.className = 'krypton-vault__frontmatter';
      for (const [key, value] of Object.entries(file.frontmatter)) {
        const row = document.createElement('div');
        row.className = 'krypton-vault__frontmatter-row';
        row.innerHTML = `<span class="krypton-vault__frontmatter-key">${this.escapeHtml(key)}</span><span class="krypton-vault__frontmatter-value">${this.escapeHtml(String(value))}</span>`;
        fmEl.appendChild(row);
      }
      this.contentEl.appendChild(fmEl);
    }

    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const rendered = this.markdownToHtml(body);
    const article = document.createElement('div');
    article.className = 'krypton-vault__article';
    article.innerHTML = rendered;

    article.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href');
      if (href && !href.includes('://')) {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const target = href.replace(/\.md$/, '');
          const resolved = this.resolveLink(target);
          if (resolved) this.openFile(resolved);
        });
      }
    });

    this.contentEl.appendChild(article);
    this.contentEl.scrollTop = 0;
  }

  private resolveLink(target: string): string | null {
    if (!this.index) return null;
    const lower = target.toLowerCase();
    for (const key of this.index.files.keys()) {
      const keyLower = key.toLowerCase().replace(/\.md$/, '');
      if (keyLower === lower || keyLower.endsWith('/' + lower)) {
        return key;
      }
    }
    return null;
  }

  private markdownToHtml(md: string): string {
    const lines = md.split('\n');
    const out: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Code blocks
      if (line.startsWith('```')) {
        const lang = line.slice(3).trim();
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) {
          codeLines.push(this.escapeHtml(lines[i]));
          i++;
        }
        i++; // skip closing ```
        out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${codeLines.join('\n')}</code></pre>`);
        continue;
      }

      // Tables
      if (i + 1 < lines.length && /^\|(.+\|)+\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const headerCells = line.split('|').slice(1, -1).map((c) => c.trim());
        const alignLine = lines[i + 1];
        const aligns = alignLine.split('|').slice(1, -1).map((c) => {
          const t = c.trim();
          if (t.startsWith(':') && t.endsWith(':')) return 'center';
          if (t.endsWith(':')) return 'right';
          return 'left';
        });
        i += 2;

        let table = '<table class="krypton-vault__table"><thead><tr>';
        for (let c = 0; c < headerCells.length; c++) {
          table += `<th style="text-align:${aligns[c] ?? 'left'}">${this.inlineFormat(headerCells[c])}</th>`;
        }
        table += '</tr></thead><tbody>';

        while (i < lines.length && /^\|(.+\|)+\s*$/.test(lines[i])) {
          const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
          table += '<tr>';
          for (let c = 0; c < cells.length; c++) {
            table += `<td style="text-align:${aligns[c] ?? 'left'}">${this.inlineFormat(cells[c])}</td>`;
          }
          table += '</tr>';
          i++;
        }
        table += '</tbody></table>';
        out.push(table);
        continue;
      }

      // Headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const text = headingMatch[2];
        const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        out.push(`<h${level} id="${id}">${this.inlineFormat(text)}</h${level}>`);
        i++;
        continue;
      }

      // Unordered lists
      if (/^[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(`<li>${this.inlineFormat(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
          i++;
        }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      // Ordered lists
      if (/^\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${this.inlineFormat(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
          i++;
        }
        out.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      // Blockquotes
      if (line.startsWith('>')) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].startsWith('>')) {
          quoteLines.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${this.inlineFormat(quoteLines.join('<br>'))}</blockquote>`);
        continue;
      }

      // Horizontal rule
      if (/^[-*_]{3,}\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Paragraph
      const paraLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^#{1,6}\s/.test(lines[i]) && !/^[-*]\s/.test(lines[i]) && !/^\d+\.\s/.test(lines[i]) && !lines[i].startsWith('>') && !lines[i].startsWith('```') && !/^\|/.test(lines[i]) && !/^[-*_]{3,}\s*$/.test(lines[i])) {
        paraLines.push(lines[i]);
        i++;
      }
      if (paraLines.length > 0) {
        out.push(`<p>${this.inlineFormat(paraLines.join(' '))}</p>`);
      }
    }

    return out.join('\n');
  }

  private inlineFormat(text: string): string {
    let html = this.escapeHtml(text);

    // Wikilinks
    html = html.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, target, display) => {
      return `<a href="${target}" class="krypton-vault__wikilink">${display ?? target}</a>`;
    });

    // Images
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" class="krypton-vault__image">');
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Tags
    html = html.replace(/(^|\s)#([a-zA-Z][\w/-]*)/g, '$1<span class="krypton-vault__tag">#$2</span>');

    return html;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private updateStatusBar(file: VaultFile): void {
    const backlinks = this.index?.backlinks.get(file.relativePath)?.length ?? 0;
    const links = file.wikilinks.length;
    const tags = file.tags.length;
    this.statusBarEl.textContent = `LINKS: ${links}  BACKLINKS: ${backlinks}  TAGS: ${tags}  HEADINGS: ${file.headings.length}`;
  }

  private openSelectedItem(): void {
    const items = this.getListItems();
    if (items.length === 0) return;
    const idx = Math.min(this.selectedIndex, items.length - 1);
    const item = items[idx];

    switch (this.sidebarMode) {
      case 'files':
        this.openFile(item);
        break;
      case 'backlinks':
        this.openFile(item);
        break;
      case 'outline': {
        if (!this.currentFile || !this.index) break;
        const file = this.index.files.get(this.currentFile);
        if (!file) break;
        const heading = file.headings[idx];
        if (heading) {
          const target = this.contentEl.querySelector(`#${heading.id}`);
          target?.scrollIntoView({ behavior: 'smooth' });
        }
        break;
      }
      case 'tags':
        this.activeTag = item;
        this.sidebarMode = 'files';
        this.selectedIndex = 0;
        this.renderSidebarTabs();
        this.renderSidebarList();
        break;
    }
  }

  private openFilter(): void {
    this.filterActive = true;
    this.filterEl.style.display = '';
    this.filterInputEl.value = this.filterText;
    this.filterInputEl.focus();
  }

  private closeFilter(): void {
    this.filterActive = false;
    this.filterText = '';
    this.filterEl.style.display = 'none';
    this.element.focus();
    this.renderSidebarList();
  }

  private goBack(): void {
    const prev = this.jumpHistory.pop();
    if (prev) {
      if (this.currentFile) this.forwardHistory.push(this.currentFile);
      this._navigatingHistory = true;
      this.currentFile = null;
      this.openFile(prev);
      this.jumpHistory.pop();
      this._navigatingHistory = false;
    }
  }

  private goForward(): void {
    const next = this.forwardHistory.pop();
    if (next) {
      this._navigatingHistory = true;
      this.openFile(next);
      this._navigatingHistory = false;
    }
  }

  // ── Link Hint Mode ──

  private static generateHintLabels(count: number): string[] {
    const chars = 'asdfghjkl';
    const labels: string[] = [];
    if (count <= chars.length) {
      for (let i = 0; i < count; i++) labels.push(chars[i]);
    } else {
      for (let i = 0; i < chars.length && labels.length < count; i++) {
        for (let j = 0; j < chars.length && labels.length < count; j++) {
          labels.push(chars[i] + chars[j]);
        }
      }
    }
    return labels;
  }

  private enterLinkHintMode(): void {
    const links = Array.from(
      this.contentEl.querySelectorAll('a[href], .krypton-vault__wikilink'),
    ) as HTMLAnchorElement[];
    if (links.length === 0) return;

    const labels = VaultContentView.generateHintLabels(links.length);
    this.linkHintMap.clear();
    this.linkHintLabels = [];
    this.linkHintInput = '';

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const label = labels[i];
      this.linkHintMap.set(label, link);

      const badge = document.createElement('span');
      badge.className = 'krypton-vault__link-hint';
      badge.textContent = label;
      link.style.position = 'relative';
      link.appendChild(badge);
      this.linkHintLabels.push(badge);
    }

    this.linkHintActive = true;
  }

  private exitLinkHintMode(): void {
    for (const badge of this.linkHintLabels) badge.remove();
    this.linkHintLabels = [];
    this.linkHintMap.clear();
    this.linkHintInput = '';
    this.linkHintActive = false;
  }

  private handleLinkHintKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.exitLinkHintMode();
      return true;
    }

    if (e.key.length !== 1) return true;

    this.linkHintInput += e.key.toLowerCase();

    const match = this.linkHintMap.get(this.linkHintInput);
    if (match) {
      const href = match.getAttribute('href');
      this.exitLinkHintMode();
      if (href) {
        const resolved = this.resolveLink(href);
        if (resolved) {
          this.openFile(resolved);
        }
      }
      return true;
    }

    let hasPrefix = false;
    for (const label of this.linkHintMap.keys()) {
      if (label.startsWith(this.linkHintInput)) {
        hasPrefix = true;
        break;
      }
    }

    if (!hasPrefix) {
      this.exitLinkHintMode();
    } else {
      for (const badge of this.linkHintLabels) {
        const label = badge.textContent || '';
        badge.classList.toggle(
          'krypton-vault__link-hint--dimmed',
          !label.startsWith(this.linkHintInput),
        );
      }
    }
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.linkHintActive) return this.handleLinkHintKey(e);
    if (this.filterActive) return false;

    if (e.ctrlKey && e.key === 'o') {
      this.goBack();
      return true;
    }
    if (e.ctrlKey && e.key === 'i') {
      this.goForward();
      return true;
    }

    const key = e.key;

    switch (key) {
      case 'J':
        this.contentEl.scrollBy(0, 60);
        return true;

      case 'K':
        this.contentEl.scrollBy(0, -60);
        return true;

      case 'j':
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.getListItems().length - 1);
        this.renderSidebarList();
        return true;

      case 'k':
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.renderSidebarList();
        return true;

      case 'Enter':
      case 'l':
        this.openSelectedItem();
        return true;

      case 'h':
      case 'Backspace':
        this.goBack();
        return true;

      case '/':
        this.openFilter();
        return true;

      case 'f':
        this.enterLinkHintMode();
        return true;

      case 'Escape':
        if (this.activeTag) {
          this.activeTag = null;
          this.selectedIndex = 0;
          this.renderSidebarTabs();
          this.renderSidebarList();
          return true;
        }
        if (this.closeCb) this.closeCb();
        return true;

      case 'q':
        if (this.closeCb) this.closeCb();
        return true;

      case '1':
        this.sidebarMode = 'files';
        this.selectedIndex = 0;
        this.renderSidebarTabs();
        this.renderSidebarList();
        return true;

      case '2':
        this.sidebarMode = 'backlinks';
        this.selectedIndex = 0;
        this.renderSidebarTabs();
        this.renderSidebarList();
        return true;

      case '3':
        this.sidebarMode = 'outline';
        this.selectedIndex = 0;
        this.renderSidebarTabs();
        this.renderSidebarList();
        return true;

      case '4':
        this.sidebarMode = 'tags';
        this.selectedIndex = 0;
        this.renderSidebarTabs();
        this.renderSidebarList();
        return true;

      case 'g':
        if (e.shiftKey) {
          this.contentEl.scrollTo(0, this.contentEl.scrollHeight);
        } else {
          this.contentEl.scrollTo(0, 0);
        }
        return true;

      default:
        return false;
    }
  }

  dispose(): void {
    this.element.remove();
  }

  onResize(_width: number, _height: number): void {
    // No-op for now; CSS handles responsive layout
  }

  getWorkingDirectory(): string {
    return this.vaultRoot;
  }
}
