export interface GameContext {
  matchId: string;
  turnIndex: number;
  history: GameEvent[];
  seed: number;
}

export interface GameEvent {
  actor: string;
  type: string;
  turn: number;
  payload: {
    content?: string;
    images?: string[]; // URLs or base64
    [key: string]: any;
  };
  created_at?: Date;
}

export interface GameResult {
  isFinished: boolean;
  scores: { [playerId: string]: number };
  winnerId?: string;
}

export interface GameEngine {
  gameType: string;
  initialize(seed: number, options?: any): GameEvent[];
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
