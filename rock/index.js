// rock — a ship's character, played by the engine's personality brain.
import { decide } from '../engine/bots.js';
import { seatView } from '../engine/poker.js';

const NAMES = { tag: 'Cmdr. Sterling', rock: 'Old Anchor', lag: 'Gunner Halloway', station: 'Cook Barnacle', maniac: 'Mad Wren' };

export default {
  name: NAMES.rock,
  agent: 'librepoker-rock@1',
  displayName: () => NAMES.rock + ' 🤖',
  async decide({ h, seat, L, rng }) {
    return decide(seatView(h, seat), L, 'rock', rng, { rollouts: 120 });
  },
};
