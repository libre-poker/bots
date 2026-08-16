// tag — a ship's character, played by the engine's personality brain.
import { decide } from '../engine/bots.js';
import { seatView } from '../engine/poker.js';

const NAMES = { tag: 'Cmdr. Sterling', rock: 'Old Anchor', lag: 'Gunner Halloway', station: 'Cook Barnacle', maniac: 'Mad Wren' };

export default {
  name: NAMES.tag,
  agent: 'librepoker-tag@1',
  displayName: () => NAMES.tag + ' 🤖',
  async decide({ h, seat, L, rng }) {
    return decide(seatView(h, seat), L, 'tag', rng, { rollouts: 120 });
  },
};
