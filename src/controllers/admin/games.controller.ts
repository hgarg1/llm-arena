import { Request, Response } from 'express';
import { prisma } from '../../config/db';
import { Prisma } from '@prisma/client';
import { logAdminAction } from '../../services/audit.service';
import { generateEngineBundle } from '../../services/engine-generator.service';
import fs from 'fs';
import path from 'path';
import { getGameEngine } from '../../game/registry';

const slugify = (input: string) =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 48);

const parseList = (value?: string) =>
  (value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

const allowIfNotDefined = (entitlements: any, key: string) => {
  if (!entitlements?.resolved?.[key]) return true;
  return entitlements.hasEntitlement(key);
};

const enforceModeIfDefined = (entitlements: any, key: string, mode: 'hidden' | 'view' | 'edit' | 'admin' | 'locked') => {
  if (!entitlements?.resolved?.[key]) return true;
  return entitlements.enforceMode(key, mode);
};

const parseSettingValue = (type: string, value: string): Prisma.InputJsonValue | typeof Prisma.DbNull => {
  if (value === undefined || value === null || value === '') return Prisma.DbNull;
  if (type === 'INT') return parseInt(value, 10);
  if (type === 'FLOAT') return parseFloat(value);
  if (type === 'BOOLEAN') return value === 'true' || value === 'on';
  return value;
};

const mapOptionsToEngine = (gameType: string, options: Record<string, any>) => {
  if (gameType === 'chess') {
    return {
      startFen: options.start_fen,
      maxPlies: options.max_plies,
      allowDraws: options.allow_draws,
      timeControlMinutes: options.time_control_minutes,
      incrementSeconds: options.increment_seconds
    };
  }
  if (gameType === 'chutes_and_ladders') {
    return {
      boardSize: options.board_size,
      winExact: options.win_exact,
      chutesEnabled: options.chutes_enabled,
      laddersEnabled: options.ladders_enabled
    };
  }
  if (gameType === 'texas_holdem') {
    return {
      startingStack: options.starting_stack,
      smallBlind: options.small_blind,
      bigBlind: options.big_blind
    };
  }
  if (gameType === 'blackjack') {
    return {
      startingStack: options.starting_stack,
      fixedBet: options.fixed_bet,
      dealerHitsSoft17: options.dealer_hits_soft_17,
      allowDouble: options.allow_double,
      deckCount: options.deck_count,
      blackjackPayout: options.blackjack_payout,
      allowInsurance: options.allow_insurance,
      allowSurrender: options.allow_surrender,
      allowDoubleAny: options.allow_double_any,
      allowSplit: options.allow_split,
      maxHands: options.max_hands,
      allowResplitAces: options.allow_resplit_aces,
      allowDoubleAfterSplit: options.allow_double_after_split,
      dealerPeek: options.dealer_peek,
      noHoleCard: options.no_hole_card
    };
  }
  return options;
};

export const listGames = async (req: Request, res: Response) => {
  const games = await prisma.gameDefinition.findMany({
    orderBy: { updated_at: 'desc' },
    include: {
      releases: { orderBy: { created_at: 'desc' }, take: 1 },
      settings: { select: { tier_required: true } }
    }
  });
  res.render('admin/games/index', {
    title: 'Game Builder',
    path: '/admin/games',
    games,
    success: req.query.success,
    error: req.query.error,
    newId: req.query.newId
  });
};

export const newGameDraft = async (req: Request, res: Response) => {
  const timestamp = Date.now().toString(36);
  const name = `New Game ${timestamp.toUpperCase()}`;
  const key = `game-${timestamp}`;
  const game = await prisma.gameDefinition.create({
    data: {
      name,
      key,
      status: 'DRAFT',
      capabilities: [],
      roles: []
    }
  });
  await prisma.gameRelease.create({
    data: {
      game_id: game.id,
      status: 'DRAFT'
    }
  });
  const bundle = await generateEngineBundle(
    { ...game, settings: [], ui_schema: null }
  );
  await prisma.gameEngineArtifact.create({
    data: {
      game_id: game.id,
      status: 'DRAFT',
      spec: bundle.spec,
      code_ts: bundle.code,
      tests_ts: bundle.tests,
      notes: bundle.notes,
      created_by: (req.session as any).userId
    }
  });
  if (bundle.uiSchema) {
    await prisma.gameUISchema.upsert({
      where: { game_id: game.id },
      update: { create_form_layout: bundle.uiSchema.create_form_layout },
      create: {
        game_id: game.id,
        create_form_layout: bundle.uiSchema.create_form_layout
      }
    });
  }
  const seed = Math.floor(Math.random() * 1000000);
  const demoMatch = await prisma.match.create({
    data: {
      game_type: game.key,
      seed,
      status: 'COMPLETED',
      ruleset_version: '0.0.1',
      created_by: (req.session as any).userId ? { connect: { id: (req.session as any).userId } } : undefined,
      finished_at: new Date()
    }
  });
  await prisma.matchEvent.createMany({
    data: [
      {
        match_id: demoMatch.id,
        turn_index: 0,
        actor_role: 'system',
        type: 'MATCH_START',
        payload: {
          game_key: game.key,
          seed,
          note: 'Draft game created. Replace with real engine implementation.'
        }
      },
      {
        match_id: demoMatch.id,
        turn_index: 1,
        actor_role: 'system',
        type: 'RESULT',
        payload: {
          outcome: 'stub',
          reason: 'draft_game_seed',
          note: 'Auto-seeded so the game appears in match history.'
        }
      }
    ]
  });
  await logAdminAction((req.session as any).userId, 'game.create', game.id, { key });
  res.redirect(`/admin/games/${game.id}?step=basics&success=Game created`);
};

export const deleteGame = async (req: Request, res: Response) => {
  const { id } = req.params;
  const game = await prisma.gameDefinition.findUnique({ where: { id } });
  if (!game) return res.redirect('/admin/games?error=Game not found');

  await prisma.gameDefinition.delete({ where: { id } });
  await logAdminAction((req.session as any).userId, 'game.delete', id, { key: game.key });
  res.redirect('/admin/games?success=Game deleted');
};

export const generateGameEngine = async (req: Request, res: Response) => {
  const { id } = req.params;
  const entitlements = (req as any).entitlements;
  const adminId = (req.session as any).userId;
  const orgId = (req.session as any).user?.org_id;
  if (!allowIfNotDefined(entitlements, 'engine.generate')) {
    return res.redirect(`/admin/games/${id}?step=review&error=Engine generation not allowed`);
  }
  if (!enforceModeIfDefined(entitlements, 'engine.generate', 'edit')) {
    return res.redirect(`/admin/games/${id}?step=review&error=Insufficient access mode to generate engine`);
  }
  if (entitlements?.resolved?.['engine.generate']) {
    const scope = orgId ? { type: 'org', id: orgId } : { type: 'user', id: adminId };
    const quotaResult = await entitlements.enforceQuota('engine.generate', scope);
    if (!quotaResult.allowed) {
      return res.redirect(`/admin/games/${id}?step=review&error=Engine generation quota exceeded`);
    }
  }
  const game = await prisma.gameDefinition.findUnique({
    where: { id },
    include: { settings: true, ui_schema: true }
  });
  if (!game) return res.redirect('/admin/games?error=Game not found');

  try {
    const bundle = await generateEngineBundle(game);
    await prisma.gameEngineArtifact.create({
      data: {
        game_id: game.id,
        status: 'DRAFT',
        spec: bundle.spec,
        code_ts: bundle.code,
        tests_ts: bundle.tests,
        notes: bundle.notes,
        created_by: (req.session as any).userId
      }
    });
    if (bundle.uiSchema) {
      await prisma.gameUISchema.upsert({
        where: { game_id: game.id },
        update: {
          create_form_layout: bundle.uiSchema.create_form_layout
        },
        create: {
          game_id: game.id,
          create_form_layout: bundle.uiSchema.create_form_layout
        }
      });
    }
    await logAdminAction((req.session as any).userId, 'game.engine.generate', id);
    if (entitlements?.resolved?.['engine.generate']) {
      const config = entitlements.entitlementValue('engine.generate');
      if (config?.limit) {
        const scope = orgId ? { type: 'org', id: orgId } : { type: 'user', id: adminId };
        await entitlements.incrementUsage({
          entitlementKey: 'engine.generate',
          scopeType: scope.type === 'org' ? 'ORG' : 'USER',
          scopeId: scope.id,
          window: config.window || 'day'
        });
      }
    }
    res.redirect(`/admin/games/${id}?step=review&success=Engine generated`);
  } catch (err) {
    await prisma.gameEngineArtifact.create({
      data: {
        game_id: game.id,
        status: 'FAILED',
        spec: { error: 'generation_failed' },
        code_ts: '',
        tests_ts: '',
        notes: String(err),
        created_by: (req.session as any).userId
      }
    });
    res.redirect(`/admin/games/${id}?step=review&error=Engine generation failed`);
  }
};

export const publishGameEngine = async (req: Request, res: Response) => {
  const { id } = req.params;
  const entitlements = (req as any).entitlements;
  if (!allowIfNotDefined(entitlements, 'engine.publish')) {
    return res.redirect(`/admin/games/${id}?step=review&error=Engine publish not allowed`);
  }
  if (!enforceModeIfDefined(entitlements, 'engine.publish', 'admin')) {
    return res.redirect(`/admin/games/${id}?step=review&error=Insufficient access mode to publish engine`);
  }
  const game = await prisma.gameDefinition.findUnique({
    where: { id },
    include: { 
        engine_artifacts: { orderBy: { created_at: 'desc' }, take: 1 },
        dry_runs: { orderBy: { created_at: 'desc' }, take: 1 }
    }
  });
  if (!game || !game.engine_artifacts?.[0]) {
    return res.redirect(`/admin/games/${id}?step=review&error=No engine artifact found`);
  }

  const artifact = game.engine_artifacts[0];
  const lastRun = game.dry_runs?.[0];

  if (!lastRun || lastRun.created_at < artifact.created_at) {
      return res.redirect(`/admin/games/${id}?step=review&error=Validation failed: You must run a successful simulation (Dry Run) on the latest engine before publishing.`);
  }

  const fileName = `${game.key}.ts`;
  const generatedDir = path.join(process.cwd(), 'src', 'game', 'generated');
  const targetPath = path.join(generatedDir, fileName);
  const distGeneratedDir = path.join(process.cwd(), 'dist', 'game', 'generated');

  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(targetPath, artifact.code_ts, 'utf8');
  if (artifact.tests_ts) {
    fs.writeFileSync(path.join(generatedDir, `${game.key}.test.ts`), artifact.tests_ts, 'utf8');
  }
  if (fs.existsSync(path.join(process.cwd(), 'dist'))) {
    fs.mkdirSync(distGeneratedDir, { recursive: true });
    fs.writeFileSync(path.join(distGeneratedDir, fileName), artifact.code_ts, 'utf8');
  }

  await prisma.gameEngineArtifact.update({
    where: { id: artifact.id },
    data: { status: 'PUBLISHED' }
  });
  await logAdminAction((req.session as any).userId, 'game.engine.publish', id);
  res.redirect(`/admin/games/${id}?step=review&success=Engine published`);
};

export const simulateGame = async (req: Request, res: Response) => {
  const { id } = req.params;
  const game = await prisma.gameDefinition.findUnique({
    where: { id },
    include: { settings: true }
  });
  if (!game) return res.redirect('/admin/games?error=Game not found');

  const settingsDefaults = game.settings.reduce<Record<string, any>>((acc, setting) => {
    acc[setting.key] = setting.default_value === null ? undefined : setting.default_value;
    return acc;
  }, {});

  const engineOptions = mapOptionsToEngine(game.key, settingsDefaults);
  const engine = await getGameEngine(game.key);
  const seed = Math.floor(Math.random() * 1000000);
  const events = (engine as any).initialize(seed, engineOptions) || [];

  const roles = (game.roles && game.roles.length > 0)
    ? game.roles
    : ['player1', 'player2'];

  const getDummyMove = (gameKey: string, actor: string, turn: number) => {
    if (gameKey === 'chess') {
      return actor === 'white' ? (turn === 0 ? 'e2e4' : 'd2d4') : (turn === 1 ? 'e7e5' : 'd7d5');
    }
    if (gameKey === 'texas_holdem') return 'CALL';
    if (gameKey === 'blackjack') return 'STAND';
    if (gameKey === 'chutes_and_ladders') return 'ACK';
    return 'PASS';
  };

  let gameState = [...events];
  let result = null;
  for (let i = 0; i < 5; i++) {
    const actor = roles[i % roles.length];
    const move = getDummyMove(game.key, actor, i);
    const step = (engine as any).processMove(gameState, {
      actor,
      content: move
    });
    if (step?.events?.length) {
      step.events.forEach((evt: any) => gameState.push(evt));
    }
    if (step?.result) {
      result = step.result;
      break;
    }
  }

  await prisma.gameDryRun.create({
    data: {
      game_id: game.id,
      seed,
      events: gameState,
      created_by: (req.session as any).userId
    }
  });

  await logAdminAction((req.session as any).userId, 'game.simulate', id, {
    seed,
    turns: 5,
    finished: Boolean(result)
  });
  res.redirect(`/admin/games/${id}?step=review&success=Simulation complete`);
};

export const gameWizard = async (req: Request, res: Response) => {
  const { id } = req.params;
  const step = (req.query.step as string) || 'basics';

  const game = await prisma.gameDefinition.findUnique({
    where: { id },
    include: {
      settings: { orderBy: { key: 'asc' } },
      releases: { orderBy: { created_at: 'desc' }, take: 1 },
      ui_schema: true,
      engine_artifacts: { orderBy: { created_at: 'desc' }, take: 1 },
      dry_runs: { orderBy: { created_at: 'desc' }, take: 1 }
    }
  });
  if (!game) return res.redirect('/admin/games');

  const buildUiPreview = () => {
    const fields: Array<{ label: string; key: string; type: string; tier?: string }> = [];
    const layout = game.ui_schema?.create_form_layout as any;
    const labels = game.ui_schema?.labels as any;
    if (Array.isArray(layout)) {
      layout.forEach((item: any) => {
        if (!item) return;
        fields.push({
          label: String(item.label || item.key || 'Field'),
          key: String(item.key || ''),
          type: String(item.type || 'text'),
          tier: item.tier ? String(item.tier) : undefined
        });
      });
    } else if (labels && Array.isArray(labels.fields)) {
      labels.fields.forEach((item: any) => {
        if (!item) return;
        fields.push({
          label: String(item.label || item.key || 'Field'),
          key: String(item.key || ''),
          type: String(item.type || 'text'),
          tier: item.tier ? String(item.tier) : undefined
        });
      });
    } else {
      (game.settings || []).forEach(s => {
        fields.push({
          label: s.key,
          key: s.key,
          type: s.type.toLowerCase(),
          tier: s.tier_required
        });
      });
    }
    return fields;
  };

  const warnings: string[] = [];
  let diffSummary: { title: string; items: string[]; updated_at?: Date } | null = null;
  let uiPreview: Array<{ label: string; key: string; type: string; tier?: string }> = [];
  if (step === 'review') {
    const hasSettings = (game.settings || []).length > 0;
    if (!hasSettings) warnings.push('No match configuration settings defined.');
    for (const setting of game.settings || []) {
      if (setting.default_value === null) {
        warnings.push(`Setting "${setting.key}" is missing a default value.`);
      }
      if (setting.type === 'ENUM' && (!setting.enum_options || setting.enum_options.length === 0)) {
        warnings.push(`Enum setting "${setting.key}" has no options.`);
      }
    }

    const tiers: Array<'FREE' | 'PRO' | 'ENTERPRISE'> = ['FREE', 'PRO', 'ENTERPRISE'];
    for (const tier of tiers) {
      for (const setting of game.settings || []) {
        if (setting.tier_required === tier && setting.default_value === null) {
          warnings.push(`Tier ${tier}: "${setting.key}" missing default.`);
        }
      }
    }

    const revisions = await prisma.gameRevision.findMany({
      where: { game_id: id },
      orderBy: { revision: 'desc' },
      take: 2
    });
    if (revisions.length >= 2) {
      const [current, previous] = revisions;
      const cur = current.snapshot as any;
      const prev = previous.snapshot as any;
      const changed: string[] = [];
      const basics: Array<keyof typeof cur> = ['name', 'key', 'description_short', 'description_long', 'roles', 'capabilities', 'max_players'];
      basics.forEach((field) => {
        if (JSON.stringify(cur[field]) !== JSON.stringify(prev[field])) {
          changed.push(`Basics: ${String(field)}`);
        }
      });
      if (JSON.stringify(cur.settings) !== JSON.stringify(prev.settings)) {
        changed.push('Match config settings updated');
      }
      if (JSON.stringify(cur.ui_schema) !== JSON.stringify(prev.ui_schema)) {
        changed.push('UI/UX schema updated');
      }
      diffSummary = {
        title: `Revision ${current.revision} vs ${previous.revision}`,
        items: changed.length > 0 ? changed : ['No structural changes detected'],
        updated_at: current.created_at
      };
    }

    uiPreview = buildUiPreview();
  }

  res.render('admin/games/wizard', {
    title: `Game Builder: ${game.name}`,
    path: '/admin/games',
    game,
    step,
    engineArtifact: game.engine_artifacts?.[0] || null,
    simulationEvents: game.dry_runs?.[0]?.events || null,
    warnings,
    diffSummary,
    uiPreview,
    success: req.query.success,
    error: req.query.error
  });
};

export const saveGameDraft = async (req: Request, res: Response) => {
  const { id } = req.params;
  const step = req.body.step || 'basics';
  const adminId = (req.session as any).userId;

  const game = await prisma.gameDefinition.findUnique({ where: { id } });
  if (!game) return res.redirect('/admin/games?error=Game not found');

  try {
    if (step === 'basics') {
      const name = req.body.name || game.name;
      const keyInput = req.body.key ? slugify(req.body.key) : game.key;
      const key = keyInput || game.key;
      const roles = parseList(req.body.roles);
      const capabilities = parseList(req.body.capabilities);
      const maxPlayers = req.body.max_players ? parseInt(req.body.max_players, 10) : null;
      await prisma.gameDefinition.update({
        where: { id },
        data: {
          name,
          key,
          description_short: req.body.description_short || null,
          description_long: req.body.description_long || null,
          roles,
          capabilities,
          max_players: maxPlayers || null
        }
      });
    }

    if (step === 'config') {
      const toArray = (value: any) => (Array.isArray(value) ? value : value ? [value] : []);
      const keys = toArray(req.body.setting_key);
      const types = toArray(req.body.setting_type);
      const mins = toArray(req.body.setting_min);
      const maxs = toArray(req.body.setting_max);
      const defaults = toArray(req.body.setting_default);
      const tiers = toArray(req.body.setting_tier);
      const helps = toArray(req.body.setting_help);
      const enums = toArray(req.body.setting_enum);

      const settings = keys
        .map((key: string, idx: number) => ({
          key: (key || '').trim(),
          type: types[idx] || 'TEXT',
          min: mins[idx],
          max: maxs[idx],
          default: defaults[idx],
          tier: tiers[idx] || 'FREE',
          help: helps[idx] || '',
          enum: enums[idx] || ''
        }))
        .filter((s: { key: string }) => s.key.length > 0);

      const errors: string[] = [];
      const allowedTypes = new Set(['BOOLEAN', 'INT', 'FLOAT', 'ENUM', 'TEXT']);
      const seenKeys = new Set<string>();
      settings.forEach(setting => {
        if (!allowedTypes.has(setting.type)) {
          errors.push(`Setting "${setting.key}" has invalid type.`);
        }
        if (seenKeys.has(setting.key)) {
          errors.push(`Duplicate key "${setting.key}".`);
        } else {
          seenKeys.add(setting.key);
        }
        if (!/^[a-zA-Z0-9_.-]+$/.test(setting.key)) {
          errors.push(`Invalid key "${setting.key}".`);
        }
        if (setting.type === 'ENUM') {
          const options = parseList(setting.enum);
          if (options.length === 0) {
            errors.push(`Enum "${setting.key}" requires options.`);
          }
          if (setting.default && options.length > 0 && !options.includes(String(setting.default).trim())) {
            errors.push(`Enum "${setting.key}" default must be in options.`);
          }
        }
        if (setting.type === 'BOOLEAN' && setting.default) {
          const val = String(setting.default).trim();
          if (val !== 'true' && val !== 'false') {
            errors.push(`Boolean "${setting.key}" default must be true or false.`);
          }
        }
        if (setting.type === 'INT' || setting.type === 'FLOAT') {
          const minVal = setting.min !== '' && setting.min !== undefined ? Number(setting.min) : null;
          const maxVal = setting.max !== '' && setting.max !== undefined ? Number(setting.max) : null;
          if (minVal !== null && Number.isNaN(minVal)) {
            errors.push(`Setting "${setting.key}" min must be numeric.`);
          }
          if (maxVal !== null && Number.isNaN(maxVal)) {
            errors.push(`Setting "${setting.key}" max must be numeric.`);
          }
          if (minVal !== null && maxVal !== null && minVal > maxVal) {
            errors.push(`Setting "${setting.key}" min cannot exceed max.`);
          }
          if (setting.default !== '' && setting.default !== undefined) {
            const def = Number(setting.default);
            if (Number.isNaN(def)) {
              errors.push(`Setting "${setting.key}" default must be numeric.`);
            } else {
              if (minVal !== null && def < minVal) errors.push(`Setting "${setting.key}" default below min.`);
              if (maxVal !== null && def > maxVal) errors.push(`Setting "${setting.key}" default above max.`);
            }
          }
        }
      });

      if (errors.length > 0) {
        return res.redirect(`/admin/games/${id}?step=config&error=${encodeURIComponent(errors[0])}`);
      }

      await prisma.$transaction(async tx => {
        await tx.gameSetting.deleteMany({ where: { game_id: id } });
        for (const setting of settings) {
          await tx.gameSetting.create({
            data: {
              game_id: id,
              key: setting.key,
              type: setting.type,
              min_value: parseSettingValue(setting.type, setting.min),
              max_value: parseSettingValue(setting.type, setting.max),
              default_value: parseSettingValue(setting.type, setting.default),
              tier_required: setting.tier,
              help_text: setting.help || null,
              enum_options: parseList(setting.enum)
            }
          });
        }
      });

      const updatedGame = await prisma.gameDefinition.findUnique({
        where: { id },
        include: { settings: true, ui_schema: true }
      });
      if (updatedGame) {
        const bundle = await generateEngineBundle(updatedGame);
        if (bundle.uiSchema) {
          await prisma.gameUISchema.upsert({
            where: { game_id: id },
            update: { create_form_layout: bundle.uiSchema.create_form_layout },
            create: {
              game_id: id,
              create_form_layout: bundle.uiSchema.create_form_layout
            }
          });
        }
      }
    }

    if (step === 'assets') {
      const toArray = (value: any) => (Array.isArray(value) ? value : value ? [value] : []);
      const keys = toArray(req.body.asset_keys);
      const urls = toArray(req.body.asset_urls);
      
      const assets: Record<string, string> = {};
      keys.forEach((key: string, idx: number) => {
          if (key && urls[idx]) {
              assets[key.trim()] = urls[idx].trim();
          }
      });

      await prisma.gameDefinition.update({
        where: { id },
        data: { assets }
      });
    }

    if (step === 'uiux') {
      const parseJson = (value: string | undefined, label: string) => {
        if (!value || value.trim().length === 0) return null;
        try {
          return JSON.parse(value);
        } catch (err) {
          throw new Error(`${label} JSON is invalid`);
        }
      };

      const createFormLayout = parseJson(req.body.create_form_layout, 'Create form layout');
      const summaryTemplate = parseJson(req.body.summary_template, 'Summary template');
      const labels = parseJson(req.body.labels, 'Labels');

      await prisma.gameUISchema.upsert({
        where: { game_id: id },
        update: {
          create_form_layout: createFormLayout,
          summary_template: summaryTemplate,
          labels
        },
        create: {
          game_id: id,
          create_form_layout: createFormLayout,
          summary_template: summaryTemplate,
          labels
        }
      });
    }

    const snapshot = await prisma.gameDefinition.findUnique({
      where: { id },
      include: { settings: true, ui_schema: true }
    });
    if (snapshot) {
      const revisionCount = await prisma.gameRevision.count({ where: { game_id: id } });
      await prisma.gameRevision.create({
        data: {
          game_id: id,
          revision: revisionCount + 1,
          snapshot,
          created_by: adminId
        }
      });
    }

    await logAdminAction(adminId, 'game.save', id, { step });

    const nextStep = step === 'basics' ? 'config' : step === 'config' ? 'assets' : step === 'assets' ? 'uiux' : 'review';
    if (req.body.action === 'continue') {
      return res.redirect(`/admin/games/${id}?step=${nextStep}&success=Game updated`);
    }
    return res.redirect(`/admin/games/${id}?step=${step}&success=Game updated`);
  } catch (err) {
    console.error(err);
    return res.redirect(`/admin/games/${id}?step=${step}&error=Failed to save`);
  }
};

export const publishGame = async (req: Request, res: Response) => {
  const { id } = req.params;
  const entitlements = (req as any).entitlements;
  if (!allowIfNotDefined(entitlements, 'engine.publish')) {
    return res.redirect(`/admin/games/${id}?step=review&error=Publish not allowed by entitlements`);
  }
  if (!enforceModeIfDefined(entitlements, 'engine.publish', 'admin')) {
    return res.redirect(`/admin/games/${id}?step=review&error=Insufficient access mode to publish`);
  }
  const action = req.body.action;
  const adminId = (req.session as any).userId;
  const game = await prisma.gameDefinition.findUnique({ where: { id } });
  if (!game) return res.redirect('/admin/games?error=Game not found');

  const latestDryRun = await prisma.gameDryRun.findFirst({
    where: { game_id: id },
    orderBy: { created_at: 'desc' }
  });
  if (action === 'publish' && !latestDryRun) {
    return res.redirect(`/admin/games/${id}?step=review&error=Run a dry run before publishing`);
  }

  const status =
    action === 'publish' ? 'LIVE' :
    action === 'schedule' ? 'SCHEDULED' :
    action === 'retire' ? 'RETIRED' :
    'DRAFT';

  const publishAt = action === 'schedule' && req.body.publish_at
    ? new Date(req.body.publish_at)
    : null;

  await prisma.gameDefinition.update({
    where: { id },
    data: { status }
  });
  await prisma.gameRelease.create({
    data: {
      game_id: id,
      status,
      publish_at: publishAt,
      published_by: adminId
    }
  });
  await logAdminAction(adminId, 'game.publish', id, { status, publishAt });
  const statusLabel =
    status === 'LIVE' ? 'published' :
    status === 'SCHEDULED' ? 'scheduled' :
    status === 'RETIRED' ? 'retired' :
    'saved';
  res.redirect(`/admin/games/${id}?step=review&success=Game ${statusLabel}`);
};
