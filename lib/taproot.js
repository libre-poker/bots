// lib/taproot.js — Bitcoin taproot key-path spending, pure JS on the same
// secp256k1 heart as the fleet's signatures (BIP340 IS taproot's scheme).
// Scope: P2TR addresses, BIP341 sighash, key-path signing, tx build.
// Validated against the BIP341 wallet test vectors in test-taproot.js
// before a single sat — testnet or otherwise — is trusted to it.
import { secp, schnorrSign } from './nostr.js';

const { N, G, mod, add, mul, liftX, hexToB, bToHex, bToInt, intToB, sha, tagged } = secp;

// ---------------------------------------------------------------- tweak
// BIP341: t = H_TapTweak(P.x || merkleRoot?); Q = P + tG
export function tweakPubkey(internalXHex, merkleRootHex = null) {
  const px = hexToB(internalXHex);
  const t = bToInt(tagged('TapTweak', px, ...(merkleRootHex ? [hexToB(merkleRootHex)] : [])));
  if (t >= N) throw new Error('unlucky tweak');
  const Q = add(liftX(internalXHex), mul(t, G));
  return { outputX: bToHex(intToB(Q.x)), parity: (Q.y & 1n) === 1n };
}

export function tweakSeckey(privHex, merkleRootHex = null) {
  let d = BigInt('0x' + privHex);
  const P0 = mul(d, G);
  if ((P0.y & 1n) !== 0n) d = N - d;             // internal key uses even-Y
  const px = intToB(P0.x);
  const t = bToInt(tagged('TapTweak', px, ...(merkleRootHex ? [hexToB(merkleRootHex)] : [])));
  return bToHex(intToB(mod(d + t, N)));
}

export const scriptPubKeyFor = (outputXHex) => '5120' + outputXHex;

// ---------------------------------------------------------------- bech32m
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}
export function p2trAddress(outputXHex, hrp = 'tb') {
  const data = [1, ...convertBits(hexToB(outputXHex), 8, 5, true)];
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  let out = hrp + '1';
  for (const d of data) out += CHARSET[d];
  for (let i = 0; i < 6; i++) out += CHARSET[(chk >> (5 * (5 - i))) & 31];
  return out;
}
export function decodeAddress(addr) {
  const pos = addr.lastIndexOf('1');
  const hrp = addr.slice(0, pos).toLowerCase();
  const data = [...addr.slice(pos + 1).toLowerCase()].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1)) throw new Error('bad address charset');
  const constant = polymod([...hrpExpand(hrp), ...data]);
  const witver = data[0];
  if (witver === 0 ? constant !== 1 : constant !== 0x2bc830a3) throw new Error('bad checksum');
  const program = convertBits(data.slice(1, -6), 5, 8, false);
  if (witver === 1 && program.length !== 32) throw new Error('not p2tr');
  return { witver, program: bToHex(Uint8Array.from(program)) };
}
export const spkFromAddress = (addr) => {
  const { witver, program } = decodeAddress(addr);
  const op = witver === 0 ? '00' : (0x50 + witver).toString(16);
  return op + (program.length / 2).toString(16).padStart(2, '0') + program;
};

// ---------------------------------------------------------------- tx codec
const leHex = (n, bytes) => { let h = ''; let v = BigInt(n); for (let i = 0; i < bytes; i++) { h += (v & 0xffn).toString(16).padStart(2, '0'); v >>= 8n; } return h; };
const varint = (n) => n < 0xfd ? n.toString(16).padStart(2, '0') : 'fd' + leHex(n, 2);
class Reader {
  constructor(hex) { this.h = hex; this.i = 0; }
  take(n) { const s = this.h.slice(this.i, this.i + n * 2); this.i += n * 2; return s; }
  u32() { return Number(bToInt(hexToB(this.take(4)).reverse())); }
  u64() { return bToInt(hexToB(this.take(8)).reverse()); }
  vi() { const b = parseInt(this.take(1), 16); if (b < 0xfd) return b; if (b === 0xfd) return Number(bToInt(hexToB(this.take(2)).reverse())); throw new Error('varint too big'); }
}
export function parseTx(rawHex) {
  const r = new Reader(rawHex);
  const tx = { version: r.u32(), vin: [], vout: [], locktime: 0 };
  let nIn = r.vi();
  if (nIn === 0) { r.take(1); nIn = r.vi(); }        // witness marker (unsigned txs won't have it)
  for (let i = 0; i < nIn; i++) {
    const txidLE = r.take(32), vout = r.u32(), sl = r.vi(), scriptSig = r.take(sl), sequence = r.u32();
    tx.vin.push({ txidLE, vout, scriptSig, sequence });
  }
  const nOut = r.vi();
  for (let i = 0; i < nOut; i++) {
    const value = r.u64(), sl = r.vi(), spk = r.take(sl);
    tx.vout.push({ value, spk });
  }
  tx.locktime = r.u32();
  return tx;
}
export function serializeTx(tx, witnesses = null) {
  let s = leHex(tx.version, 4);
  if (witnesses) s += '0001';
  s += varint(tx.vin.length);
  for (const i of tx.vin) s += i.txidLE + leHex(i.vout, 4) + varint((i.scriptSig || '').length / 2) + (i.scriptSig || '') + leHex(i.sequence, 4);
  s += varint(tx.vout.length);
  for (const o of tx.vout) s += leHex(o.value, 8) + varint(o.spk.length / 2) + o.spk;
  if (witnesses) for (const w of witnesses) { s += varint(w.length); for (const item of w) s += varint(item.length / 2) + item; }
  s += leHex(tx.locktime, 4);
  return s;
}

// ---------------------------------------------------------------- sighash
// BIP341 SigMsg for key-path spends (no annex, no script path)
export function taprootSigMsg(tx, index, utxos, hashType = 0) {
  const acp = (hashType & 0x80) !== 0;
  const base = hashType & 3;                        // 0=default(ALL) 1=ALL 2=NONE 3=SINGLE
  const parts = ['00', hashType.toString(16).padStart(2, '0'), leHex(tx.version, 4), leHex(tx.locktime, 4)];
  const H = (hex) => bToHex(sha(hexToB(hex || '') ));
  if (!acp) {
    parts.push(H(tx.vin.map((i) => i.txidLE + leHex(i.vout, 4)).join('')));
    parts.push(H(utxos.map((u) => leHex(u.value, 8)).join('')));
    parts.push(H(utxos.map((u) => varint(u.spk.length / 2) + u.spk).join('')));
    parts.push(H(tx.vin.map((i) => leHex(i.sequence, 4)).join('')));
  }
  if (base !== 2 && base !== 3) {
    parts.push(H(tx.vout.map((o) => leHex(o.value, 8) + varint(o.spk.length / 2) + o.spk).join('')));
  }
  parts.push('00');                                 // spend_type: key path, no annex
  if (acp) {
    const i = tx.vin[index], u = utxos[index];
    parts.push(i.txidLE + leHex(i.vout, 4) + leHex(u.value, 8) + varint(u.spk.length / 2) + u.spk + leHex(i.sequence, 4));
  } else {
    parts.push(leHex(index, 4));
  }
  if (base === 3) {
    const o = tx.vout[index];
    parts.push(H(leHex(o.value, 8) + varint(o.spk.length / 2) + o.spk));
  }
  return parts.join('');
}
export const taprootSigHash = (tx, index, utxos, hashType = 0) =>
  bToHex(tagged('TapSighash', hexToB(taprootSigMsg(tx, index, utxos, hashType))));

// ---------------------------------------------------------------- spend
// the cashier's one move: spend our own P2TR utxos to given outputs
// each input may carry its own ready-to-sign key (input.tweakedPriv, e.g. a
// pay-to-URI deposit key from webledger-address.js); privHex is the fallback
export function buildKeyPathSpend({ inputs, outputs, privHex, hrp = 'tb' }) {
  const tweaked = privHex ? tweakSeckey(privHex) : null;
  const tx = {
    version: 2,
    vin: inputs.map((i) => ({ txidLE: bToHex(hexToB(i.txid).reverse()), vout: i.vout, scriptSig: '', sequence: 0xfffffffd })),
    vout: outputs.map((o) => ({ value: BigInt(o.sats), spk: o.address ? spkFromAddress(o.address) : o.spk })),
    locktime: 0,
  };
  const utxos = inputs.map((i) => ({ value: BigInt(i.sats), spk: i.spk }));
  const witnesses = inputs.map((inp, idx) => [schnorrSign(hexToB(taprootSigHash(tx, idx, utxos, 0)), inp.tweakedPriv || tweaked)]);
  return { rawHex: serializeTx(tx, witnesses), txidDisplay: null };
}
