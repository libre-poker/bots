// monk — the declared bot that folds every hand. It has taken vows: no
// pot is worth wanting. Checks when checking is free, folds to any bet,
// and signs every renunciation. The ladder's floor, made flesh.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { signEvent } from '../lib/nostr.js';

const DIR = process.env.LP_DID_DIR || path.join(process.env.HOME, 'bots/tbtc4/poker/monk');
const didDoc = JSON.parse(fs.readFileSync(path.join(DIR, 'agent.did.json'), 'utf8'));
const priv = execSync(`git -C ${DIR} config nostr.privkey`).toString().trim();
const short = didDoc.id.replace('did:nostr:', '').slice(0, 8);

export default {
  name: `Monk ${short}`,
  agent: didDoc.id,
  displayName: () => `Monk ${short} (folds)`,
  async init() { console.log(`[monk] vows taken: ${didDoc.id}`); },
  async decide({ seat, L }) {
    return { seat, action: L.callAmount > 0 ? 'fold' : 'check' };
  },
  attest(msg) {
    return signEvent({
      content: JSON.stringify(msg), privHex: priv,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['client', 'librepoker-monk@1']],
    });
  },
};
