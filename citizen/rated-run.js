// citizen/rated-run.js — the declared citizen sits its rating exams:
//   node citizen/rated-run.js [--matches 5] [--level 7]
// Plays rated 20-hand matches vs the ladder anchor, updates its own
// Glicko-2 (kept in its identity directory), and leaves a SIGNED record
// of the run beside its DID — a rating whose history anyone can verify.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { newHand, legal, act, rngFromSeed } from '../engine/poker.js';
import { ladderDecide, setEquityEdges } from '../engine/ladder.js';
import { riverMix } from '../engine/river-solver.js';
import { glicko2, freshRating, LEVEL_RATING, LEVEL_RD } from '../engine/rating.js';
import { signEvent } from '../lib/nostr.js';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const MATCHES = Number(arg('matches', 5)), LEVEL = Number(arg('level', 7));
const SELF = arg('self', null);            // personality dir sitting the exam (default: champion mirror)
const SEED = arg('seed', null);            // paired-deck science mode: fixed seed base, rating NOT persisted
const HANDS = 20, SB = 10, BB = 20, CAP = 1.7 * BB * HANDS;
const LEVEL_EPS = { 2: .45, 3: .3, 4: .2, 5: .12, 6: .06, 7: 0 };
const DIR = process.env.LP_DID_DIR || path.join(process.env.HOME, 'bots/tbtc4/poker/1');
const priv = execSync(`git -C ${DIR} config nostr.privkey`).toString().trim();
const did = JSON.parse(fs.readFileSync(path.join(DIR, 'agent.did.json'), 'utf8')).id;
const sha = (s) => createHash('sha256').update(s).digest('hex');

const T = await fetch(process.env.STRATEGY_URL || 'https://librepoker.org/play/strategy-hulimit.json').then((r) => r.json());
if (T.edges) setEquityEdges(T.edges);

function decide(h, seat, L, eps, rng, cache) {
  if (h.street === 3) {
    const mix = riverMix(h, seat, T.table, cache);
    if (mix) {
      const probs = mix.probs.map((p) => (1 - eps) * p + eps / mix.probs.length);
      let x = rng(), pick = 0;
      for (let k = 0; k < probs.length; k++) { x -= probs[k]; if (x <= 0) { pick = k; break; } }
      const ch = mix.acts[Math.min(pick, mix.acts.length - 1)];
      if (ch === 'f' && L.callAmount > 0) return { seat, action: 'fold' };
      if (ch === 'b' && (L.actions.includes('bet') || L.actions.includes('raise')))
        return { seat, action: L.actions.includes('bet') ? 'bet' : 'raise', amount: L.minRaiseTo };
      return { seat, action: L.callAmount > 0 ? 'call' : 'check' };
    }
  }
  return ladderDecide(h, seat, L, T.table, eps, rng);
}

const ratingPath = path.join(DIR, 'citizen-rating.json');
let rating = freshRating();
try { rating = Object.assign(freshRating(), JSON.parse(fs.readFileSync(ratingPath, 'utf8'))); } catch { /* first exam */ }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
let selfBot = null;
if (SELF) { selfBot = (await import(`../${SELF}/index.js`)).default; if (selfBot.init) await selfBot.init(); }
say(`=== rated run: ${did}${SELF ? ` (personality: ${SELF})` : ''}`);
say(`opponent: ladder Lv${LEVEL} (anchor ${LEVEL_RATING[LEVEL]}) · ${MATCHES} matches × ${HANDS} hands`);
say(`rating in: ${rating.r.toFixed(1)} (RD ${rating.rd.toFixed(0)})`);

const results = [];
for (let m = 0; m < MATCHES; m++) {
  let net = 0;
  for (let hand = 0; hand < HANDS; hand++) {
    const seed = sha(`${SEED || did + '|' + stamp}|${m}|${hand}`);
    const h = newHand({ seats: [{ name: 'citizen', stack: 2000 }, { name: 'ladder', stack: 2000 }], button: hand % 2, sb: SB, bb: BB, seedHex: seed, limit: true });
    const rng = rngFromSeed(sha(seed + '|acts'));
    const cache = {};
    let guard = 0;
    while (h.phase === 'act' && guard++ < 200) {
      const L = legal(h);
      if (L.seat === 0 && selfBot) act(h, await selfBot.decide({ h, seat: 0, L, level: LEVEL, rng, cache }));
      else act(h, decide(h, L.seat, L, L.seat === 0 ? 0 : (LEVEL_EPS[LEVEL] ?? 0), rng, cache));
    }
    net += h.seats[0].stack - 2000;
  }
  const score = Math.max(0, Math.min(1, 0.5 + net / (2 * CAP)));
  const before = rating.r;
  rating = glicko2(rating, [{ r: LEVEL_RATING[LEVEL], rd: LEVEL_RD, score }]);
  results.push({ match: m + 1, net, score: +score.toFixed(3), before: +before.toFixed(1), after: +rating.r.toFixed(1) });
  say(`match ${m + 1}: ${net >= 0 ? '+' : ''}${net} chips → margin ${score.toFixed(3)} · rating ${before.toFixed(1)} → ${rating.r.toFixed(1)} (RD ${rating.rd.toFixed(0)})`);
}
say(`rating out: ${rating.r.toFixed(1)} (RD ${rating.rd.toFixed(0)}${rating.rd > 110 ? ' — still provisional' : ''})`);

if (!SEED) fs.writeFileSync(ratingPath, JSON.stringify(rating, null, 2));
else say('(paired-deck science run — rating not persisted)');
fs.writeFileSync(path.join(DIR, `rated-run-${stamp}.log`), lines.join('\n') + '\n');
const attestation = signEvent({
  content: JSON.stringify({ did, opponent: `librepoker-ladder@${LEVEL}`, anchor: LEVEL_RATING[LEVEL], hands: HANDS, results, ratingOut: +rating.r.toFixed(1), rd: +rating.rd.toFixed(1), strategyIterations: T.iterations }),
  privHex: priv, created_at: Math.floor(Date.now() / 1000),
  tags: [['client', 'librepoker-citizen@1'], ['t', 'rated-run']],
});
fs.writeFileSync(path.join(DIR, `rated-run-${stamp}.attest.json`), JSON.stringify(attestation, null, 2));
say(`signed record: rated-run-${stamp}.attest.json (event ${attestation.id.slice(0, 12)}…)`);
