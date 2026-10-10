import * as smd from 'streaming-markdown';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSafeRenderer } from './harness-markdown';

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Just enough DOM for smd's default renderer on headings and paragraphs. */
class FakeNode {
  readonly childNodes: FakeNode[] = [];
  constructor(readonly nodeType: number, public data = '', readonly tagName = '') {}
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get children(): FakeNode[] {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE);
  }
  appendChild(node: FakeNode): FakeNode {
    this.childNodes.push(node);
    return node;
  }
  appendData(text: string): void {
    this.data += text;
  }
  setAttribute(): void {}
}

beforeEach(() => {
  vi.stubGlobal('Node', { TEXT_NODE, ELEMENT_NODE });
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeNode(ELEMENT_NODE, '', tag.toUpperCase()),
    createTextNode: (text: string) => new FakeNode(TEXT_NODE, text),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('makeSafeRenderer streaming text', () => {
  it('keeps Thai combining marks in the same text node as their base when chunks split them', () => {
    const root = new FakeNode(ELEMENT_NODE, '', 'DIV');
    const parser = smd.parser(makeSafeRenderer(root as unknown as HTMLElement));
    // Token-sized chunks that cut between a base letter and its marks.
    for (const chunk of ['## ต', '่างจาก spec ที', '่อนุมัต', 'ิ\n\nส', '่ง ที่มีคำใหม', '่\n']) {
      smd.parser_write(parser, chunk);
    }
    smd.parser_end(parser);

    const [heading, paragraph] = root.children;
    expect(heading.tagName).toBe('H2');
    expect(heading.childNodes.map((n) => n.data)).toEqual(['ต่างจาก spec ที่อนุมัติ']);
    expect(paragraph.childNodes.map((n) => n.data)).toEqual(['ส่ง ที่มีคำใหม่']);
  });
});
