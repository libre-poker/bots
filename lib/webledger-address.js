// lib/webledger-address.js — pay-to-URI deposit addresses, the webledgers
// convention: any URI gains a deposit address under a host key by adding
// the hash of the URI to the host's public key —
//
//   P_int   = lift_x(hostX) + int(sha256(utf8(uri)))·G
//   address = p2tr(taptweak(P_int.x))            (BIP341, no script tree)
//
// Everything on the address side is public computation: a client that
// knows the host's pubkey (it's right in the DID) derives its own address
// with no server round-trip, and any auditor can recompute the mapping.
// Only the host can spend (it alone knows the host private key).
import { secp } from './nostr.js';
import { tweakPubkey, tweakSeckey, p2trAddress } from './taproot.js';

const { N, G, add, mul, liftX, mod, bToInt, bToHex, intToB, sha } = secp;

export const uriTweak = (uri) => mod(bToInt(sha(new TextEncoder().encode(uri))), N);

export function depositAddressFor(hostXHex, uri, hrp = 'tb') {
  const P = add(liftX(hostXHex), mul(uriTweak(uri), G));
  if (!P) throw new Error('degenerate uri tweak');
  const internalX = bToHex(intToB(P.x));
  const { outputX } = tweakPubkey(internalX);
  return { address: p2trAddress(outputX, hrp), internalX, outputX };
}

// the host's spending key for a uri's deposits (BIP340 even-Y throughout);
// returns the taptweaked seckey, ready for buildKeyPathSpend
export function depositSeckeyFor(hostPrivHex, uri) {
  let d = BigInt('0x' + hostPrivHex);
  if ((mul(d, G).y & 1n) !== 0n) d = N - d;          // even-Y host key first
  const di = mod(d + uriTweak(uri), N);
  return tweakSeckey(bToHex(intToB(di)));
}
