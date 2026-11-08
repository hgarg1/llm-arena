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
  getRandomMove(gameState: GameEvent[], role: string): PlayerMove;
  /**
   * Role that must act next. `'system'` means the engine advances itself (the runner sends `RESOLVE`);
   * `null`/undefined lets the runner fall back to round-robin over participants.
   */
  getActiveRole?(gameState: GameEvent[]): string | null;
  /** True when `role`'s next move needs no model decision (e.g. dice only), so no LLM call is made. */
  isAutomatic?(gameState: GameEvent[], role: string): boolean;
  /** Events `role` may see. Used to hide private information (hole cards) from other players. */
  getObservation?(gameState: GameEvent[], role: string): GameEvent[];
  /** Releases any resources held by the engine (sandboxed engines own a worker thread). */
  dispose?(): void;
}

export interface PlayerMove {
  actor: string;
  content: string; // The raw text output
  action?: any;    // Parsed action if applicable
}

/** Per-call limits supplied by the runner so one move can never outlive the slice it runs in. */
export interface MoveRequestOptions {
  timeoutMs?: number;
}

export interface ModelAdapter {
  /**
   * Returns the raw move text. Must throw on transport/provider failure: an infrastructure error
   * is never a legal-or-illegal move and must not be scored as one.
   */
  generateMove(systemPrompt: string, history: GameEvent[], role?: string, options?: MoveRequestOptions): Promise<string>;
}
