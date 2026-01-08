import { Request, Response } from 'express';
import { getGameEngine } from '../../game/registry';
import { GameEvent } from '../../game/types';

export const simulate = async (req: Request, res: Response) => {
    const { gameId } = req.params;
    const { state, move, seed, options } = req.body;

    try {
        const engine = await getGameEngine(gameId);
        if (!engine) {
            return res.status(404).json({ error: 'Game engine not found' });
        }

        // Initialize if state is missing
        let history: GameEvent[] = state;
        if (!history || history.length === 0) {
            history = engine.initialize(seed || Math.floor(Math.random() * 1000000), options || {});
        }

        // Process move if provided
        if (move) {
            const step = engine.processMove(history, move);
            return res.json({
                events: step.events,
                result: step.result,
                nextState: [...history, ...step.events]
            });
        }

        return res.json({ nextState: history });
    } catch (error: any) {
        console.error('Simulation error:', error);
        return res.status(500).json({ error: error.message });
    }
};
