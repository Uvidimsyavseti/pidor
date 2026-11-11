import type { Card, GameState } from '../shared/types.js';
import { PidorGame, RANK_VALUE } from './gameLogic.js';

export type BotMove =
  | { type: 'drawCardFromDeck'; actorId: string }
  | { type: 'takeFromPile'; actorId: string; cardId: string }
  | { type: 'placeActiveCard'; actorId: string; targetId: string }
  | { type: 'givePenaltyCard'; actorId: string; cardId: string; receiverId: string }
  | { type: 'playCard'; actorId: string; cardId: string }
  | { type: 'takeTrick' | 'takeStumps' | 'exitGame'; actorId: string };

function cardCost(card: Card, trump: GameState['trumpSuit']): number {
  // Keep trumps and high spades for later when possible.
  return RANK_VALUE[card.rank] + (card.suit === trump ? 30 : 0) +
    (card.suit === 'spades' ? 5 : 0);
}

function firstTarget(game: PidorGame, actorId: string, card: Card): string {
  const players = game.state.players;
  const actorIdx = players.findIndex(player => player.id === actorId);
  for (let i = 1; i < players.length; i++) {
    const target = players[(actorIdx + i) % players.length];
    const top = target.stumps.at(-1);
    if (top && game.canBeat(card, top)) return target.id;
  }
  return actorId;
}

/**
 * Deterministic, conservative opponent. It makes legal moves only, and returns
 * null whenever the human player must act.
 */
export function nextBotMove(game: PidorGame, botIds: readonly string[]): BotMove | null {
  const state = game.state;
  const isBot = (id: string) => botIds.includes(id);
  if (state.phase === 'LOBBY' || state.phase === 'ENDED') return null;

  if (state.phase === 'DEALING') {
    const actor = state.players[state.turnIndex];
    if (!actor || !isBot(actor.id)) return null;
    if (state.activeCard) {
      return {
        type: 'placeActiveCard', actorId: actor.id,
        targetId: state.activeCard.fromDeck && state.deck.length === 0
          ? actor.id : firstTarget(game, actor.id, state.activeCard.card)
      };
    }
    const top = actor.stumps.at(-1);
    if (top && actor.stumps.length > 3 && firstTarget(game, actor.id, top) !== actor.id) {
      return { type: 'takeFromPile', actorId: actor.id, cardId: top.id };
    }
    return state.deck.length ? { type: 'drawCardFromDeck', actorId: actor.id } : null;
  }

  if (state.phase === 'PENALTY_DISTRIBUTION') {
    const debts = game.snapshot().penaltyDebts;
    for (const giver of state.players) {
      if (!isBot(giver.id) || giver.hand.length < 2) continue;
      for (const receiver of state.players) {
        if (receiver.id === giver.id || !(debts[receiver.id]?.[giver.id] > 0)) continue;
        const card = [...giver.hand].sort((a, b) =>
          cardCost(b, state.trumpSuit) - cardCost(a, state.trumpSuit))[0];
        if (card) return {
          type: 'givePenaltyCard', actorId: giver.id,
          receiverId: receiver.id, cardId: card.id
        };
      }
    }
    return null;
  }

  // Players must take their face-down cards (or leave) only between tricks.
  if (state.currentTrick.length === 0) {
    for (const player of state.players) {
      if (!isBot(player.id) || player.hasExited || player.hand.length > 0) continue;
      return { type: player.stumps.length ? 'takeStumps' : 'exitGame', actorId: player.id };
    }
  }

  const actor = state.players[state.turnIndex];
  if (!actor || !isBot(actor.id) || actor.hasExited) return null;
  if (!actor.hand.length) {
    return state.currentTrick.length
      ? { type: 'takeTrick', actorId: actor.id } : null;
  }

  const last = state.currentTrick.at(-1) || null;
  const playable = actor.hand
    .filter(card => game.isLegalMove(card, last))
    .sort((a, b) => cardCost(a, state.trumpSuit) - cardCost(b, state.trumpSuit));
  if (playable.length) {
    return { type: 'playCard', actorId: actor.id, cardId: playable[0].id };
  }
  return state.currentTrick.length ? { type: 'takeTrick', actorId: actor.id } : null;
}

export function applyBotMove(game: PidorGame, move: BotMove): boolean {
  switch (move.type) {
    case 'drawCardFromDeck': return game.takeFromDeck(move.actorId);
    case 'takeFromPile': return game.takeFromPile(move.actorId, move.cardId);
    case 'placeActiveCard': return game.placeActiveCard(move.actorId, move.targetId);
    case 'givePenaltyCard': return game.givePenaltyCard(move.actorId, move.cardId, move.receiverId);
    case 'playCard': {
      const before = game.state.players.find(p => p.id === move.actorId)?.hand.length;
      game.playCard(move.actorId, move.cardId);
      const after = game.state.players.find(p => p.id === move.actorId)?.hand.length;
      return before !== undefined && after === before - 1;
    }
    case 'takeTrick': {
      const count = game.state.currentTrick.length;
      game.takeTrick(move.actorId);
      return game.state.currentTrick.length === count - 1;
    }
    case 'takeStumps': {
      const before = game.state.players.find(p => p.id === move.actorId)?.stumps.length ?? 0;
      game.takeStumps(move.actorId);
      return before > 0 && game.state.players.find(p => p.id === move.actorId)?.stumps.length === 0;
    }
    case 'exitGame': {
      game.exitGame(move.actorId);
      return !!game.state.players.find(p => p.id === move.actorId)?.hasExited;
    }
  }
}
