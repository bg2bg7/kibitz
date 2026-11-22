/**
 * Swiss & Round-Robin pairing contracts and standard chess tiebreak calculators.
 */

export type PairingSystem = "swiss" | "round-robin";

export interface TournamentPlayer {
  id: string;
  rating: number;
  score: number;
  opponentsPlayed: string[];
  colorHistory: Array<"w" | "b" | "bye">;
  active: boolean;
}

export interface Pairing {
  board: number;
  whitePlayerId: string;
  blackPlayerId: string | null; // null indicates a full-point or half-point bye
}

export type TiebreakSystem = "buchholz" | "solkoff" | "cumulative" | "sonneborn-berger";

export interface TiebreakScores {
  buchholz: number;
  solkoff: number;
  cumulative: number;
  sonnebornBerger: number;
}

/**
 * Generates deterministic stub pairings ordered by score then rating.
 * Full Dutch/USCF Swiss & Berger Round-Robin algorithms will replace this stub.
 */
export function generatePairings(
  players: readonly TournamentPlayer[],
  _system: PairingSystem,
): Pairing[] {
  const activePlayers = players
    .filter((p) => p.active)
    .sort((a, b) => b.score - a.score || b.rating - a.rating || a.id.localeCompare(b.id));

  const pairings: Pairing[] = [];
  for (let i = 0; i < activePlayers.length; i += 2) {
    const white = activePlayers[i];
    const black = activePlayers[i + 1] ?? null;
    if (!white) continue;
    pairings.push({
      board: pairings.length + 1,
      whitePlayerId: white.id,
      blackPlayerId: black ? black.id : null,
    });
  }
  return pairings;
}

/**
 * Computes standard Solkoff/Buchholz baseline from opponent final scores.
 */
export function calculateSolkoff(
  opponentIds: readonly string[],
  scoreByPlayerId: Readonly<Record<string, number>>,
): number {
  return opponentIds.reduce((sum, opponentId) => sum + (scoreByPlayerId[opponentId] ?? 0), 0);
}

/**
 * Computes cumulative score from per-round running totals.
 */
export function calculateCumulative(roundCumulativeScores: readonly number[]): number {
  return roundCumulativeScores.reduce((sum, score) => sum + score, 0);
}
