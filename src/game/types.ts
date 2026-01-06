export interface GameContext {
  matchId: string;
  turnIndex: number;
  history: GameEvent[];
  seed: number;
}

export interface GameEvent {
  turn: number;
  actor: string; // "player1", "player2", "system"
  type: string;
  payload: any;
}

export interface GameResult {
  isFinished: boolean;
  scores: { [playerId: string]: number };
  winnerId?: string;
}

export interface GameEngine {
  gameType: string;
  initialize(seed: number): GameEvent[];
  processMove(gameState: GameEvent[], move: PlayerMove): { events: GameEvent[], result: GameResult | null };
  getSystemPrompt(role: string): string;
}

export interface PlayerMove {
  actor: string;
  content: string; // The raw text output
  action?: any;    // Parsed action if applicable
}

export interface ModelAdapter {
  generateMove(systemPrompt: string, history: GameEvent[]): Promise<string>;
}
