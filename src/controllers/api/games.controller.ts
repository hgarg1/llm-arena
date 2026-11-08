import { Request, Response } from 'express';
import { getGameEngine, GameEngineNotFoundError } from '../../game/registry';
import { GameEngine, GameEvent, PlayerMove } from '../../game/types';

const MAX_REPLAY_MOVES = 1000;

/**
 * Engines are stateful, so a client-supplied event log cannot be trusted as state. The endpoint
 * therefore replays from scratch: `seed` + `options` + the ordered `moves` already played, then applies `move`.
 */
export const simulate = async (req: Request, res: Response) => {
    const { gameId } = req.params;
    const { state, move, moves, seed, options } = req.body || {};

    let engine: GameEngine | null = null;
    try {
        if (Array.isArray(state) && state.length > 1 && !Array.isArray(moves)) {
            return res.status(400).json({
                error: 'Engines are stateful: send the moves played so far as `moves` (with the original `seed` and `options`) instead of `state`.'
            });
        }
        const prior: PlayerMove[] = Array.isArray(moves) ? moves : [];
        if (prior.length > MAX_REPLAY_MOVES) {
            return res.status(400).json({ error: `At most ${MAX_REPLAY_MOVES} prior moves can be replayed.` });
        }
        const isMove = (m: any): m is PlayerMove => m && typeof m.actor === 'string' && typeof m.content === 'string';
        if (prior.some(m => !isMove(m)) || (move !== undefined && move !== null && !isMove(move))) {
            return res.status(400).json({ error: 'Each move needs a string `actor` and string `content`.' });
        }

        engine = await getGameEngine(gameId);
        const resolvedSeed = Number.isFinite(seed) ? Number(seed) : Math.floor(Math.random() * 1000000);
        const history: GameEvent[] = [...(engine.initialize(resolvedSeed, options || {}) || [])];

        let result = null;
        for (const m of prior) {
            const step = engine.processMove(history, m);
            history.push(...step.events);
            result = step.result;
            if (result) break;
        }

        if (move) {
            if (result) return res.status(409).json({ error: 'The game has already finished.', result, nextState: history });
            const step = engine.processMove(history, move);
            return res.json({
                seed: resolvedSeed,
                events: step.events,
                result: step.result,
                nextState: [...history, ...step.events]
            });
        }

        return res.json({ seed: resolvedSeed, result, nextState: history });
    } catch (error: any) {
        const message = String(error?.message || error);
        const status = error instanceof GameEngineNotFoundError ? 404 : 500;
        if (status === 500) console.error('Simulation error:', error);
        return res.status(status).json({ error: message });
    } finally {
        engine?.dispose?.();
    }
};
