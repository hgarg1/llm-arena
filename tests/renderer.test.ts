jest.mock('../src/config/db', () => ({ prisma: {} }));
jest.mock('../src/services/og-image.service', () => ({ renderOgImage: jest.fn() }));

import { resolveRenderer } from '../src/controllers/match.controller';

describe('resolveRenderer', () => {
  it('built-in games always use their own board, regardless of schema', () => {
    expect(resolveRenderer('chess', { renderer: 'poker' })).toBe('chess');
    expect(resolveRenderer('chutes_and_ladders', null)).toBe('chutes');
    expect(resolveRenderer('texas_holdem', undefined)).toBe('poker');
    expect(resolveRenderer('blackjack', {})).toBe('blackjack');
  });

  it('generated games default to the generic renderer', () => {
    expect(resolveRenderer('my-game', null)).toBe('generic');
    expect(resolveRenderer('my-game', {})).toBe('generic');
  });

  it('generated games can opt into a specialised renderer', () => {
    expect(resolveRenderer('my-game', { renderer: 'chess' })).toBe('chess');
    expect(resolveRenderer('my-game', { renderer: 'poker' })).toBe('poker');
  });

  it('unknown or malformed renderer names fall back to generic', () => {
    expect(resolveRenderer('my-game', { renderer: 'flash-player' })).toBe('generic');
    expect(resolveRenderer('my-game', { renderer: 42 })).toBe('generic');
    expect(resolveRenderer('my-game', 'chess')).toBe('generic');
  });
});
