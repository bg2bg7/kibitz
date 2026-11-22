/**
 * Elo and USCF rating change & performance rating estimators.
 */

export type RatingSystem = "elo" | "uscf";

export interface RatingChangeInput {
  playerRating: number;
  opponentRating: number;
  /** 1 = win, 0.5 = draw, 0 = loss */
  score: 0 | 0.5 | 1;
  kFactor?: number;
}

export function expectedEloScore(playerRating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - playerRating) / 400));
}

export function calculateEloDelta(input: RatingChangeInput): number {
  const k = input.kFactor ?? 20;
  const expected = expectedEloScore(input.playerRating, input.opponentRating);
  return Math.round(k * (input.score - expected));
}

export function estimatePerformanceRating(
  opponentRatings: readonly number[],
  totalScore: number,
): number {
  if (opponentRatings.length === 0) return 0;
  const avgOpponent =
    opponentRatings.reduce((sum, rating) => sum + rating, 0) / opponentRatings.length;
  const scoreDiff = 2 * totalScore - opponentRatings.length;
  return Math.round(avgOpponent + (400 * scoreDiff) / opponentRatings.length);
}
