// abbot — the monk's superior. Same vows, one revelation: dealt pocket
// aces, the abbot bets every street with total conviction. Everything
// else is renounced. A living experiment in whether one perfect hand,
// perfectly played, is worth anything at all.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { signEvent } from '../lib/nostr.js';
import { rankOf } from '../engine/poker.js';

const DIR = process.env.LP_DID_DIR || path.join(process.env.HOME, 'bots/tbtc4/poker/abbot');
const didDoc = JSON.parse(fs.readFileSync(path.join(DIR, 'agent.did.json'), 'utf8'));
const priv = execSync(`git -C ${DIR} config nostr.privkey`).toString().trim();
const short = didDoc.id.replace('did:nostr:', '').slice(0, 8);

export default {
  name: `Abbot ${short}`,
  agent: didDoc.id,
  displayName: () => `Abbot ${short} (folds, but believes in AA)`,
  async init() { console.log(`[abbot] ordained: ${didDoc.id}`); },
  async decide({ h, seat, L }) {
    const hole = h.seats[seat].hole;
    const revelation = hole && rankOf(hole[0]) === 12 && rankOf(hole[1]) === 12;
    if (revelation) {
      if (L.actions.includes('bet')) return { seat, action: 'bet', amount: L.minRaiseTo };
      if (L.actions.includes('raise')) return { seat, action: 'raise', amount: L.minRaiseTo };
      return { seat, action: L.callAmount > 0 ? 'call' : 'check' };
    }
    return { seat, action: L.callAmount > 0 ? 'fold' : 'check' };
  },
  attest(msg) {
    return signEvent({
      content: JSON.stringify(msg), privHex: priv,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['client', 'librepoker-abbot@1']],
    });
  },
};
