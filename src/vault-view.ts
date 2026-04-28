import type { ContentView, PaneContentType } from './types';
import type { VaultIndex, VaultFile } from './vault-parser';
import { buildVaultIndex, readVaultFile } from './vault-parser';

type SidebarMode = 'files' | 'backlinks' | 'outline' | 'tags';
type FileSortField = 'title' | 'updated' | 'modified' | 'name' | 'type';
type FileSortOrder = 'asc' | 'desc';

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
  private pageIndex = 0;
  private itemsPerPage = 0;
  private cachedItemHeight = 0;
  private activeTag: string | null = null;
  private fileSortField: FileSortField = 'updated';
  private fileSortOrder: FileSortOrder = 'desc';
  private closeCb: (() => void) | null = null;
  private titleCb: ((name: string) => void) | null = null;
  private listVaults: (() => Promise<Array<{ name: string; path: string }>>) | null = null;
  private expandPath: ((p: string) => Promise<string>) | null = null;
  private pickerOverlay: HTMLElement | null = null;
  private linkHintActive = false;
  private linkHintLabels: HTMLElement[] = [];
  private linkHintMap: Map<string, HTMLAnchorElement> = new Map();
  private linkHintInput = '';
  private statusFlashTimer: number | null = null;

  private sidebarEl: HTMLElement;
  private sidebarHeaderEl: HTMLElement;
  private sidebarTitleEl!: HTMLElement;
  private sidebarTabsEl: HTMLElement;
  private filterEl: HTMLElement;
  private filterInputEl: HTMLInputElement;
  private sidebarListEl: HTMLElement;
  private sidebarPaginationEl!: HTMLElement;
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

    this.sidebarTitleEl = document.createElement('div');
    this.sidebarTitleEl.className = 'krypton-vault__sidebar-title';
    this.sidebarTitleEl.textContent = 'VAULT INDEX';
    this.sidebarHeaderEl.appendChild(this.sidebarTitleEl);

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

    this.sidebarPaginationEl = document.createElement('div');
    this.sidebarPaginationEl.className = 'krypton-vault__sidebar-pagination';

    this.sidebarEl.appendChild(this.sidebarHeaderEl);
    this.sidebarEl.appendChild(this.filterEl);
    this.sidebarEl.appendChild(this.sidebarListEl);
    this.sidebarEl.appendChild(this.sidebarPaginationEl);

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

  onTitleChange(cb: (name: string) => void): void {
    this.titleCb = cb;
  }

  /** Wire up multi-vault switching. Host provides the entry list + ~ expansion. */
  setVaultSwitcher(
    listVaults: () => Promise<Array<{ name: string; path: string }>>,
    expandPath: (p: string) => Promise<string>,
  ): void {
    this.listVaults = listVaults;
    this.expandPath = expandPath;
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
        let all = [...this.index.files.keys()].filter((f) => {
          const file = this.index!.files.get(f);
          return file != null && file.frontmatterTags.length > 0;
        });
        const dir = this.fileSortOrder === 'asc' ? 1 : -1;
        all.sort((a, b) => {
          switch (this.fileSortField) {
            case 'title': {
              const ta = this.index!.files.get(a)?.title ?? a.split('/').pop() ?? a;
              const tb = this.index!.files.get(b)?.title ?? b.split('/').pop() ?? b;
              return dir * ta.localeCompare(tb);
            }
            case 'name':
              return dir * a.toLowerCase().localeCompare(b.toLowerCase());
            case 'modified': {
              const ma = this.index!.files.get(a)?.modifiedAt ?? 0;
              const mb = this.index!.files.get(b)?.modifiedAt ?? 0;
              if (ma !== mb) return dir * (ma - mb);
              return dir * a.localeCompare(b);
            }
            case 'updated': {
              const fa = this.index!.files.get(a);
              const fb = this.index!.files.get(b);
              const ua = fa?.contentUpdatedAt || fa?.modifiedAt || 0;
              const ub = fb?.contentUpdatedAt || fb?.modifiedAt || 0;
              if (ua !== ub) return dir * (ua - ub);
              const ma = fa?.modifiedAt ?? 0;
              const mb = fb?.modifiedAt ?? 0;
              if (ma !== mb) return dir * (ma - mb);
              return dir * a.localeCompare(b);
            }
            case 'type': {
              const fa = this.index!.files.get(a);
              const fb = this.index!.files.get(b);
              const ta = fa ? this.getDocType(a, fa) : '';
              const tb = fb ? this.getDocType(b, fb) : '';
              return dir * ta.localeCompare(tb);
            }
            default:
              return 0;
          }
        });
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

  private getDocType(relativePath: string, file: VaultFile): string {
    const fmType = file.frontmatter['type'];
    if (typeof fmType === 'string' && fmType) return fmType.toLowerCase();
    if (relativePath.startsWith('raw/')) return 'clipping';
    const fmSource = file.frontmatter['source'];
    if (typeof fmSource === 'string' && fmSource.startsWith('http')) return 'clipping';
    const basename = relativePath.split('/').pop() ?? '';
    if (basename === 'log.md') return 'log';
    if (basename === 'index.md') return 'index';
    return '';
  }

  private docTypeAbbr(docType: string): string {
    const map: Record<string, string> = {
      concept: 'CON',
      entity: 'ENT',
      source: 'SRC',
      clipping: 'CLIP',
      log: 'LOG',
      index: 'IDX',
      analysis: 'ANA',
    };
    return map[docType] ?? docType.slice(0, 3).toUpperCase();
  }

  private updateSortIndicator(): void {
    if (this.sidebarMode === 'files') {
      const arrow = this.fileSortOrder === 'asc' ? '↑' : '↓';
      this.sidebarTitleEl.textContent = `VAULT INDEX  ${this.fileSortField}${arrow}`;
    } else {
      this.sidebarTitleEl.textContent = 'VAULT INDEX';
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

  private measureItemHeight(): number {
    if (this.cachedItemHeight > 0) return this.cachedItemHeight;
    const probe = document.createElement('div');
    probe.className = 'krypton-vault__sidebar-item';
    probe.style.visibility = 'hidden';
    probe.textContent = 'X';
    this.sidebarListEl.appendChild(probe);
    const h = probe.offsetHeight;
    this.sidebarListEl.removeChild(probe);
    if (h > 0) this.cachedItemHeight = h;
    return h > 0 ? h : 20;
  }

  private renderSidebarList(): void {
    this.updateSortIndicator();
    this.sidebarListEl.innerHTML = '';
    const items = this.getListItems();

    const itemH = this.measureItemHeight();
    const listH = this.sidebarListEl.clientHeight;
    const perPage = Math.max(1, Math.floor(listH / itemH));
    this.itemsPerPage = perPage;
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    if (this.selectedIndex > items.length - 1) {
      this.selectedIndex = Math.max(0, items.length - 1);
    }
    const selPage = Math.floor(this.selectedIndex / perPage);
    this.pageIndex = Math.max(0, Math.min(selPage, totalPages - 1));
    const start = this.pageIndex * perPage;
    const end = Math.min(items.length, start + perPage);

    this.sidebarPaginationEl.textContent =
      totalPages > 1 ? `PAGE ${this.pageIndex + 1}/${totalPages}  ·  H/L` : '';

    const recencyByKey = new Map<string, number>();
    if (this.sidebarMode === 'files' && this.index) {
      const useUpdated = this.fileSortField === 'updated';
      const withTime = items
        .map((k) => {
          const f = this.index!.files.get(k);
          const t = useUpdated
            ? (f?.contentUpdatedAt || f?.modifiedAt || 0)
            : (f?.modifiedAt || f?.contentUpdatedAt || 0);
          return { key: k, t };
        })
        .filter((x) => x.t > 0)
        .sort((a, b) => a.t - b.t);
      const n = withTime.length;
      for (let idx = 0; idx < n; idx++) {
        recencyByKey.set(withTime[idx].key, n > 1 ? idx / (n - 1) : 0.5);
      }
    }

    for (let i = start; i < end; i++) {
      const el = document.createElement('div');
      el.className = 'krypton-vault__sidebar-item';
      if (i === this.selectedIndex) {
        el.classList.add('krypton-vault__sidebar-item--selected');
      }
      if (this.sidebarMode === 'files' && items[i] === this.currentFile) {
        el.classList.add('krypton-vault__sidebar-item--current');
      }

      let label: string;
      let docType = '';
      if (this.sidebarMode === 'files') {
        const file = this.index?.files.get(items[i]);
        label = file?.title ?? items[i].split('/').pop() ?? items[i];
        if (file) docType = this.getDocType(items[i], file);
      } else if (this.sidebarMode === 'tags') {
        const count = this.index?.tags.get(items[i])?.length ?? 0;
        label = `#${items[i]}  (${count})`;
      } else {
        label = items[i];
      }

      if (docType) {
        const typeEl = document.createElement('span');
        typeEl.className = `krypton-vault__doc-type krypton-vault__doc-type--${docType}`;
        typeEl.textContent = this.docTypeAbbr(docType);
        el.appendChild(typeEl);
      }

      const labelEl = document.createElement('span');
      labelEl.className = 'krypton-vault__sidebar-item-label';
      labelEl.textContent = label;
      el.appendChild(labelEl);

      const recency = recencyByKey.get(items[i]);
      if (recency !== undefined) {
        const ageBar = document.createElement('span');
        ageBar.className = 'krypton-vault__age-bar';
        const fill = document.createElement('span');
        fill.className = 'krypton-vault__age-fill';
        fill.style.width = `${15 + recency * 85}%`;
        const hue = 200 - (1 - recency) * 40;
        const sat = 70 + recency * 25;
        const light = 40 + recency * 25;
        fill.style.background = `hsl(${hue}, ${sat}%, ${light}%)`;
        fill.style.opacity = `${0.4 + recency * 0.6}`;
        ageBar.appendChild(fill);
        el.appendChild(ageBar);
      }

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
        const headerCells = this.splitTableRow(line);
        const alignLine = lines[i + 1];
        const aligns = this.splitTableRow(alignLine).map((t) => {
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
          const cells = this.splitTableRow(lines[i]);
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

  // Split a markdown table row on unescaped `|` separators, then unescape `\|` → `|`
  // in each cell. Needed for Obsidian wikilinks like [[page\|alias]] inside a cell.
  private splitTableRow(line: string): string[] {
    return line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
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

      case 'j': {
        const n = this.getListItems().length;
        if (n > 0 && this.itemsPerPage > 0) {
          const start = this.pageIndex * this.itemsPerPage;
          const end = Math.min(n, start + this.itemsPerPage);
          const size = end - start;
          const rel = this.selectedIndex - start;
          this.selectedIndex = start + ((rel + 1) % size);
          this.renderSidebarList();
        }
        return true;
      }

      case 'k': {
        const n = this.getListItems().length;
        if (n > 0 && this.itemsPerPage > 0) {
          const start = this.pageIndex * this.itemsPerPage;
          const end = Math.min(n, start + this.itemsPerPage);
          const size = end - start;
          const rel = this.selectedIndex - start;
          this.selectedIndex = start + ((rel - 1 + size) % size);
          this.renderSidebarList();
        }
        return true;
      }

      case 'Enter':
      case 'l':
        this.openSelectedItem();
        return true;

      case 'h':
      case 'Backspace':
        this.goBack();
        return true;

      case 'H':
        if (this.itemsPerPage > 0 && this.pageIndex > 0) {
          this.selectedIndex = (this.pageIndex - 1) * this.itemsPerPage;
          this.renderSidebarList();
        }
        return true;

      case 'L': {
        const items = this.getListItems();
        if (this.itemsPerPage > 0) {
          const totalPages = Math.max(1, Math.ceil(items.length / this.itemsPerPage));
          if (this.pageIndex < totalPages - 1) {
            this.selectedIndex = Math.min(
              items.length - 1,
              (this.pageIndex + 1) * this.itemsPerPage,
            );
            this.renderSidebarList();
          }
        }
        return true;
      }

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

      case 'y':
        this.copyPath(false);
        return true;

      case 'Y':
        this.copyPath(true);
        return true;

      case 's':
        if (this.sidebarMode === 'files') {
          const fields: FileSortField[] = ['title', 'updated', 'modified', 'name', 'type'];
          const idx = fields.indexOf(this.fileSortField);
          this.fileSortField = fields[(idx + 1) % fields.length];
          this.selectedIndex = 0;
          this.renderSidebarList();
        }
        return true;

      case 'S':
        if (this.sidebarMode === 'files') {
          this.fileSortOrder = this.fileSortOrder === 'asc' ? 'desc' : 'asc';
          this.selectedIndex = 0;
          this.renderSidebarList();
        }
        return true;

      case 'r':
        this.reload();
        return true;

      case 'V':
        this.openVaultPicker();
        return true;

      default:
        return false;
    }
  }

  private copyPath(absolute: boolean): void {
    const rel = this.pathForYank();
    if (!rel) {
      this.flashStatus('NO PATH TO COPY');
      return;
    }
    const text = absolute ? `${this.vaultRoot.replace(/\/$/, '')}/${rel}` : rel;
    navigator.clipboard
      .writeText(text)
      .then(() => this.flashStatus(`COPIED  ${text}`))
      .catch(() => this.flashStatus('COPY FAILED'));
  }

  private pathForYank(): string | null {
    if (this.sidebarMode === 'files' || this.sidebarMode === 'backlinks') {
      const items = this.getListItems();
      const sel = items[this.selectedIndex];
      if (sel) return sel;
    }
    return this.currentFile;
  }

  private flashStatus(text: string): void {
    if (this.statusFlashTimer !== null) {
      window.clearTimeout(this.statusFlashTimer);
    }
    const prev = this.statusBarEl.textContent ?? '';
    this.statusBarEl.textContent = text;
    this.statusFlashTimer = window.setTimeout(() => {
      this.statusBarEl.textContent = prev;
      this.statusFlashTimer = null;
    }, 1500);
  }

  private async reload(): Promise<void> {
    this.statusBarEl.textContent = 'RELOADING...';
    this.index = await buildVaultIndex(this.vaultRoot);
    this.renderSidebarList();
    if (this.currentFile) {
      await this.openFile(this.currentFile);
    } else {
      const fileCount = this.index.files.size;
      const linkCount = [...this.index.backlinks.values()].reduce((sum, arr) => sum + arr.length, 0);
      this.statusBarEl.textContent = `FILES: ${fileCount}  LINKS: ${linkCount}`;
    }
  }

  private async openVaultPicker(): Promise<void> {
    if (!this.listVaults) {
      this.flashStatus('VAULT SWITCHING UNAVAILABLE');
      return;
    }
    const entries = await this.listVaults();
    if (entries.length < 2) {
      this.flashStatus('ONLY ONE VAULT CONFIGURED');
      return;
    }

    if (this.pickerOverlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'krypton-vault-picker-overlay';

    const panel = document.createElement('div');
    panel.className = 'krypton-vault-picker';

    const title = document.createElement('div');
    title.className = 'krypton-vault-picker__title';
    title.textContent = 'SWITCH VAULT';
    panel.appendChild(title);

    const list = document.createElement('div');
    list.className = 'krypton-vault-picker__list';
    panel.appendChild(list);

    let selected = Math.max(
      0,
      entries.findIndex((e) => this.samePath(e.path, this.vaultRoot)),
    );
    if (selected < 0) selected = 0;

    const render = (): void => {
      list.innerHTML = '';
      entries.forEach((e, i) => {
        const row = document.createElement('div');
        row.className = 'krypton-vault-picker__item';
        if (i === selected) row.classList.add('krypton-vault-picker__item--selected');
        if (this.samePath(e.path, this.vaultRoot)) {
          row.classList.add('krypton-vault-picker__item--current');
        }

        const name = document.createElement('span');
        name.className = 'krypton-vault-picker__name';
        name.textContent = e.name;
        const p = document.createElement('span');
        p.className = 'krypton-vault-picker__path';
        p.textContent = e.path;
        row.appendChild(name);
        row.appendChild(p);
        row.addEventListener('click', () => {
          close();
          this.switchVault(e);
        });
        list.appendChild(row);
      });
    };
    render();

    const hint = document.createElement('div');
    hint.className = 'krypton-vault-picker__hint';
    hint.textContent = 'j/k  select    Enter  open    Esc  cancel';
    panel.appendChild(hint);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this.pickerOverlay = overlay;

    const close = (): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      this.pickerOverlay = null;
      this.element.focus();
    };

    const onKey = (ev: KeyboardEvent): void => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || ev.key === 'q') {
        ev.preventDefault();
        close();
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'l') {
        ev.preventDefault();
        const pick = entries[selected];
        close();
        if (pick) this.switchVault(pick);
        return;
      }
      if (ev.key === 'j' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        selected = Math.min(selected + 1, entries.length - 1);
        render();
        return;
      }
      if (ev.key === 'k' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        selected = Math.max(selected - 1, 0);
        render();
        return;
      }
      const digit = Number.parseInt(ev.key, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= entries.length) {
        ev.preventDefault();
        const pick = entries[digit - 1];
        close();
        this.switchVault(pick);
      }
    };
    document.addEventListener('keydown', onKey, true);
  }

  private samePath(a: string, b: string): boolean {
    const norm = (p: string): string => p.replace(/\/+$/, '');
    return norm(a) === norm(b);
  }

  private async switchVault(entry: { name: string; path: string }): Promise<void> {
    const resolved = this.expandPath ? await this.expandPath(entry.path) : entry.path;
    if (this.samePath(resolved, this.vaultRoot)) return;

    this.vaultRoot = resolved;
    this.index = null;
    this.currentFile = null;
    this.jumpHistory = [];
    this.forwardHistory = [];
    this.activeTag = null;
    this.filterText = '';
    this.filterActive = false;
    this.filterEl.style.display = 'none';
    this.selectedIndex = 0;
    this.sidebarMode = 'files';
    this.renderSidebarTabs();
    this.sidebarListEl.innerHTML = '';
    this.contentEl.innerHTML = '';
    this.breadcrumbEl.textContent = '';

    const label = entry.name || resolved.split('/').filter(Boolean).pop() || 'vault';
    if (this.titleCb) this.titleCb(label);

    await this.init();
  }

  dispose(): void {
    if (this.pickerOverlay) {
      this.pickerOverlay.remove();
      this.pickerOverlay = null;
    }
    this.element.remove();
  }

  onResize(_width: number, _height: number): void {
    if (this.index) this.renderSidebarList();
  }

  getWorkingDirectory(): string {
    return this.vaultRoot;
  }
}
