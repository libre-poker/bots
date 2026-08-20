// cashier/ceremony.js — a party's side of the cash-game ceremony: sign a
// claim with your own key and place it in the cashier's room.
//
//   node cashier/ceremony.js trust   --game G1 --stake 1000 --dir ~/bots/tbtc4/poker/1
//   node cashier/ceremony.js deposit --game G1 --txid <id> --vout 0 --dir …
//   node cashier/ceremony.js result  --game G1 --root <handRoot> --winner <did> \
//        --payout <tb1p…> --dir …
//   (--key <64hex> may replace --dir)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { makeClient } from '../lib/seat.js';
import { signEvent, derivePub } from '../lib/nostr.js';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const kind = process.argv[2];
const BASE = process.env.LP_CROUPIER || 'https://melvin.me/croupier';
const ROOM = process.env.LP_CASHIER_ROOM || 'CASH01';
const CASHIER_DID = 'did:nostr:' + (process.env.LP_CASHIER_PUB || 'ce9218b4144f8b54a52f3a5b2fa412cf26b0da95f067f9af9367167808a317dd');

const dir = arg('dir', null);
const priv = arg('key', null) || execSync(`git -C ${dir} config nostr.privkey`).toString().trim();
const me = 'did:nostr:' + derivePub(priv);

const claims = {
  trust: () => ({ claim: 'trust-cashier', game: arg('game', 'G1'), stake: Number(arg('stake', 1000)), cashier: CASHIER_DID }),
  deposit: () => ({ claim: 'deposit', game: arg('game', 'G1'), txid: arg('txid'), vout: Number(arg('vout', 0)) }),
  result: () => ({ claim: 'result', game: arg('game', 'G1'), handRoot: arg('root'), winner: arg('winner'), payoutAddress: arg('payout') }),
};
if (!claims[kind]) { console.error('usage: ceremony.js <trust|deposit|result> …'); process.exit(1); }
const c = claims[kind]();

const { post } = makeClient(BASE);
const msg = { from: me.slice(10, 22), seq: Date.now() % 100000, type: 'ceremony-' + kind, attest: signEvent({ content: JSON.stringify(c), privHex: priv, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'lp-ceremony']] }) };
await post('/room/send', { room: ROOM, msg });
console.log(`${kind} signed by ${me}`);
console.log(JSON.stringify(c));
