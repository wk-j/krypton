import { afterEach, describe, expect, it, vi } from 'vitest';

import { hydrateTreeNav } from '.';

describe('hydrateTreeNav', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    document.body.replaceChildren();
  });

  it('restores the saved scroll and saves the next one once per frame', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => frames.push(cb));
    sessionStorage.setItem('kav:/analyses?project=p-b', '240');
    const pane = document.createElement('nav');
    document.body.append(pane);

    const dispose = hydrateTreeNav(pane, 'kav:/analyses?project=p-b');
    expect(pane.scrollTop).toBe(240);

    pane.scrollTop = 480;
    pane.dispatchEvent(new Event('scroll'));
    pane.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(sessionStorage.getItem('kav:/analyses?project=p-b')).toBe('480');
    // Another project's key is untouched.
    expect(sessionStorage.getItem('kav:/analyses?project=p-a')).toBeNull();

    dispose();
    pane.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(1);
  });
});
