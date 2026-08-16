// lag — a ship's character, played by the engine's personality brain.
import { decide } from '../engine/bots.js';
import { seatView } from '../engine/poker.js';

const NAMES = { tag: 'Cmdr. Sterling', rock: 'Old Anchor', lag: 'Gunner Halloway', station: 'Cook Barnacle', maniac: 'Mad Wren' };

export default {
  name: NAMES.lag,
  agent: 'librepoker-lag@1',
  displayName: () => NAMES.lag + ' 🤖',
  async decide({ h, seat, L, rng }) {
    return decide(seatView(h, seat), L, 'lag', rng, { rollouts: 120 });
  },
};
