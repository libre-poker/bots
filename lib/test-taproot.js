// test-taproot.js — the module faces the BIP341 wallet test vectors.
//   node lib/test-taproot.js <path-to-bip341-vectors.json>
// Every intermediate is checked: tweak, tweaked key, sig message, sighash,
// and the final witness (verified always; byte-equal when nonces align).
import fs from 'node:fs';
import { secp, schnorrVerify, derivePub } from './nostr.js';
import { tweakPubkey, tweakSeckey, scriptPubKeyFor, p2trAddress, decodeAddress, parseTx, taprootSigMsg, taprootSigHash } from './taproot.js';

const V = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (String(got) === String(want)) { pass++; return true; }
  fail++;
  console.log(`FAIL ${name}\n  got  ${got}\n  want ${want}`);
  return false;
};

// ---- scriptPubKey derivation (7 cases, including script trees via merkleRoot)
for (const [i, tc] of V.scriptPubKey.entries()) {
  const root = tc.intermediary.merkleRoot;
  const { outputX } = tweakPubkey(tc.given.internalPubkey, root);
  check(`spk[${i}].tweak`, secp.bToHex(secp.tagged('TapTweak', secp.hexToB(tc.given.internalPubkey), ...(root ? [secp.hexToB(root)] : []))), tc.intermediary.tweak);
  check(`spk[${i}].tweakedPubkey`, outputX, tc.intermediary.tweakedPubkey);
  check(`spk[${i}].scriptPubKey`, scriptPubKeyFor(outputX), tc.expected.scriptPubKey);
  check(`spk[${i}].address`, p2trAddress(outputX, 'bc'), tc.expected.bip350Address);
  const dec = decodeAddress(tc.expected.bip350Address);
  check(`spk[${i}].decode`, dec.program, outputX);
}

// ---- key-path spending (7 cases across hash types)
const kp = V.keyPathSpending[0];
const tx = parseTx(kp.given.rawUnsignedTx);
const utxos = kp.given.utxosSpent.map((u) => ({ value: BigInt(u.amountSats), spk: u.scriptPubKey }));
let byteEqual = 0;
for (const [i, tc] of kp.inputSpending.entries()) {
  const idx = tc.given.txinIndex, ht = tc.given.hashType;
  const pub = derivePub(tc.given.internalPrivkey);
  check(`kp[${i}].internalPubkey`, pub, tc.intermediary.internalPubkey);
  const tweaked = tweakSeckey(tc.given.internalPrivkey, tc.given.merkleRoot);
  check(`kp[${i}].tweakedPrivkey`, tweaked, tc.intermediary.tweakedPrivkey);
  const msg = taprootSigMsg(tx, idx, utxos, ht);
  check(`kp[${i}].sigMsg(ht=${ht})`, msg, tc.intermediary.sigMsg);
  const sigHash = taprootSigHash(tx, idx, utxos, ht);
  check(`kp[${i}].sigHash`, sigHash, tc.intermediary.sigHash);
  // the vector's witness: signature (+hashType byte unless default)
  const wit = tc.expected.witness[0];
  const sig = wit.slice(0, 128);
  const tweakedPub = derivePub(tweaked);
  check(`kp[${i}].witness-verifies`, schnorrVerify(secp.hexToB(sigHash), tweakedPub, sig), true);
  if (ht !== 0) check(`kp[${i}].witness-httag`, wit.slice(128), ht.toString(16).padStart(2, '0'));
  const ours = (await import('./nostr.js')).schnorrSign(secp.hexToB(sigHash), tweaked);
  if (ours === sig) byteEqual++;
}
console.log(`\n${pass} checks passed, ${fail} failed · ${byteEqual}/7 witness signatures byte-identical (nonce-dependent)`);
if (fail) process.exit(1);
console.log('BIP341 VECTORS: ALL PASS — the module may touch sats');
