const prismaMock: any = {
  gameDefinition: { findUnique: jest.fn(), update: jest.fn(), delete: jest.fn(), create: jest.fn(), findMany: jest.fn() },
  gameEngineArtifact: { updateMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  gameRevision: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
  gameRelease: { create: jest.fn() },
  gameDryRun: { create: jest.fn() },
  gameSetting: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn(), create: jest.fn() },
  gameUISchema: { upsert: jest.fn() },
  match: { count: jest.fn() },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg)))
};
jest.mock('../src/config/db', () => ({ prisma: prismaMock }));
jest.mock('../src/services/audit.service', () => ({ logAdminAction: jest.fn() }));
jest.mock('../src/services/game-release.service', () => ({ activateDueScheduledGames: jest.fn() }));
jest.mock('../src/services/default-games.service', () => ({ ensureDefaultGamesOnce: jest.fn() }));

import { saveGameDraft, deleteGame, simulateGame, publishGameEngine, publishGame, newGameDraft } from '../src/controllers/admin/games.controller';

const mkRes = () => {
  const res: any = { redirected: '' };
  res.redirect = (u: string) => { res.redirected = decodeURIComponent(u); };
  return res;
};
const req = (params: any, body: any = {}) => ({ params, body, session: { userId: 'admin' } }) as any;

const GOOD_CODE = `export default class G {
  initialize() { return [{ turn: 0, actor: 'system', type: 'S', payload: {} }]; }
  processMove(h: any, m: any) { return { events: [{ turn: h.length, actor: m.actor, type: 'M', payload: {} }], result: { isFinished: true, scores: { a: 1, b: 0 } } }; }
  getSystemPrompt(r: string) { return 'p ' + r; }
  getRandomMove(h: any, r: string) { return { actor: r, content: 'x' }; }
}`;

const baseGame = (over: any = {}) => ({ id: 'g1', key: 'my-game', name: 'My Game', status: 'LIVE', roles: ['a', 'b'], max_players: 2, settings: [], ...over });

beforeEach(() => {
  Object.values(prismaMock).forEach((group: any) => typeof group === 'object' && Object.values(group).forEach((fn: any) => fn?.mockClear?.()));
  prismaMock.gameRevision.findFirst.mockResolvedValue({ revision: 3 });
  prismaMock.gameRevision.create.mockResolvedValue({});
  prismaMock.gameDefinition.findUnique.mockResolvedValue(baseGame());
  prismaMock.gameDefinition.update.mockResolvedValue({});
  prismaMock.match.count.mockResolvedValue(0);
});

describe('game builder lifecycle', () => {
  it('creating a draft does not call an LLM and lands on the basics step', async () => {
    prismaMock.gameDefinition.create.mockResolvedValue({ id: 'new', key: 'game-x' });
    const res = mkRes();
    await newGameDraft(req({}), res);
    expect(res.redirected).toBe('/admin/games/new?step=basics&success=Game created');
    expect(prismaMock.gameEngineArtifact.create).not.toHaveBeenCalled();
  });

  it('a cosmetic save (assets) neither demotes the game nor unpublishes the engine', async () => {
    const res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'assets', asset_keys: 'logo', asset_urls: 'https://x/y.png' }), res);
    expect(res.redirected).toContain('success=Game updated');
    expect(prismaMock.gameEngineArtifact.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.gameRelease.create).not.toHaveBeenCalled();
    const revision = prismaMock.gameRevision.create.mock.calls[0][0].data;
    expect(revision.revision).toBe(4);
    expect(revision.snapshot._affects_engine).toBe(false);
  });

  it('changing roles takes a live game offline and unpublishes its engine', async () => {
    const res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'basics', name: 'My Game', key: 'my-game', roles: 'a,b,c', max_players: '3' }), res);
    expect(prismaMock.gameDefinition.update).toHaveBeenCalledWith({ where: { id: 'g1' }, data: { status: 'DRAFT' } });
    expect(prismaMock.gameEngineArtifact.updateMany).toHaveBeenCalledWith({ where: { game_id: 'g1', status: 'PUBLISHED' }, data: { status: 'DRAFT' } });
    expect(prismaMock.gameRevision.create.mock.calls[0][0].data.snapshot._affects_engine).toBe(true);
  });

  it('renaming only the display name is cosmetic', async () => {
    const res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'basics', name: 'Renamed', key: 'my-game', roles: 'a,b', max_players: '2' }), res);
    expect(prismaMock.gameEngineArtifact.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.gameRevision.create.mock.calls[0][0].data.snapshot._affects_engine).toBe(false);
  });

  it('refuses to change the key once matches exist', async () => {
    prismaMock.match.count.mockResolvedValue(12);
    const res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'basics', name: 'My Game', key: 'new-key', roles: 'a,b' }), res);
    expect(res.redirected).toMatch(/key cannot change after matches have been played/);
    expect(prismaMock.gameDefinition.update).not.toHaveBeenCalled();
  });

  it('refuses a key reserved by a built-in game or used by another game', async () => {
    let res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'basics', key: 'chess', roles: 'a,b' }), res);
    expect(res.redirected).toMatch(/reserved/);
    prismaMock.gameDefinition.findUnique.mockImplementation(async ({ where }: any) => (where.key ? { id: 'other' } : baseGame()));
    res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'basics', key: 'taken', roles: 'a,b' }), res);
    expect(res.redirected).toMatch(/already uses that key/);
  });

  it('retries revision numbering when a concurrent save wins the number', async () => {
    prismaMock.gameRevision.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' })).mockResolvedValueOnce({});
    prismaMock.gameRevision.findFirst.mockResolvedValueOnce({ revision: 3 }).mockResolvedValueOnce({ revision: 4 });
    const res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'assets' }), res);
    expect(res.redirected).toContain('success=Game updated');
    expect(prismaMock.gameRevision.create.mock.calls.map((c: any) => c[0].data.revision)).toEqual([4, 5]);
  });

  it('config saves rebuild the form layout locally and never call the engine generator', async () => {
    prismaMock.gameSetting.findMany.mockResolvedValue([{ key: 'rounds', type: 'INT', tier_required: 'FREE' }]);
    const res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'config', setting_key: 'rounds', setting_type: 'INT', setting_default: '3', setting_tier: 'FREE' }), res);
    expect(res.redirected).toContain('success=Game updated');
    const layout = prismaMock.gameUISchema.upsert.mock.calls[0][0].update.create_form_layout;
    expect(layout[0]).toMatchObject({ key: 'rounds', type: 'number' });
    expect(prismaMock.gameEngineArtifact.create).not.toHaveBeenCalled();
  });

  it('saves the chosen replay renderer with the UI schema, and rejects unknown ones', async () => {
    let res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'uiux', create_form_layout: '', summary_template: '', labels: '', replay_renderer: 'poker' }), res);
    expect(res.redirected).toContain('success=Game updated');
    expect(prismaMock.gameUISchema.upsert.mock.calls[0][0].update.replay_schema).toEqual({ renderer: 'poker' });
    prismaMock.gameUISchema.upsert.mockClear();
    res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'uiux', create_form_layout: '', replay_renderer: '<script>' }), res);
    expect(res.redirected).toContain('error=Unknown replay renderer');
    expect(prismaMock.gameUISchema.upsert).not.toHaveBeenCalled();
  });

  it('tells the admin which JSON field is invalid instead of a generic failure', async () => {
    const res = mkRes();
    await saveGameDraft(req({ id: 'g1' }, { step: 'uiux', create_form_layout: '{oops', replay_renderer: 'generic' }), res);
    expect(res.redirected).toContain('error=Create form layout JSON is invalid');
  });

  it('will not delete a game that has match history', async () => {
    prismaMock.match.count.mockResolvedValue(3);
    const res = mkRes();
    await deleteGame(req({ id: 'g1' }), res);
    expect(res.redirected).toMatch(/3 recorded match/);
    expect(prismaMock.gameDefinition.delete).not.toHaveBeenCalled();
  });

  it('deletes a game with no history', async () => {
    const res = mkRes();
    await deleteGame(req({ id: 'g1' }), res);
    expect(prismaMock.gameDefinition.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
  });

  it('validation records every check and passes a good engine', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(baseGame({
      engine_artifacts: [{ id: 'art', created_at: new Date('2026-02-01'), code_ts: GOOD_CODE }]
    }));
    prismaMock.gameRevision.findMany.mockResolvedValue([{ revision: 1, created_at: new Date('2026-01-01'), snapshot: {} }]);
    const res = mkRes();
    await simulateGame(req({ id: 'g1' }), res);
    expect(res.redirected).toMatch(/Validation passed/);
    const data = prismaMock.gameDryRun.create.mock.calls[0][0].data;
    expect(data.success).toBe(true);
    expect(data.checks.length).toBeGreaterThanOrEqual(5);
    expect(data.engine_artifact_id).toBe('art');
  });

  it('validation fails with the reason when the engine breaks the contract', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(baseGame({
      engine_artifacts: [{ id: 'art', created_at: new Date('2026-02-01'), code_ts: GOOD_CODE.replace('scores: { a: 1, b: 0 }', 'scores: {}') }]
    }));
    prismaMock.gameRevision.findMany.mockResolvedValue([]);
    const res = mkRes();
    await simulateGame(req({ id: 'g1' }), res);
    expect(res.redirected).toMatch(/Validation failed.*scores is empty/);
    expect(prismaMock.gameDryRun.create.mock.calls[0][0].data.success).toBe(false);
  });

  it('a cosmetic revision after generation does not make the engine stale', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(baseGame({
      engine_artifacts: [{ id: 'art', created_at: new Date('2026-02-01'), code_ts: GOOD_CODE }]
    }));
    prismaMock.gameRevision.findMany.mockResolvedValue([
      { revision: 5, created_at: new Date('2026-03-01'), snapshot: { _affects_engine: false } },
      { revision: 4, created_at: new Date('2026-01-01'), snapshot: { _affects_engine: true } }
    ]);
    const res = mkRes();
    await simulateGame(req({ id: 'g1' }), res);
    expect(res.redirected).toMatch(/Validation passed/);
  });

  it('but an engine-affecting revision after generation does', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(baseGame({
      engine_artifacts: [{ id: 'art', created_at: new Date('2026-02-01'), code_ts: GOOD_CODE }]
    }));
    prismaMock.gameRevision.findMany.mockResolvedValue([{ revision: 5, created_at: new Date('2026-03-01'), snapshot: { _affects_engine: true } }]);
    const res = mkRes();
    await simulateGame(req({ id: 'g1' }), res);
    expect(res.redirected).toMatch(/stale/);
  });

  describe('publishing', () => {
    const publishable = (over: any = {}) => baseGame({
      engine_artifacts: [{ id: 'art', status: 'DRAFT', compiled_at: new Date(), compile_error: null, used_fallback: false, created_at: new Date('2026-02-01'), code_ts: GOOD_CODE, tests_ts: null, notes: '' }],
      dry_runs: [{ id: 'run', success: true, engine_artifact_id: 'art', created_at: new Date('2026-02-02') }],
      ...over
    });

    it('publishes straight to the database, no filesystem involved', async () => {
      prismaMock.gameDefinition.findUnique.mockResolvedValue(publishable());
      prismaMock.gameRevision.findMany.mockResolvedValue([]);
      const fs = require('fs');
      const write = jest.spyOn(fs, 'writeFileSync');
      const res = mkRes();
      await publishGameEngine(req({ id: 'g1' }), res);
      expect(res.redirected).toMatch(/Engine published/);
      expect(write).not.toHaveBeenCalled();
      expect(prismaMock.gameEngineArtifact.update).toHaveBeenCalledWith({ where: { id: 'art' }, data: { status: 'PUBLISHED' } });
      write.mockRestore();
    });

    it('blocks publishing without a passing dry run on this artifact', async () => {
      prismaMock.gameRevision.findMany.mockResolvedValue([]);
      prismaMock.gameDefinition.findUnique.mockResolvedValue(publishable({ dry_runs: [{ id: 'run', success: false, engine_artifact_id: 'art', created_at: new Date('2026-02-02') }] }));
      let res = mkRes();
      await publishGameEngine(req({ id: 'g1' }), res);
      expect(res.redirected).toMatch(/successful Dry Run/);
      prismaMock.gameDefinition.findUnique.mockResolvedValue(publishable({ dry_runs: [{ id: 'run', success: true, engine_artifact_id: 'other', created_at: new Date('2026-02-02') }] }));
      res = mkRes();
      await publishGameEngine(req({ id: 'g1' }), res);
      expect(res.redirected).toMatch(/successful Dry Run/);
    });

    it('blocks fallback stubs and stale artifacts', async () => {
      prismaMock.gameRevision.findMany.mockResolvedValue([]);
      const stub = publishable();
      stub.engine_artifacts[0].used_fallback = true;
      prismaMock.gameDefinition.findUnique.mockResolvedValue(stub);
      let res = mkRes();
      await publishGameEngine(req({ id: 'g1' }), res);
      expect(res.redirected).toMatch(/Fallback stub/);
      prismaMock.gameDefinition.findUnique.mockResolvedValue(publishable());
      prismaMock.gameRevision.findMany.mockResolvedValue([{ revision: 9, created_at: new Date('2026-04-01'), snapshot: {} }]);
      res = mkRes();
      await publishGameEngine(req({ id: 'g1' }), res);
      expect(res.redirected).toMatch(/stale/);
    });

    it('going live requires a published, validated engine; scheduling requires a future date', async () => {
      prismaMock.gameRevision.findMany.mockResolvedValue([]);
      prismaMock.gameDefinition.findUnique.mockResolvedValue(publishable());
      let res = mkRes();
      await publishGame(req({ id: 'g1' }, { action: 'publish' }), res);
      expect(res.redirected).toMatch(/Publish the latest engine runtime/);
      res = mkRes();
      await publishGame(req({ id: 'g1' }, { action: 'schedule', publish_at: '2000-01-01T00:00' }), res);
      expect(res.redirected).toMatch(/future date/);
      const live = publishable();
      live.engine_artifacts[0].status = 'PUBLISHED';
      prismaMock.gameDefinition.findUnique.mockResolvedValue(live);
      res = mkRes();
      await publishGame(req({ id: 'g1' }, { action: 'publish' }), res);
      expect(res.redirected).toMatch(/Game published/);
      expect(prismaMock.gameDefinition.update).toHaveBeenCalledWith({ where: { id: 'g1' }, data: { status: 'LIVE' } });
    });
  });
});
