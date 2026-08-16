// ladder — the champion strategy at a chosen level (2..7). Fetches its
// brain at init from the shipped room, so a promoted champion reaches
// the fleet on next restart.
import { ladderDecide, setEquityEdges } from '../engine/ladder.js';
import { riverMix } from '../engine/river-solver.js';

const LEVEL_EPS = { 2: .45, 3: .3, 4: .2, 5: .12, 6: .06, 7: 0 };
const URL = process.env.STRATEGY_URL || 'https://librepoker.org/play/strategy-hulimit.json';
let T = null;

export default {
  name: 'Ladder',
  agent: 'librepoker-ladder@1',
  displayName: (level) => `Bot · Lv ${level}`,
  async init() {
    T = await fetch(URL).then((r) => r.json());
    if (T.edges) setEquityEdges(T.edges);
    console.log(`[ladder] strategy loaded: ${T.iterations.toLocaleString()} iterations`);
  },
  async decide({ h, seat, L, level, rng, cache }) {
    if (h.street === 3) {
      const mix = riverMix(h, seat, T.table, cache);
      if (mix) {
        const eps = LEVEL_EPS[level] ?? 0;
        const probs = mix.probs.map((p) => (1 - eps) * p + eps / mix.probs.length);
        let x = rng(), pick = 0;
        for (let k = 0; k < probs.length; k++) { x -= probs[k]; if (x <= 0) { pick = k; break; } }
        const ch = mix.acts[Math.min(pick, mix.acts.length - 1)];
        if (ch === 'f' && L.callAmount > 0) return { seat, action: 'fold' };
        if (ch === 'b' && (L.actions.includes('bet') || L.actions.includes('raise'))) {
          return { seat, action: L.actions.includes('bet') ? 'bet' : 'raise', amount: L.minRaiseTo };
        }
        return { seat, action: L.callAmount > 0 ? 'call' : 'check' };
      }
    }
    return ladderDecide(h, seat, L, T.table, LEVEL_EPS[level] ?? 0, rng);
  },
};
