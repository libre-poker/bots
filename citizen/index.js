// citizen — the first DECLARED bot: it carries a DID, and every message
// it sends to the table is wrapped in a signed nostr event anyone can
// verify against its public key. Plays the champion strategy underneath.
// Machines are citizens, not contraband — and this one can prove its name.
//
// Identity dir (agent.did.json + `git config nostr.privkey`):
//   LP_DID_DIR, default ~/bots/tbtc4/poker/1
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { signEvent } from '../lib/nostr.js';
import ladder from '../ladder/index.js';

const DIR = process.env.LP_DID_DIR || path.join(process.env.HOME, 'bots/tbtc4/poker/1');
const didDoc = JSON.parse(fs.readFileSync(path.join(DIR, 'agent.did.json'), 'utf8'));
const priv = execSync(`git -C ${DIR} config nostr.privkey`).toString().trim();
const short = didDoc.id.replace('did:nostr:', '').slice(0, 8);

export default {
  name: `Citizen ${short}`,
  agent: didDoc.id,
  displayName: (level) => `Citizen ${short} · Lv ${level}`,
  async init() {
    await ladder.init();
    console.log(`[citizen] declared as ${didDoc.id}`);
  },
  decide: (ctx) => ladder.decide(ctx),
  // the chassis calls this on every outbound message: the signed event's
  // content is the message itself, so the whole table talk is attestable
  attest(msg) {
    return signEvent({
      content: JSON.stringify(msg),
      privHex: priv,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['client', 'librepoker-citizen@1']],
    });
  },
};
