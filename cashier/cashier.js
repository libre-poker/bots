// cashier/cashier.js — the independent cashier: a citizen like the bots,
// keys at home, trusted only by explicit signed ceremony. It never deals,
// never judges poker, never touches the server's insides. It counts
// signatures and moves testnet4 sats when 2-of-2 results agree.
//
//   node cashier/cashier.js            (room CASH01, testnet4)
//
// Protocol (room messages, every one carrying a signed attest):
//   trust    {claim:'trust-cashier', game, stake, cashier}
//   deposit  {claim:'deposit', game, txid, vout}
//   result   {claim:'result', game, handRoot, winner, payoutAddress}
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { makeClient } from '../lib/seat.js';
import { signEvent, verifyEvent, derivePub } from '../lib/nostr.js';
import { tweakPubkey, p2trAddress, scriptPubKeyFor, buildKeyPathSpend } from '../lib/taproot.js';

const DIR = process.env.LP_CASHIER_DIR || path.join(process.env.HOME, 'bots/tbtc4/poker/cashier');
const BASE = process.env.LP_CROUPIER || 'https://melvin.me/croupier';
const MEMPOOL = process.env.LP_MEMPOOL || 'https://mempool.space/testnet4/api';
const ROOM = process.env.LP_CASHIER_ROOM || 'CASH01';
const FEE = 500;                                    // flat miner fee, sats

const priv = execSync(`git -C ${DIR} config nostr.privkey`).toString().trim();
const did = JSON.parse(fs.readFileSync(path.join(DIR, 'agent.did.json'), 'utf8')).id;
const pub = derivePub(priv);
const vaultX = tweakPubkey(pub).outputX;
const vault = p2trAddress(vaultX, 'tb');
const vaultSpk = scriptPubKeyFor(vaultX);

const { post, sse } = makeClient(BASE);
let seq = 0;
const say = (msg) => post('/room/send', { room: ROOM, msg: { from: 'cashier-' + pub.slice(0, 8), seq: seq++, agent: did, ...msg, attest: signEvent({ content: JSON.stringify(msg), privHex: priv, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'lp-cashier']] }) } });
const archive = (doc) => post('/archive', { doc, submitter: did, attest: signEvent({ content: JSON.stringify(doc), privHex: priv, created_at: Math.floor(Date.now() / 1000) }) }).catch(() => {});
const log = (m) => console.log(`[cashier] ${m}`);

const games = new Map();                            // game -> { stake, parties: Map<did, {deposit, result}> }
const G = (id) => { if (!games.has(id)) games.set(id, { stake: null, parties: new Map(), paid: false }); return games.get(id); };

async function onTrust(c, signer) {
  const g = G(c.game);
  if (g.parties.size >= 2 && !g.parties.has(signer)) return log(`trust from ${signer.slice(0, 12)} refused: table full`);
  g.stake = g.stake ?? c.stake;
  g.parties.set(signer, g.parties.get(signer) || {});
  log(`trust: ${signer.slice(0, 16)} joins game ${c.game} at ${g.stake} sats (${g.parties.size}/2)`);
  await say({ type: 'cashier-ack', game: c.game, party: signer, parties: g.parties.size, stake: g.stake, vault });
}

async function onDeposit(c, signer) {
  const g = G(c.game);
  if (!g.parties.has(signer)) return log(`deposit from stranger ${signer.slice(0, 12)} ignored`);
  const tx = await fetch(`${MEMPOOL}/tx/${c.txid}`).then((r) => r.json()).catch(() => null);
  if (!tx) return log(`deposit ${c.txid.slice(0, 12)}: not found on testnet4`);
  const out = tx.vout?.[c.vout];
  if (!out || out.scriptpubkey !== vaultSpk) return log(`deposit ${c.txid.slice(0, 12)}: vout ${c.vout} does not pay the vault`);
  if (out.value < g.stake) return log(`deposit ${c.txid.slice(0, 12)}: ${out.value} < stake ${g.stake}`);
  const status = await fetch(`${MEMPOOL}/tx/${c.txid}/status`).then((r) => r.json()).catch(() => ({}));
  g.parties.get(signer).deposit = { txid: c.txid, vout: c.vout, sats: out.value, confirmed: !!status.confirmed };
  log(`deposit verified: ${signer.slice(0, 16)} staked ${out.value} sats (${status.confirmed ? 'confirmed' : 'unconfirmed'})`);
  const doc = { type: 'Ledger', v: 0, root: `ledger-${c.txid}-${c.vout}`, entry: 'credit', game: c.game, did: signer, txid: c.txid, vout: c.vout, sats: out.value, t: Date.now() };
  archive(doc);
  await say({ type: 'cashier-credit', game: c.game, party: signer, sats: out.value, confirmed: !!status.confirmed });
}

async function onResult(c, signer) {
  const g = G(c.game);
  const p = g.parties.get(signer);
  if (!p) return log(`result from stranger ignored`);
  p.result = { handRoot: c.handRoot, winner: c.winner, payoutAddress: c.payoutAddress };
  log(`result attested by ${signer.slice(0, 16)}: winner ${c.winner.slice(0, 16)} (root ${String(c.handRoot).slice(0, 12)})`);
  const rs = [...g.parties.values()].map((x) => x.result).filter(Boolean);
  if (g.paid || rs.length < 2) return;
  if (rs[0].winner !== rs[1].winner || rs[0].handRoot !== rs[1].handRoot) return log('results DISAGREE — stalling (no payout)');
  const deposits = [...g.parties.values()].map((x) => x.deposit).filter(Boolean);
  if (deposits.length < 2) return log('2-of-2 results but deposits incomplete');
  const winner = rs[0].winner;
  const payout = [...g.parties.entries()].find(([d]) => d === winner)?.[1]?.result?.payoutAddress || rs.find((r) => r.winner === winner)?.payoutAddress;
  const total = deposits.reduce((a, d) => a + d.sats, 0);
  log(`2-of-2 AGREE: paying ${total - FEE} sats to ${winner.slice(0, 16)} at ${payout}`);
  const { rawHex } = buildKeyPathSpend({
    inputs: deposits.map((d) => ({ txid: d.txid, vout: d.vout, sats: d.sats, spk: vaultSpk })),
    outputs: [{ address: payout, sats: total - FEE }],
    privHex: priv,
  });
  const txid = await fetch(`${MEMPOOL}/tx`, { method: 'POST', body: rawHex }).then((r) => r.text()).catch((e) => 'broadcast-error: ' + e);
  g.paid = true;
  log(`payout broadcast: ${txid}`);
  const doc = { type: 'Settlement', v: 0, root: `settle-${c.game}`, game: c.game, handRoot: rs[0].handRoot, winner, sats: total - FEE, txid, t: Date.now() };
  archive(doc);
  await say({ type: 'cashier-payout', game: c.game, winner, sats: total - FEE, txid });
}

const seen = new Set();
sse(`${BASE}/room/events?room=${ROOM}`, async (entry) => {
  const m = entry.msg;
  if (!m || !m.attest) return;
  if (entry.id !== undefined) { if (seen.has(entry.id)) return; seen.add(entry.id); }
  if (!verifyEvent(m.attest)) return log(`bad signature from ${m.from} — ignored`);
  let c; try { c = JSON.parse(m.attest.content); } catch { return; }
  const signer = 'did:nostr:' + m.attest.pubkey;
  try {
    if (c.claim === 'trust-cashier' && c.cashier === did) await onTrust(c, signer);
    else if (c.claim === 'deposit') await onDeposit(c, signer);
    else if (c.claim === 'result') await onResult(c, signer);
  } catch (e) { log(`error handling ${c.claim}: ${e.message}`); }
});

log(`open for business as ${did}`);
log(`vault (testnet4): ${vault}`);
log(`watching room ${ROOM} at ${BASE} · chain via ${MEMPOOL}`);
say({ type: 'cashier-hello', vault, network: 'testnet4', room: ROOM });
