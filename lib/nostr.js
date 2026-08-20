// lib/nostr.js — the fleet's pen: pure-JS secp256k1 + BIP340 Schnorr,
// zero dependencies, enough to sign and verify nostr events. A declared
// bot signs what it says; anyone can check the signature against its DID.
//
// Parity anchor: derivePub(privkey) must reproduce the pubkey that
// created-agent's real library minted — tested in test-citizen.js.
import { createHash } from 'node:crypto';

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};

const mod = (a, m = P) => ((a % m) + m) % m;
function modpow(b, e, m) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
const inv = (a, m = P) => modpow(mod(a, m), m - 2n, m);

// affine point arithmetic — volume is a handful of ops per message
function add(a, b) {
  if (!a) return b; if (!b) return a;
  if (a.x === b.x && mod(a.y + b.y) === 0n) return null;
  let l;
  if (a.x === b.x && a.y === b.y) l = mod(3n * a.x * a.x * inv(2n * a.y));
  else l = mod((b.y - a.y) * inv(mod(b.x - a.x)));
  const x = mod(l * l - a.x - b.x);
  return { x, y: mod(l * (a.x - x) - a.y) };
}
function mul(k, pt) { let r = null, q = pt; k = mod(k, N); while (k > 0n) { if (k & 1n) r = add(r, q); q = add(q, q); k >>= 1n; } return r; }

const hexToB = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const bToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const bToInt = (b) => BigInt('0x' + bToHex(b));
const intToB = (i) => hexToB(i.toString(16).padStart(64, '0'));
const sha = (...bs) => { const h = createHash('sha256'); for (const b of bs) h.update(b); return new Uint8Array(h.digest()); };
const tagged = (tag, ...bs) => { const t = sha(new TextEncoder().encode(tag)); return sha(t, t, ...bs); };

export function derivePub(privHex) {
  const Pt = mul(BigInt('0x' + privHex), G);
  return intToB(Pt.x).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');
}

function liftX(xHex) {
  const x = BigInt('0x' + xHex);
  if (x >= P) return null;
  const y2 = mod(x * x * x + 7n);
  const y = modpow(y2, (P + 1n) / 4n, P);
  if (mod(y * y) !== y2) return null;
  return { x, y: (y & 1n) === 0n ? y : P - y };
}

export function schnorrSign(msg32, privHex, auxHex = '00'.repeat(32)) {
  let d = BigInt('0x' + privHex);
  const Pt = mul(d, G);
  if ((Pt.y & 1n) !== 0n) d = N - d;
  const px = intToB(Pt.x);
  const t = intToB(d ^ bToInt(tagged('BIP0340/aux', hexToB(auxHex))));
  const k0 = mod(bToInt(tagged('BIP0340/nonce', t, px, msg32)), N);
  if (k0 === 0n) throw new Error('bad nonce');
  const R = mul(k0, G);
  const k = (R.y & 1n) === 0n ? k0 : N - k0;
  const e = mod(bToInt(tagged('BIP0340/challenge', intToB(R.x), px, msg32)), N);
  return bToHex(intToB(R.x)) + bToHex(intToB(mod(k + e * d, N)));
}

export function schnorrVerify(msg32, pubHex, sigHex) {
  const Pt = liftX(pubHex);
  if (!Pt || sigHex.length !== 128) return false;
  const r = BigInt('0x' + sigHex.slice(0, 64)), s = BigInt('0x' + sigHex.slice(64));
  if (r >= P || s >= N) return false;
  const e = mod(bToInt(tagged('BIP0340/challenge', hexToB(sigHex.slice(0, 64)), hexToB(pubHex), msg32)), N);
  const R = add(mul(s, G), mul(mod(-e, N), Pt));
  return !!R && (R.y & 1n) === 0n && R.x === r;
}

// a signed nostr event wrapping arbitrary content — the fleet's attestation
export function signEvent({ content, kind = 20777, tags = [], privHex, created_at }) {
  const pubkey = derivePub(privHex);
  const ser = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const id = bToHex(sha(new TextEncoder().encode(ser)));
  const sig = schnorrSign(hexToB(id), privHex);
  return { id, pubkey, created_at, kind, tags, content, sig };
}

// low-level curve access for siblings (taproot shares this heart)
export const secp = { P, N, G, mod, add, mul, liftX, modpow, hexToB, bToHex, bToInt, intToB, sha, tagged };

export function verifyEvent(ev) {
  const ser = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  const id = bToHex(sha(new TextEncoder().encode(ser)));
  if (id !== ev.id) return false;
  return schnorrVerify(hexToB(ev.id), ev.pubkey, ev.sig);
}
