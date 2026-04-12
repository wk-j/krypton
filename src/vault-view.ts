import type { ContentView, PaneContentType } from './types';
import type { VaultIndex, VaultFile } from './vault-parser';
import { buildVaultIndex, readVaultFile } from './vault-parser';

type SidebarMode = 'files' | 'backlinks' | 'outline';

export class VaultContentView implements ContentView {
  readonly type: PaneContentType = 'vault';
  readonly element: HTMLElement;

  private vaultRoot: string;
  private index: VaultIndex | null = null;
  private currentFile: string | null = null;
  private jumpHistory: string[] = [];
  private sidebarMode: SidebarMode = 'files';
  private filterText = '';
  private filterActive = false;
  private selectedIndex = 0;
  private closeCb: (() => void) | null = null;

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
        this.closeFilter();
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
        const all = [...this.index.files.keys()].sort();
        if (!this.filterText) return all;
        const lower = this.filterText.toLowerCase();
        return all.filter((f) => f.toLowerCase().includes(lower));
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
    }
  }

  private renderSidebarTabs(): void {
    this.sidebarTabsEl.innerHTML = '';
    const modes: SidebarMode[] = ['files', 'backlinks', 'outline'];
    const labels = ['FILES', 'LINKS', 'OUTLINE'];

    for (let i = 0; i < modes.length; i++) {
      const tab = document.createElement('span');
      tab.className = 'krypton-vault__sidebar-tab';
      if (modes[i] === this.sidebarMode) {
        tab.classList.add('krypton-vault__sidebar-tab--active');
      }
      tab.textContent = `${i + 1}:${labels[i]}`;
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

      const label = this.sidebarMode === 'files'
        ? items[i].split('/').pop() ?? items[i]
        : items[i];
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
    }
    this.currentFile = relativePath;

    this.breadcrumbEl.textContent = relativePath;

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
      const saved = this.currentFile;
      this.currentFile = null;
      this.openFile(prev);
      if (saved) {
        this.jumpHistory.pop();
      }
    }
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.filterActive) return false;

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

      case 'q':
      case 'Escape':
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
