import { prisma } from '../config/db';
import { BUILT_IN_GAME_KEYS } from './game-engine-artifact.service';

export const activateDueScheduledGames = async () => {
  const now = new Date();
  const dueReleases = await prisma.gameRelease.findMany({
    where: {
      status: 'SCHEDULED',
      publish_at: {
        not: null,
        lte: now
      }
    },
    select: {
      id: true,
      game_id: true,
      game: {
        select: {
          key: true,
          engine_artifacts: { where: { status: 'PUBLISHED' }, select: { id: true }, take: 1 }
        }
      }
    }
  });

  // A scheduled go-live must not activate a game whose runtime was unpublished or invalidated in the meantime.
  const activatable = dueReleases.filter(
    release => BUILT_IN_GAME_KEYS.has(release.game.key) || release.game.engine_artifacts.length > 0
  );
  const blockedIds = dueReleases.filter(release => !activatable.includes(release)).map(release => release.id);
  if (blockedIds.length > 0) {
    await prisma.gameRelease.updateMany({
      where: { id: { in: blockedIds } },
      data: { status: 'DRAFT', publish_at: null }
    });
  }
  if (activatable.length === 0) {
    return;
  }

  const dueReleaseIds = activatable.map(release => release.id);
  const dueGameIds = Array.from(new Set(activatable.map(release => release.game_id)));

  await prisma.$transaction([
    prisma.gameRelease.updateMany({
      where: { id: { in: dueReleaseIds } },
      data: {
        status: 'LIVE',
        publish_at: null
      }
    }),
    prisma.gameDefinition.updateMany({
      where: {
        id: { in: dueGameIds },
        status: 'SCHEDULED'
      },
      data: { status: 'LIVE' }
    })
  ]);
};
