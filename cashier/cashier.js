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
import { tweakPubkey, p2trAddress, scriptPubKeyFor, spkFromAddress, buildKeyPathSpend } from '../lib/taproot.js';
import { depositAddressFor } from '../lib/webledger-address.js';
import { loadBook } from './book.js';

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

// ---- the standing sat ledger: poker-for-sats balances, persisted ----
const USER_DID = 'did:nostr:47779362edffcf683a6b277a71dd84651c5f7939e4daf84009a4144238b91a03';
const CITIZEN_DID = 'did:nostr:455c405b9473a0f751c3166e3008411ce4fecb7fef217bbb8baaf5f535383a10';
// seed (fresh book only): the 703,086-sat faucet deposit, 10,000 granted to the citizen
const { book: ledger, save: saveLedger, bal, creditBal, balancesView } = loadBook(DIR, { [USER_DID]: 693086, [CITIZEN_DID]: 10000 });

async function onCashHand(c, signer) {
  if (signer !== USER_DID) return log(`cashhand from ${signer.slice(0, 16)} refused: not the player`);
  if (!c.root || ledger.hands[c.root] !== undefined) return log(`cashhand ${String(c.root).slice(0, 10)}: duplicate or rootless — ignored`);
  const delta = Math.trunc(c.delta);
  if (!Number.isFinite(delta) || Math.abs(delta) > 2000) return log(`cashhand delta ${c.delta} out of bounds`);
  if (bal(CITIZEN_DID) - delta < 0 || bal(USER_DID) + delta < 0) return log('cashhand refused: insufficient balance');
  creditBal(USER_DID, delta);
  creditBal(CITIZEN_DID, -delta);
  ledger.hands[c.root] = delta;
  ledger.seq++;
  saveLedger();
  log(`hand ${c.root.slice(0, 10)}: ${delta >= 0 ? 'player wins ' + delta : 'citizen wins ' + (-delta)} sats · player ${bal(USER_DID)} · citizen ${bal(CITIZEN_DID)}`);
  const doc = { type: 'Ledger', v: 0, root: `cash-${c.root}`, entry: 'handdelta', game: c.game, handRoot: c.root, delta, balances: balancesView(), entries: ledger.entries, seq: ledger.seq, t: Date.now() };
  archive(doc);
  await say({ type: 'cashier-ledger', game: c.game, handRoot: c.root, delta, balances: balancesView(), seq: ledger.seq });
}

async function onWithdraw(c, signer, wreq) {
  if (signer !== USER_DID) return log(`withdraw from ${signer.slice(0, 16)} refused: not the player`);
  ledger.withdrawals = ledger.withdrawals || {};
  if (!wreq || ledger.withdrawals[wreq]) return log('withdraw: duplicate or unidentified request — ignored');
  const amount = Math.trunc(c.amount);
  if (!Number.isFinite(amount) || amount < 1000) return log(`withdraw ${c.amount}: below the 1000-sat minimum`);
  if (amount > bal(USER_DID)) return log(`withdraw ${amount}: exceeds book balance ${bal(USER_DID)}`);
  let addrSpk;
  try { addrSpk = spkFromAddress(c.address); } catch { return log(`withdraw: unparseable address ${c.address}`); }
  const utxos = await fetch(`${MEMPOOL}/address/${vault}/utxo`).then((r) => r.json()).catch(() => null);
  if (!Array.isArray(utxos) || !utxos.length) return log('withdraw: vault utxos unreachable — try again later');
  utxos.sort((a, b) => b.value - a.value);
  const picked = []; let inSum = 0;
  for (const u of utxos) { picked.push(u); inSum += u.value; if (inSum >= amount) break; }
  if (inSum < amount) return log(`withdraw: vault holds ${inSum} on-chain < ${amount}`);
  const outputs = [{ spk: addrSpk, sats: amount - FEE }];
  const change = inSum - amount;
  if (change >= 330) outputs.push({ spk: vaultSpk, sats: change }); // sub-dust change is left to the miner
  const { rawHex } = buildKeyPathSpend({
    inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sats: u.value, spk: vaultSpk })),
    outputs,
    privHex: priv,
  });
  const resp = (await fetch(`${MEMPOOL}/tx`, { method: 'POST', body: rawHex }).then((r) => r.text()).catch((e) => 'broadcast-error: ' + e.message)).trim();
  if (!/^[0-9a-f]{64}$/.test(resp)) {
    log(`withdraw broadcast FAILED (book untouched): ${resp.slice(0, 160)}`);
    return say({ type: 'cashier-withdraw-failed', wreq, reason: resp.slice(0, 200) });
  }
  creditBal(USER_DID, -amount);
  ledger.withdrawals[wreq] = resp;
  ledger.seq++;
  saveLedger();
  log(`withdraw: ${amount} sats to ${c.address} · tx ${resp} · player book ${bal(USER_DID)}`);
  const doc = { type: 'Ledger', v: 0, root: `cashout-${resp}`, entry: 'withdraw', wreq, did: signer, amount, fee: FEE, address: c.address, txid: resp, balances: balancesView(), entries: ledger.entries, seq: ledger.seq, t: Date.now() };
  archive(doc);
  await say({ type: 'cashier-withdraw', wreq, amount, address: c.address, txid: resp, balances: balancesView(), seq: ledger.seq });
}

// deposit-check: your DID is your account. The page derives the same
// address we do (cashier pubkey + sha256 of your DID URI — webledgers
// convention) and nudges us when coins land; we credit what the chain
// confirms, once per txid:vout, for ANY nostr account.
async function onDepositCheck(c, signer, wreq) {
  const uri = signer;
  const { address } = depositAddressFor(pub, uri);
  const utxos = await fetch(`${MEMPOOL}/address/${address}/utxo`).then((r) => r.json()).catch(() => null);
  if (!Array.isArray(utxos)) return log(`deposit-check ${uri.slice(0, 20)}: chain unreachable`);
  ledger.deposits = ledger.deposits || {};
  let credited = 0; const coins = [];
  for (const u of utxos) {
    const key = `${u.txid}:${u.vout}`;
    if (!u.status?.confirmed || ledger.deposits[key] !== undefined) continue;
    ledger.deposits[key] = { uri, sats: u.value };
    credited += u.value; coins.push(key);
  }
  if (!credited) return log(`deposit-check ${uri.slice(0, 20)}: nothing new at ${address}`);
  creditBal(uri, credited);
  ledger.seq++;
  saveLedger();
  log(`deposit: ${credited} sats credited to ${uri.slice(0, 20)} — ${coins.length} coin(s) at ${address} · book ${bal(uri)}`);
  const doc = { type: 'Ledger', v: 0, root: `credit-${coins[0]}`, entry: 'credit', wreq, did: uri, address, coins, sats: credited, balances: balancesView(), entries: ledger.entries, seq: ledger.seq, t: Date.now() };
  archive(doc);
  await say({ type: 'cashier-credit', wreq, did: uri, address, sats: credited, balances: balancesView(), seq: ledger.seq });
}

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
    if (c.claim === 'cashhand') await onCashHand(c, signer);
    else if (c.claim === 'withdraw') await onWithdraw(c, signer, m.attest.id);
    else if (c.claim === 'deposit-check') await onDepositCheck(c, signer, m.attest.id);
    else if (c.claim === 'trust-cashier' && c.cashier === did) await onTrust(c, signer);
    else if (c.claim === 'deposit') await onDeposit(c, signer);
    else if (c.claim === 'result') await onResult(c, signer);
  } catch (e) { log(`error handling ${c.claim}: ${e.message}`); }
});

log(`open for business as ${did}`);
log(`vault (testnet4): ${vault}`);
log(`watching room ${ROOM} at ${BASE} · chain via ${MEMPOOL}`);
say({ type: 'cashier-hello', vault, network: 'testnet4', room: ROOM });
