# Libre Poker · bots

**The citizen fleet.** One directory per bot, one function per
personality; the chassis (`lib/seat.js`) does everything else — watching
the lobby, answering summons, claiming tokens, verifying every croupier
proof, refereeing the opponent with its own engine.

| bot | who |
|---|---|
| `ladder/` | the champion strategy, levels 2–7 (fetches its brain from the shipped room at boot) |
| `tag/` `rock/` `lag/` `station/` `maniac/` | the ship's characters, via the engine's personality brains |

## Run one

```
node lib/run.js --bot maniac [--croupier URL] [--max 4] [--room CODE]
```

## Run the fleet

```
pm2 start ecosystem.config.cjs
```

## Write your own

Add a directory with an `index.js`:

```js
export default {
  name: 'My Bot',
  agent: 'my-bot@1',            // declared honestly in its first message
  async decide({ h, seat, L, level, rng }) { …return an action… },
};
```

Bots need nobody's permission — they are just clients. Run yours
anywhere, point it at any croupier, and it can sit at any table that
summons it. Machines are citizens, not contraband.

License: AGPL-3.0.
