// eslint-disable-next-line @typescript-eslint/no-var-requires
const NavState: any = require('../public/js/nav-state.js');

describe('nextCondensed (scroll hysteresis)', () => {
  it('stays expanded near the top and condenses once scrolled past the threshold', () => {
    expect(NavState.nextCondensed(false, 0)).toBe(false);
    expect(NavState.nextCondensed(false, 80)).toBe(false);
    expect(NavState.nextCondensed(false, 81)).toBe(true);
  });

  it('does not flicker: once condensed it only expands again near the very top', () => {
    expect(NavState.nextCondensed(true, 79)).toBe(true);
    expect(NavState.nextCondensed(true, 40)).toBe(true);
    expect(NavState.nextCondensed(true, 24)).toBe(true);
    expect(NavState.nextCondensed(true, 23)).toBe(false);
    expect(NavState.nextCondensed(true, 0)).toBe(false);
  });

  it('a jittery scroll position around the threshold never toggles repeatedly', () => {
    let state = false;
    let flips = 0;
    for (const y of [78, 82, 79, 83, 77, 85, 60, 90, 70, 100]) {
      const next: boolean = NavState.nextCondensed(state, y);
      if (next !== state) flips++;
      state = next;
    }
    expect(flips).toBe(1);
  });

  it('treats negative (overscroll bounce) positions as the top, and honours custom thresholds', () => {
    expect(NavState.nextCondensed(true, -50)).toBe(false);
    expect(NavState.nextCondensed(false, -50)).toBe(false);
    expect(NavState.nextCondensed(false, 150, { enterAt: 200 })).toBe(false);
    expect(NavState.nextCondensed(false, 250, { enterAt: 200 })).toBe(true);
  });
});

describe('nextHidden (phone top bar)', () => {
  it('never hides near the top of the page', () => {
    expect(NavState.nextHidden(true, 200, 100)).toBe(false);
    expect(NavState.nextHidden(false, 150, 100)).toBe(false);
    expect(NavState.nextHidden(true, 0, 500)).toBe(false);
  });

  it('hides while scrolling down and reveals on any real upward scroll', () => {
    expect(NavState.nextHidden(false, 600, 400)).toBe(true);
    expect(NavState.nextHidden(true, 580, 600)).toBe(false);
    expect(NavState.nextHidden(true, 590, 600)).toBe(false); // exactly the delta threshold counts
  });

  it('ignores sub-threshold jitter and keeps the previous state', () => {
    expect(NavState.nextHidden(true, 605, 600)).toBe(true);
    expect(NavState.nextHidden(false, 595, 600)).toBe(false);
    expect(NavState.nextHidden(true, 600, 600)).toBe(true);
  });

  it('a long scroll down then a small nudge up behaves like a native app bar', () => {
    let hidden = false;
    let last = 0;
    const steps: Array<[number, boolean]> = [[100, false], [250, true], [400, true], [392, true], [380, false], [500, true]];
    for (const [y, expected] of steps) {
      hidden = NavState.nextHidden(hidden, y, last);
      last = y;
      expect(hidden).toBe(expected);
    }
  });
});

describe('modeFor', () => {
  it('uses the same 1024px breakpoint as the stylesheet', () => {
    expect(NavState.modeFor(320)).toBe('mobile');
    expect(NavState.modeFor(1023)).toBe('mobile');
    expect(NavState.modeFor(1024)).toBe('desktop');
    expect(NavState.modeFor(1920)).toBe('desktop');
  });
});
