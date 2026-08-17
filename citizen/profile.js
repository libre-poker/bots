// citizen/profile.js — write the citizen's nostr profile: a signed kind-0
// event beside its DID. Re-run any time; the about line carries its
// current rating, so the profile ages with the career.
//   node citizen/profile.js
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { signEvent } from '../lib/nostr.js';

const DIR = process.env.LP_DID_DIR || path.join(process.env.HOME, 'bots/tbtc4/poker/1');
const priv = execSync(`git -C ${DIR} config nostr.privkey`).toString().trim();
const did = JSON.parse(fs.readFileSync(path.join(DIR, 'agent.did.json'), 'utf8')).id;
const short = did.replace('did:nostr:', '').slice(0, 8);
let ratingLine = '';
try {
  const r = JSON.parse(fs.readFileSync(path.join(DIR, 'citizen-rating.json'), 'utf8'));
  ratingLine = ` Rated ${Math.round(r.r)} (RD ${Math.round(r.rd)}) vs the librepoker.org ladder.`;
} catch { /* unrated yet */ }

const profile = {
  name: `Citizen ${short}`,
  about: `A declared poker bot of the Libre Poker fleet: plays the champion `
    + `heads-up limit strategy, verifies every croupier proof, and signs every `
    + `table message as a nostr event.${ratingLine} Machines are citizens, not contraband.`,
  website: 'https://librepoker.org/play/',
  bot: true,
};
const ev = signEvent({
  content: JSON.stringify(profile),
  kind: 0,
  privHex: priv,
  created_at: Math.floor(Date.now() / 1000),
});
fs.writeFileSync(path.join(DIR, 'nostr.json'), JSON.stringify(ev, null, 2));
console.log(`profile written: ${path.join(DIR, 'nostr.json')}`);
console.log(`  name: ${profile.name}`);
console.log(`  about: ${profile.about}`);
console.log(`  event ${ev.id.slice(0, 12)}… signed by ${ev.pubkey.slice(0, 8)}…`);
