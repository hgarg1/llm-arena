import Sentiment from 'sentiment';
import { prisma as db } from '../config/db';

class SentimentService {
  private analyzer: Sentiment;

  constructor() {
    this.analyzer = new Sentiment();
  }

  /**
   * Analyze a single message and return a score.
   * Score > 0 : Positive
   * Score < 0 : Negative
   */
  analyze(text: string): number {
    const result = this.analyzer.analyze(text);
    return result.score;
  }

  /**
   * Calculate the average sentiment for the entire platform or a specific channel
   * based on recent messages (e.g., last 24h).
   */
  async getSystemSentiment(): Promise<{ score: number; label: string }> {
    // Fetch last 100 messages for a quick sample
    const recentMessages = await db.chatMessage.findMany({
      take: 100,
      orderBy: { created_at: 'desc' },
      select: { content: true }
    });

    if (recentMessages.length === 0) return { score: 0, label: 'Neutral' };

    let totalScore = 0;
    for (const msg of recentMessages) {
      totalScore += this.analyze(msg.content);
    }

    const avgScore = totalScore / recentMessages.length;
    let label = 'Neutral';
    if (avgScore > 0.5) label = 'Positive';
    if (avgScore > 2) label = 'Very Positive';
    if (avgScore < -0.5) label = 'Negative';
    if (avgScore < -2) label = 'Toxic';

    return { score: avgScore, label };
  }
}

export const sentimentService = new SentimentService();
