# The cashier

An independent cashier for testnet4 cash games — a **citizen, not an organ**.
It runs wherever its operator runs it (like every bot in this fleet), holds
its keys at home, and is trusted by nobody except the parties who explicitly
sign up to trust it, per game, in writing.

The croupier deals and never touches money. The cashier moves money and
never sees a card. Each one's trustworthiness comes from what it
structurally cannot do — the oldest division of labor in any casino,
enforced here by architecture instead of employment law.

## One key, two roles

`npm init agent` in the cashier's directory mints a nostr identity: a
64-hex secp256k1 key, DID in `agent.did.json`, private key in
`git config nostr.privkey`. Because taproot signatures **are** BIP340
Schnorr — the same algorithm nostr uses — that one key is simultaneously:

- the cashier's **voice**: every message it sends is a signed nostr event,
  verifiable against its DID by `lib/nostr.js`;
- the cashier's **vault**: the BIP341 taproot tweak of the same public key
  yields a P2TR address (`lib/taproot.js`), and the key-path spend from it
  is a Schnorr signature from the same pen.

The taproot module is validated against the BIP341 wallet test vectors —
76/76 checks, all seven reference witness signatures reproduced
byte-for-byte — before it was allowed near a satoshi. Testnet or not,
money code earns its way in with vectors.

## The protocol

Everything happens as messages in one croupier room (default `CASH01`),
every message carrying a signed attestation. The server relays and
archives; it authorizes nothing. There are three claims a party can make:

```
trust    {claim:'trust-cashier', game, stake, cashier: <cashier DID>}
deposit  {claim:'deposit', game, txid, vout}
result   {claim:'result', game, handRoot, winner: <DID>, payoutAddress}
withdraw {claim:'withdraw', game, amount, address}
deposit-check {claim:'deposit-check'}
```

`deposit-check` is the open door: **every nostr account has its own
deposit address**, derived by the [webledgers](https://webledgers.org/)
convention — `P = lift_x(cashierPub) + sha256(utf8(uri))·G`, then the
BIP341 taptweak (`lib/webledger-address.js`; browser twin in
`play/engine/wl-address.js`, parity-tested). The address is pure public
computation from the cashier's DID and yours, so the page derives it with
no server round-trip, and any auditor can recompute the mapping. Send
testnet4 sats there from any wallet, then sign a `deposit-check`: the
cashier derives the same address, credits confirmed coins it hasn't
booked (once per `txid:vout`), and archives a signed `Ledger` credit.
Only the cashier can spend the deposits (it alone can form the tweaked
private key), so custody is unchanged — this fixes *attribution*, not
custody.

The book itself is a **WebLedger document** (JSON-LD, URI→satoshi
entries), with `hands`, `withdrawals`, and `deposits` riding along as
custom fields per the webledgers spec.

`withdraw` is the standing-ledger exit: the player signs an amount and a
destination, and the cashier — after checking the signature, the book
balance, and the address — builds a taproot key-path spend from the vault
(change back to the vault), broadcasts it, debits the book, and archives
a signed `Ledger` document naming the txid. Deduplicated by the signed
event's id, persisted in `ledger.json`. The flat miner fee comes out of
the withdrawn amount. The book is only debited after a successful
broadcast — a failed broadcast leaves the balance untouched.

And the cashier's lifecycle for a two-party, winner-takes-all game:

1. **Trust** — the first two DIDs to sign a trust claim for a game are its
   parties. This is the whole account system: no registration, just a
   signature saying *I trust this cashier with this stake for this game*.
2. **Deposit** — each party sends its stake to the cashier's vault address
   (any wallet, any faucet) and signs a claim naming the `txid:vout`.
   Attribution is by claim, not by address derivation — the cashier
   checks the output on testnet4 (via mempool.space's API) and posts a
   signed `Ledger` document to the archive.
3. **The hand** — played on the ordinary table: croupier-dealt, committed
   root, archived. The cashier is not involved and does not watch.
4. **Result, 2-of-2** — both parties sign a result claim naming the hand
   root and the winner. The cashier **never judges poker**: it pays when
   both signatures agree, stalls when they differ, and that is the entire
   oracle. For a bot party, its operator's ceremony script signs with the
   bot's own key; for a human, with theirs.
5. **Payout** — on agreement, the cashier builds a taproot key-path spend
   of both deposit UTXOs to the winner's address (total minus a flat
   miner fee), broadcasts it, announces the txid, and archives a signed
   `Settlement` document. The chain is the receipt.

Every ledger entry and settlement is a signed document in the public
archive: anyone can recompute any balance from the cashier's signatures
alone. A compromised relay can delay or hide paper; it cannot mint sats,
because it cannot forge BIP340.

## Running it

```bash
# the cashier (operator's machine — where the key lives)
node cashier/cashier.js

# a party's ceremony (any machine holding that party's key)
node cashier/ceremony.js trust   --game G1 --stake 1000 --dir ~/bots/tbtc4/poker/1
node cashier/ceremony.js deposit --game G1 --txid <id> --vout 0 --dir …
node cashier/ceremony.js result  --game G1 --root <handRoot> \
     --winner <did:nostr:…> --payout <tb1p…> --dir …
# --key <64hex> may replace --dir (e.g. a human's xlogin key)
```

Environment: `LP_CASHIER_DIR` (identity directory), `LP_CROUPIER`,
`LP_MEMPOOL`, `LP_CASHIER_ROOM`.

## What this is and is not

This is a **proof of concept for worthless testnet sats among consenting
parties**. Known and accepted limits, stated so nobody has to discover
them:

- **Custodial**: between deposit and payout the cashier's key controls
  the funds. The trust ceremony is real trust.
- **2-of-2 or stall**: a disagreeing (or silent) party freezes the pot;
  resolution is human, not protocol. Timeout-refund logic is future work.
- **One process, one key, one operator's machine** — the same custody
  model as the fleet's DIDs, with the same blast radius.
- The state is in-memory per run; the signed archive documents are the
  durable record.

The road onward, if the one-hand game works: per-game sub-accounts,
timeout refunds, the cashier countersigning archived Match documents as
a standing oracle, and — much later, and only deliberately — anything
that is not testnet.

*The cashier counts signatures, not cards.*
