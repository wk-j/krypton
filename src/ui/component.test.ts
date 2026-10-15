import { describe, expect, it, vi } from 'vitest';

import { Component, DisposableBag, LiveComponent, sameDeps } from './component';

interface RowProps {
  label: string;
  tone: string;
  /** Mutated in place on purpose — the payload shape the harness actually has. */
  body: { text: string };
}

class Row extends Component<RowProps> {
  paints = 0;
  classSyncs = 0;
  readonly button = document.createElement('button');
  readonly label = document.createElement('span');
  readonly clicks = vi.fn();

  constructor() {
    super(document.createElement('div'));
    this.el.append(this.label, this.button);
    this.bag.listen(this.button, 'click', this.clicks);
  }

  protected readDeps(next: RowProps): readonly unknown[] {
    return [next.label, next.tone, next.body.text];
  }

  protected paint(next: RowProps): void {
    this.paints += 1;
    this.syncClasses(next);
    this.label.textContent = `${next.label}: ${next.body.text}`;
  }

  protected syncClasses(next: RowProps): void {
    this.classSyncs += 1;
    this.el.className = `row row--${next.tone}`;
  }
}

class StreamRow extends LiveComponent<RowProps> {
  paints = 0;
  chunks = 0;
  seals = 0;
  readonly body: HTMLElement;

  constructor() {
    super(document.createElement('div'));
    this.body = document.createElement('p');
    this.el.appendChild(this.body);
  }

  protected readDeps(next: RowProps): readonly unknown[] {
    return [next.label, next.tone];
  }

  protected paint(next: RowProps): void {
    this.paints += 1;
    this.syncClasses(next);
  }

  protected syncClasses(next: RowProps): void {
    this.el.className = `row row--${next.tone}${this.isLive ? ' row--streaming' : ''}`;
  }

  protected appendChunk(next: RowProps): void {
    this.chunks += 1;
    this.body.append(next.body.text);
  }

  protected onSeal(): void {
    this.seals += 1;
  }
}

describe('sameDeps', () => {
  it('distinguishes NaN from a changed value the way Object.is does', () => {
    expect(sameDeps([Number.NaN], [Number.NaN])).toBe(true);
    expect(sameDeps([0], [-0])).toBe(false);
    expect(sameDeps([1, 2], [1])).toBe(false);
  });
});

describe('Component.update', () => {
  it('paints once, then skips while the dependency tuple holds', () => {
    const row = new Row();
    const props: RowProps = { label: 'tool', tone: 'ok', body: { text: 'a' } };

    row.update(props);
    row.update(props);
    row.update({ ...props, body: props.body });

    expect(row.paints).toBe(1);
    expect(row.el.textContent).toBe('tool: a');
  });

  it('repaints when a dep moves, including inside a mutated payload', () => {
    const row = new Row();
    const body = { text: 'a' };
    row.update({ label: 'tool', tone: 'ok', body });

    body.text = 'ab';
    row.update({ label: 'tool', tone: 'ok', body });

    expect(row.paints).toBe(2);
    expect(row.el.textContent).toBe('tool: ab');
  });

  it('re-derives classes on every paint so a modifier cannot be left behind', () => {
    const row = new Row();
    row.update({ label: 'tool', tone: 'ok', body: { text: 'a' } });
    expect(row.el.className).toBe('row row--ok');

    row.update({ label: 'tool', tone: 'err', body: { text: 'a' } });
    expect(row.el.className).toBe('row row--err');
  });
});

describe('Component.dispose', () => {
  it('runs the bag and detaches listeners, and is idempotent', () => {
    const row = new Row();

    row.button.dispatchEvent(new Event('click'));
    expect(row.clicks).toHaveBeenCalledTimes(1);

    row.dispose();
    row.dispose();
    row.button.dispatchEvent(new Event('click'));
    expect(row.clicks).toHaveBeenCalledTimes(1);
  });

  it('runs a disposer added after disposal immediately', () => {
    const bag = new DisposableBag();
    bag.dispose();
    const late = vi.fn();
    bag.add(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('LiveComponent.seal', () => {
  it('appends while live and stops appending once sealed', () => {
    const row = new StreamRow();
    row.update({ label: 'agent', tone: 'ok', body: { text: 'he' } });
    row.update({ label: 'agent', tone: 'ok', body: { text: 'llo' } });

    expect(row.chunks).toBe(2);
    expect(row.body.textContent).toBe('hello');

    row.seal({ label: 'agent', tone: 'ok', body: { text: '' } });
    row.update({ label: 'agent', tone: 'ok', body: { text: 'tail' } });

    expect(row.chunks).toBe(2);
    expect(row.body.textContent).toBe('hello');
  });

  it('drops the streaming class by re-deriving it, not by name', () => {
    const row = new StreamRow();
    const props: RowProps = { label: 'agent', tone: 'ok', body: { text: 'x' } };
    row.update(props);
    expect(row.el.className).toContain('row--streaming');

    row.seal(props);
    expect(row.el.className).toBe('row row--ok');
  });

  it('performs zero DOM writes on the next update with the same props', () => {
    const row = new StreamRow();
    const props: RowProps = { label: 'agent', tone: 'ok', body: { text: 'x' } };
    row.update(props);
    row.seal(props);

    const observed: MutationRecord[] = [];
    const observer = new MutationObserver((records) => observed.push(...records));
    observer.observe(row.el, { attributes: true, childList: true, characterData: true, subtree: true });

    row.update(props);
    observer.takeRecords().forEach((record) => observed.push(record));
    observer.disconnect();

    expect(observed).toHaveLength(0);
    expect(row.paints).toBe(1);
  });

  it('is a one-way transition', () => {
    const row = new StreamRow();
    const props: RowProps = { label: 'agent', tone: 'ok', body: { text: 'x' } };
    row.update(props);
    row.seal(props);
    row.seal(props);
    expect(row.seals).toBe(1);
    expect(row.isLive).toBe(false);
  });
});
