import { Request, Response } from 'express';
import { prisma } from '../../config/db';
import { Prisma } from '@prisma/client';
import { logAdminAction } from '../../services/audit.service';
import { generateEngineBundle } from '../../services/engine-generator.service';
import { mapOptionsToEngine } from '../../game/options';
import { validateEngine } from '../../services/game-validation.service';
import {
  BUILT_IN_GAME_KEYS,
  instantiateGameEngineArtifact,
  transpileGameEngineArtifact
} from '../../services/game-engine-artifact.service';
import { activateDueScheduledGames } from '../../services/game-release.service';
import { ensureDefaultGamesOnce } from '../../services/default-games.service';
import { parseLocalDateTime } from '../../utils/local-datetime';
import { buildUiSchemaFromSettings } from '../../services/engine-generator.service';

/** A problem with the submitted form that the admin can fix; its message is shown as-is. */
class FormError extends Error {}

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

const isBuiltInGameKey = (gameKey: string) => BUILT_IN_GAME_KEYS.has(gameKey);

const sanitizeGeneratedUiSchema = (
  settings: Array<{ key: string }>,
  uiSchema: { create_form_layout?: any; summary_template?: any; labels?: any } | null
) => {
  if (!uiSchema) return null;

  const validKeys = new Set(settings.map(setting => setting.key));
  const sanitizedLayout = Array.isArray(uiSchema.create_form_layout)
    ? uiSchema.create_form_layout.filter((item: any) => item && validKeys.has(String(item.key || '')))
    : null;
  const sanitizedLabels = uiSchema.labels && Array.isArray(uiSchema.labels.fields)
    ? {
        ...uiSchema.labels,
        fields: uiSchema.labels.fields.filter((item: any) => item && validKeys.has(String(item.key || '')))
      }
    : uiSchema.labels ?? null;

  return {
    create_form_layout: (sanitizedLayout ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
    summary_template: (uiSchema.summary_template ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
    labels: (sanitizedLabels ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull
  };
};

const validateUiSchemaReferences = (
  settings: Array<{ key: string }>,
  createFormLayout: any,
  labels: any
) => {
  const validKeys = new Set(settings.map(setting => setting.key));
  const unknownKeys = new Set<string>();

  if (Array.isArray(createFormLayout)) {
    createFormLayout.forEach((item: any) => {
      const key = String(item?.key || '').trim();
      if (key && !validKeys.has(key)) {
        unknownKeys.add(key);
      }
    });
  }

  if (labels && Array.isArray(labels.fields)) {
    labels.fields.forEach((item: any) => {
      const key = String(item?.key || '').trim();
      if (key && !validKeys.has(key)) {
        unknownKeys.add(key);
      }
    });
  }

  if (unknownKeys.size > 0) {
    throw new FormError(`UI schema references unknown settings: ${Array.from(unknownKeys).join(', ')}`);
  }
};

/**
 * Latest saved revision that changed something the engine depends on (roles, players, settings).
 * Cosmetic saves (assets, UI layout) record `_affects_engine: false` and never make an engine stale.
 * Legacy revisions without the flag are treated as engine-affecting.
 */
const latestEngineRevision = async (gameId: string) => {
  const recent = await prisma.gameRevision.findMany({
    where: { game_id: gameId },
    orderBy: { revision: 'desc' },
    take: 25,
    select: { revision: true, created_at: true, snapshot: true }
  });
  return recent.find(r => (r.snapshot as any)?._affects_engine !== false) || null;
};

const isArtifactStale = (artifact: { created_at: Date } | null, revision: { created_at: Date } | null) =>
  Boolean(artifact && revision && artifact.created_at < revision.created_at);

const isDryRunStale = (dryRun: { created_at: Date } | null, revision: { created_at: Date } | null) =>
  Boolean(dryRun && revision && dryRun.created_at < revision.created_at);

const buildArtifactRecord = (
  gameKey: string,
  bundle: {
    spec: Record<string, any>;
    code: string;
    tests: string;
    notes: string;
    generationProvider: string;
    usedFallback: boolean;
    generationError: string | null;
  }
) => {
  const compiled = transpileGameEngineArtifact(gameKey, bundle.code);
  return {
    status: compiled.ok ? ('DRAFT' as const) : ('FAILED' as const),
    spec: bundle.spec,
    code_ts: bundle.code,
    tests_ts: bundle.tests,
    generation_provider: bundle.generationProvider,
    used_fallback: bundle.usedFallback,
    generation_error: bundle.generationError,
    notes: compiled.ok
      ? bundle.notes
      : [bundle.notes, 'Compile failed', compiled.diagnostics.join('\n')].filter(Boolean).join('\n\n'),
    compile_error: compiled.ok ? null : compiled.diagnostics.join('\n'),
    compiled_at: compiled.ok ? new Date() : null
  };
};

const getSettingsDefaults = (game: { settings: Array<{ key: string; default_value: any }> }) =>
  game.settings.reduce<Record<string, any>>((acc, setting) => {
    acc[setting.key] = setting.default_value === null ? undefined : setting.default_value;
    return acc;
  }, {});

const runArtifactValidation = (
  game: { key: string; roles: string[]; settings: Array<{ key: string; default_value: any }> },
  artifactCode: string
) => {
  const options = mapOptionsToEngine(game.key, getSettingsDefaults(game));
  // Fail fast (and with a clear message) if the artifact does not even compile or load.
  instantiateGameEngineArtifact(game.key, artifactCode).dispose?.();
  return validateEngine(() => instantiateGameEngineArtifact(game.key, artifactCode), {
    roles: game.roles,
    options
  });
};

export const listGames = async (req: Request, res: Response) => {
  await ensureDefaultGamesOnce();
  await activateDueScheduledGames();
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
    builtInKeys: Array.from(BUILT_IN_GAME_KEYS),
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
      roles: [],
      releases: { create: { status: 'DRAFT' } }
    }
  });
  // The engine is generated explicitly from the review step once roles and settings exist; doing it here
  // would block the request on an LLM call, bypass quotas, and always produce an unpublishable stub.
  await logAdminAction((req.session as any).userId, 'game.create', game.id, { key });
  res.redirect(`/admin/games/${game.id}?step=basics&success=Game created`);
};

export const deleteGame = async (req: Request, res: Response) => {
  const { id } = req.params;
  const game = await prisma.gameDefinition.findUnique({ where: { id } });
  if (!game) return res.redirect('/admin/games?error=Game not found');
  if (isBuiltInGameKey(game.key)) {
    return res.redirect('/admin/games?error=Built-in games are managed by code and cannot be deleted');
  }

  const matchCount = await prisma.match.count({ where: { game_type: game.key } });
  if (matchCount > 0) {
    return res.redirect(`/admin/games/${id}?step=review&error=${encodeURIComponent(`This game has ${matchCount} recorded match(es). Retire it instead of deleting so match history stays replayable.`)}`);
  }

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
  const game = await prisma.gameDefinition.findUnique({
    where: { id },
    include: { settings: true, ui_schema: true }
  });
  if (!game) return res.redirect('/admin/games?error=Game not found');
  if (isBuiltInGameKey(game.key)) {
    return res.redirect(`/admin/games/${id}?step=review&error=Built-in games use code-managed engines and cannot generate custom runtimes`);
  }

  // Reserve generation quota atomically before spending an LLM call; refund it if generation throws.
  let reservation: { allowed: boolean; release: () => Promise<unknown> } = { allowed: true, release: async () => undefined };
  if (entitlements?.resolved?.['engine.generate'] && entitlements.reserveQuota) {
    const scope = orgId ? { type: 'org' as const, id: orgId } : { type: 'user' as const, id: adminId };
    reservation = await entitlements.reserveQuota('engine.generate', scope);
    if (!reservation.allowed) {
      return res.redirect(`/admin/games/${id}?step=review&error=Engine generation quota exceeded`);
    }
  }

  try {
    const bundle = await generateEngineBundle(game);
    const artifactData = buildArtifactRecord(game.key, bundle);
    await prisma.gameEngineArtifact.create({
      data: {
        game_id: game.id,
        ...artifactData,
        created_by: (req.session as any).userId
      }
    });
    const generatedUiSchema = sanitizeGeneratedUiSchema(game.settings, bundle.uiSchema);
    if (generatedUiSchema) {
      await prisma.gameUISchema.upsert({
        where: { game_id: game.id },
        update: generatedUiSchema,
        create: {
          game_id: game.id,
          ...generatedUiSchema
        }
      });
    }
    await logAdminAction((req.session as any).userId, 'game.engine.generate', id);
    const generationMessage = artifactData.status === 'FAILED'
      ? 'Engine generated but compile failed'
      : 'Engine generated';
    res.redirect(`/admin/games/${id}?step=review&success=${encodeURIComponent(generationMessage)}`);
  } catch (err) {
    await reservation.release().catch(() => undefined);
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
  if (isBuiltInGameKey(game.key)) {
    return res.redirect(`/admin/games/${id}?step=review&error=Built-in games do not publish generated runtimes`);
  }

  const artifact = game.engine_artifacts[0];
  const lastRun = game.dry_runs?.[0];
  const latestRevision = await latestEngineRevision(game.id);

  if (artifact.status === 'FAILED' || artifact.compile_error || !artifact.compiled_at) {
      return res.redirect(`/admin/games/${id}?step=review&error=Validation failed: Latest engine artifact did not compile successfully.`);
  }
  if (artifact.used_fallback) {
      return res.redirect(`/admin/games/${id}?step=review&error=Validation failed: Fallback stub engines cannot be published. Generate a real engine first.`);
  }
  if (isArtifactStale(artifact, latestRevision)) {
      return res.redirect(`/admin/games/${id}?step=review&error=Validation failed: Latest engine artifact is stale. Regenerate after your latest game edits.`);
  }
  if (isDryRunStale(lastRun || null, latestRevision)) {
      return res.redirect(`/admin/games/${id}?step=review&error=Validation failed: Latest Dry Run predates your latest game edits.`);
  }
  if (!lastRun || !lastRun.success || lastRun.engine_artifact_id !== artifact.id) {
      return res.redirect(`/admin/games/${id}?step=review&error=Validation failed: You must run a successful Dry Run on the latest engine artifact before publishing.`);
  }

  try {
    // The runtime is served straight from the database; publishing only has to prove it still compiles and loads.
    instantiateGameEngineArtifact(game.key, artifact.code_ts).dispose?.();
  } catch (err: any) {
    await prisma.gameEngineArtifact.update({
      where: { id: artifact.id },
      data: {
        status: 'FAILED',
        compile_error: String(err?.message || err),
        notes: [artifact.notes, 'Publish compile failed', String(err?.message || err)].filter(Boolean).join('\n\n')
      }
    });
    return res.redirect(`/admin/games/${id}?step=review&error=Engine publish failed during runtime compile.`);
  }

  await prisma.$transaction([
    prisma.gameEngineArtifact.updateMany({
      where: { game_id: game.id, status: 'PUBLISHED', NOT: { id: artifact.id } },
      data: { status: 'DRAFT' }
    }),
    prisma.gameEngineArtifact.update({
      where: { id: artifact.id },
      data: { status: 'PUBLISHED' }
    })
  ]);
  await logAdminAction((req.session as any).userId, 'game.engine.publish', id);
  res.redirect(`/admin/games/${id}?step=review&success=Engine published`);
};

export const simulateGame = async (req: Request, res: Response) => {
  const { id } = req.params;
  const game = await prisma.gameDefinition.findUnique({
    where: { id },
    include: {
      settings: true,
      engine_artifacts: { orderBy: { created_at: 'desc' }, take: 1 }
    }
  });
  if (!game) return res.redirect('/admin/games?error=Game not found');
  if (isBuiltInGameKey(game.key)) {
    return res.redirect(`/admin/games/${id}?step=review&error=Built-in games do not use generated dry-run validation`);
  }
  const latestArtifact = game.engine_artifacts?.[0] || null;
  const latestRevision = await latestEngineRevision(game.id);

  try {
    if (!isBuiltInGameKey(game.key) && !latestArtifact) {
      throw new Error('Generate an engine artifact before running a dry run.');
    }
    if (isArtifactStale(latestArtifact, latestRevision)) {
      throw new Error('Latest engine artifact is stale. Regenerate after your latest game edits.');
    }

    if (!latestArtifact) throw new Error('Generate an engine artifact before running a dry run.');
    const report = runArtifactValidation(game, latestArtifact.code_ts);
    const failed = report.checks.filter(check => !check.ok);

    await prisma.gameDryRun.create({
      data: {
        game_id: game.id,
        engine_artifact_id: latestArtifact.id,
        seed: report.seed,
        success: report.ok,
        events: report.sampleEvents as unknown as Prisma.InputJsonValue,
        checks: report.checks as unknown as Prisma.InputJsonValue,
        error_message: failed.length ? failed.map(c => `${c.name}: ${c.detail}`).join('\n') : null,
        created_by: (req.session as any).userId
      }
    });

    await logAdminAction((req.session as any).userId, 'game.simulate', id, {
      seed: report.seed,
      passed: report.ok,
      failedChecks: failed.map(c => c.name),
      artifactId: latestArtifact.id
    });
    if (!report.ok) {
      return res.redirect(`/admin/games/${id}?step=review&error=${encodeURIComponent(`Validation failed: ${failed[0].name}. ${failed[0].detail || ''}`)}`);
    }
    return res.redirect(`/admin/games/${id}?step=review&success=${encodeURIComponent(`Validation passed (${report.checks.length} checks)`)}`);
  } catch (err: any) {
    await prisma.gameDryRun.create({
      data: {
        game_id: game.id,
        engine_artifact_id: latestArtifact?.id || null,
        seed: Math.floor(Math.random() * 1000000),
        success: false,
        events: [],
        error_message: String(err?.message || err),
        created_by: (req.session as any).userId
      }
    });
    res.redirect(`/admin/games/${id}?step=review&error=${encodeURIComponent(String(err?.message || err))}`);
  }
};

export const gameWizard = async (req: Request, res: Response) => {
  const { id } = req.params;
  const step = (req.query.step as string) || 'basics';
  await activateDueScheduledGames();

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
    const latestRevision = await latestEngineRevision(id);
    const latestArtifact = game.engine_artifacts?.[0] || null;
    const latestDryRun = game.dry_runs?.[0] || null;
    if (latestArtifact?.used_fallback) {
      warnings.push('Latest engine artifact is a fallback stub. It cannot be published until you generate a real engine successfully.');
    }
    if (latestArtifact?.generation_error) {
      warnings.push(`Latest generation issue: ${latestArtifact.generation_error}`);
    }
    if (isArtifactStale(latestArtifact, latestRevision)) {
      warnings.push('Latest engine artifact predates the most recent saved revision. Regenerate before publishing.');
    }
    if (isDryRunStale(latestDryRun, latestRevision)) {
      warnings.push('Latest dry run predates the most recent saved revision. Run Dry Run again before publishing.');
    }
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
    latestDryRun: game.dry_runs?.[0] || null,
    simulationEvents: game.dry_runs?.[0]?.events || null,
    builtInReadOnly: isBuiltInGameKey(game.key),
    warnings,
    diffSummary,
    uiPreview,
    success: req.query.success,
    error: req.query.error,
    warning: req.query.warning
  });
};

export const saveGameDraft = async (req: Request, res: Response) => {
  const { id } = req.params;
  const step = req.body.step || 'basics';
  const adminId = (req.session as any).userId;

  const game = await prisma.gameDefinition.findUnique({ where: { id } });
  if (!game) return res.redirect('/admin/games?error=Game not found');
  if (isBuiltInGameKey(game.key)) {
    return res.redirect(`/admin/games/${id}?step=${step}&error=Built-in games are read-only in the admin portal`);
  }

  let affectsEngine = false;
  try {
    const previousKey = game.key;
    if (step === 'basics') {
      const name = req.body.name || game.name;
      const keyInput = req.body.key ? slugify(req.body.key) : game.key;
      const key = keyInput || game.key;
      const roles = parseList(req.body.roles);
      const capabilities = parseList(req.body.capabilities);
      const maxPlayers = req.body.max_players ? parseInt(req.body.max_players, 10) : null;
      if (key !== previousKey) {
        const matchCount = await prisma.match.count({ where: { game_type: previousKey } });
        if (matchCount > 0) {
          return res.redirect(`/admin/games/${id}?step=basics&error=${encodeURIComponent('The key cannot change after matches have been played, because match history is stored under it.')}`);
        }
        if (isBuiltInGameKey(key)) {
          return res.redirect(`/admin/games/${id}?step=basics&error=${encodeURIComponent('That key is reserved for a built-in game.')}`);
        }
        const clash = await prisma.gameDefinition.findUnique({ where: { key } });
        if (clash) {
          return res.redirect(`/admin/games/${id}?step=basics&error=${encodeURIComponent('Another game already uses that key.')}`);
        }
      }
      affectsEngine =
        key !== previousKey ||
        JSON.stringify(roles) !== JSON.stringify(game.roles) ||
        (maxPlayers || null) !== (game.max_players || null);
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
      affectsEngine = true;
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

      // Keep the create-form layout in sync with the settings locally (no LLM call on a plain save).
      const updatedSettings = await prisma.gameSetting.findMany({ where: { game_id: id }, orderBy: { key: 'asc' } });
      const layout = buildUiSchemaFromSettings(updatedSettings).create_form_layout;
      await prisma.gameUISchema.upsert({
        where: { game_id: id },
        update: { create_form_layout: layout },
        create: { game_id: id, create_form_layout: layout }
      });
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
          throw new FormError(`${label} JSON is invalid`);
        }
      };

      const createFormLayout = parseJson(req.body.create_form_layout, 'Create form layout');
      const summaryTemplate = parseJson(req.body.summary_template, 'Summary template');
      const labels = parseJson(req.body.labels, 'Labels');
      const currentSettings = await prisma.gameSetting.findMany({
        where: { game_id: id },
        select: { key: true }
      });
      validateUiSchemaReferences(currentSettings, createFormLayout, labels);

      const requestedRenderer = String(req.body.replay_renderer || 'generic');
      if (!['generic', 'chess', 'chutes', 'poker', 'blackjack'].includes(requestedRenderer)) {
        throw new FormError('Unknown replay renderer');
      }
      const replaySchema = { renderer: requestedRenderer };

      await prisma.gameUISchema.upsert({
        where: { game_id: id },
        update: {
          create_form_layout: createFormLayout,
          summary_template: summaryTemplate,
          labels,
          replay_schema: replaySchema
        },
        create: {
          game_id: id,
          create_form_layout: createFormLayout,
          summary_template: summaryTemplate,
          labels,
          replay_schema: replaySchema
        }
      });
    }

    const snapshot = await prisma.gameDefinition.findUnique({
      where: { id },
      include: { settings: true, ui_schema: true }
    });
    if (snapshot) {
      // Revision numbers are allocated optimistically; retry if a concurrent save took the number.
      for (let attempt = 0; attempt < 5; attempt++) {
        const last = await prisma.gameRevision.findFirst({ where: { game_id: id }, orderBy: { revision: 'desc' }, select: { revision: true } });
        try {
          await prisma.gameRevision.create({
            data: {
              game_id: id,
              revision: (last?.revision ?? 0) + 1,
              snapshot: { ...JSON.parse(JSON.stringify(snapshot)), _affects_engine: affectsEngine },
              created_by: adminId
            }
          });
          break;
        } catch (err: any) {
          if (err?.code !== 'P2002' || attempt === 4) throw err;
        }
      }
    }

    // Only changes the engine depends on take a live game out of rotation; cosmetic edits do not.
    if (affectsEngine && !isBuiltInGameKey(game.key)) {
      if (game.status !== 'DRAFT') {
        await prisma.gameDefinition.update({
          where: { id },
          data: { status: 'DRAFT' }
        });
        await prisma.gameRelease.create({
          data: {
            game_id: id,
            status: 'DRAFT',
            published_by: adminId
          }
        });
      }
      await prisma.gameEngineArtifact.updateMany({
        where: {
          game_id: id,
          status: 'PUBLISHED'
        },
        data: {
          status: 'DRAFT'
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
    if (err instanceof FormError) {
      return res.redirect(`/admin/games/${id}?step=${step}&error=${encodeURIComponent(err.message)}`);
    }
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
  const game = await prisma.gameDefinition.findUnique({
    where: { id },
    include: {
      engine_artifacts: { orderBy: { created_at: 'desc' }, take: 1 },
      dry_runs: { orderBy: { created_at: 'desc' }, take: 1 }
    }
  });
  if (!game) return res.redirect('/admin/games?error=Game not found');
  if (isBuiltInGameKey(game.key)) {
    return res.redirect(`/admin/games/${id}?step=review&error=Built-in games are managed outside the game builder lifecycle`);
  }

  const latestArtifact = game.engine_artifacts?.[0] || null;
  const latestDryRun = game.dry_runs?.[0] || null;
  const latestRevision = await latestEngineRevision(game.id);
  if (action === 'schedule') {
    if (!req.body.publish_at) {
      return res.redirect(`/admin/games/${id}?step=review&error=Scheduled publish requires a publish date.`);
    }
    const requestedDate = parseLocalDateTime(req.body.publish_at, req.body.tz_offset);
    if (!requestedDate || requestedDate <= new Date()) {
      return res.redirect(`/admin/games/${id}?step=review&error=Scheduled publish must be set to a future date.`);
    }
  }
  if (action === 'publish' || action === 'schedule') {
    if (!latestArtifact || latestArtifact.status !== 'PUBLISHED') {
      return res.redirect(`/admin/games/${id}?step=review&error=Publish the latest engine runtime before making this game live`);
    }
    if (latestArtifact.used_fallback) {
      return res.redirect(`/admin/games/${id}?step=review&error=Fallback stub engines cannot be made live. Generate a real engine before publishing this game.`);
    }
    if (isArtifactStale(latestArtifact, latestRevision)) {
      return res.redirect(`/admin/games/${id}?step=review&error=Latest engine artifact is stale. Regenerate and republish after your latest edits.`);
    }
    if (isDryRunStale(latestDryRun || null, latestRevision)) {
      return res.redirect(`/admin/games/${id}?step=review&error=Latest Dry Run predates your latest edits. Re-run validation before publishing.`);
    }
    if (!latestDryRun || !latestDryRun.success || latestDryRun.engine_artifact_id !== latestArtifact.id) {
      return res.redirect(`/admin/games/${id}?step=review&error=Run a successful Dry Run on the published artifact before making this game live`);
    }
  }

  const status =
    action === 'publish' ? 'LIVE' :
    action === 'schedule' ? 'SCHEDULED' :
    action === 'retire' ? 'RETIRED' :
    'DRAFT';

  const publishAt = action === 'schedule' && req.body.publish_at
    ? parseLocalDateTime(req.body.publish_at, req.body.tz_offset)
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
