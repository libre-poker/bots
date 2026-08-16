// lib/seat.js — the citizen chassis. Everything every bot does except
// deciding: watching the lobby for summons, claiming its token, verifying
// the croupier's every proof, refereeing the host's actions with its own
// engine, syncing boards by consent, and showing down. A bot directory
// supplies only { name, agent, match(summon), decide(ctx) }.
//
// Machines are citizens, not contraband (constitution §2.5).
import { newHand, legal, act, rngFromSeed } from '../engine/poker.js';
import { verifyReveal } from './croupier-verify.js';
import { createHash, randomBytes } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');

export function makeClient(BASE) {
  const post = (path, body, token) => fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  function sse(url, onEvent, onClose) {
    const ctl = new AbortController();
    fetch(url, { signal: ctl.signal }).then(async (res) => {
      const reader = res.body.getReader();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = chunk.match(/^data: (.*)$/m);
          if (m) { try { onEvent(JSON.parse(m[1])); } catch { /* bad frame */ } }
        }
      }
      onClose?.();
    }).catch(() => onClose?.());
    return ctl;
  }
  return { post, sse };
}

// one seated match: the bot is always the guest (engine seat 1)
export async function playRoom({ BASE, room, bot, summon, log }) {
  const { post, sse } = makeClient(BASE);
  const pid = 'bot-' + randomBytes(6).toString('hex');
  const level = Math.min(7, Math.max(2, (summon.level | 0) || 5));
  const name = bot.displayName ? bot.displayName(level) : bot.name;
  let seq = 0;
  let hostPid = summon.from || null;          // the summoner is the live host
  const inbox = [], waiters = [];
  const send = (msg) => post('/room/send', { room, msg: { from: pid, seq: seq++, agent: bot.agent, ...msg } });
  const next = (pred, ms = 10 * 60000) => new Promise((resolve, reject) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
    waiters.push({ pred, resolve });
    setTimeout(() => reject(new Error('opponent timeout')), ms);
  });
  const roomCtl = sse(`${BASE}/room/events?room=${room}`, (entry) => {
    const m = entry.msg;
    if (!m || m.from === pid) return;
    if (m.type === 'hello' || m.type === 'hello2') return;   // host is known from the summon
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { const w = waiters[i]; waiters.splice(i, 1); return w.resolve(m); }
    }
    inbox.push(m);
    if (inbox.length > 200) inbox.shift();
  });

  try {
    if (!hostPid) throw new Error('summon carried no sender');
    await send({ type: 'hello', name, re: hostPid });
    log(`seated in ${room} as "${name}" vs ${hostPid.slice(0, 8)}`);

    let handNo = 0;
    for (;;) {
      handNo++;
      const start = await next((m) => m.type === 'start' && m.handNo === handNo && m.from === hostPid);
      const claimed = await post('/claim', { sid: start.sid, party: pid, code: start.claim });
      if (!claimed.token) throw new Error('claim refused');
      const reveals = new Map(), rWaiters = [];
      const cCtl = sse(`${BASE}/events?sid=${start.sid}&token=${claimed.token}`, (ev) => {
        if (ev.ev === 'reveal' && ev.value !== undefined) {
          if (!verifyReveal(start.root, ev)) { log(`PROOF FAILED in ${room} — leaving`); roomCtl.abort(); return; }
          reveals.set(ev.index, ev.value);
          for (let i = rWaiters.length - 1; i >= 0; i--) {
            if (rWaiters[i].idx.every((k) => reveals.has(k))) { const w = rWaiters[i]; rWaiters.splice(i, 1); w.resolve(); }
          }
        }
      });
      const ready = (idx) => new Promise((resolve) => {
        if (idx.every((k) => reveals.has(k))) return resolve();
        rWaiters.push({ idx, resolve });
      });
      const consent = (index, to) => post('/consent', { sid: start.sid, op: { kind: 'reveal', index, to } }, claimed.token);

      const h = newHand({
        seats: [{ name: 'host', stack: 2000 }, { name, stack: 2000 }],
        button: handNo % 2, sb: 10, bb: 20, seedHex: '00'.repeat(32), limit: true,
      });
      for (const [idx, to] of [[0, hostPid], [1, hostPid], [2, pid], [3, pid]]) consent(idx, to);
      await ready([2, 3]);
      h.seats[1].hole = [reveals.get(2), reveals.get(3)];

      const rng = rngFromSeed(sha(`${start.sid}|${bot.agent}|${handNo}`));
      const ctx = { level, rng, cache: {} };
      let lastStreet = 0, guard = 0;
      while (h.phase === 'act' && guard++ < 200) {
        const L = legal(h);
        if (L.seat === 1) {
          await new Promise((r) => setTimeout(r, 600 + rng() * 900));
          const a = await bot.decide({ h, seat: 1, L, ...ctx });
          act(h, a);
          await send({ type: 'act', handNo, action: a.action, amount: a.amount ?? null });
        } else {
          const m = await next((x) => x.type === 'act' && x.handNo === handNo && x.from === hostPid);
          const L2 = legal(h);
          if (L2.seat !== 0 || !L2.actions.includes(m.action)) throw new Error('host played illegally');
          act(h, { seat: 0, action: m.action, amount: m.amount ?? undefined });
        }
        if (h.street !== lastStreet && h.phase === 'act') {
          const idx = Array.from({ length: h.board.length }, (_, k) => 4 + k);
          for (const i of idx) if (!reveals.has(i)) consent(i, 'all');
          await ready(idx);
          for (let k = 0; k < h.board.length; k++) h.board[k] = reveals.get(4 + k);
          lastStreet = h.street;
        }
      }
      if (!h.seats.some((s2) => s2.folded)) {
        for (const i of [0, 1, 2, 3]) consent(i, 'all');
        await ready([0, 1, 2, 3]).catch(() => {});
      }
      cCtl.abort();
    }
  } catch (e) {
    log(`leaving ${room}: ${e.message || e}`);
  } finally {
    roomCtl.abort();
  }
}

// the watcher: scan the directory (or one fixed room), answer matching summons
export function runFleet({ BASE, bot, max = 4, watchRoom = null, log = console.log }) {
  const { sse } = makeClient(BASE);
  const engaged = new Map(), watched = new Map();

  const matches = (m, t) => {
    if (m?.type !== 'summon') return false;
    if (Date.now() - (t || 0) > 60000) return false;   // ignore summons replayed from history
    if (m.bot) return m.bot === bot.id;
    return bot.id === 'ladder';                 // legacy {level}-only summons
  };
  function watch(room) {
    if (watched.has(room) || engaged.has(room)) return;
    const ctl = sse(`${BASE}/room/events?room=${room}`, (entry) => {
      const m = entry.msg;
      if (matches(m, entry.t) && !engaged.has(room) && engaged.size < max) {
        engaged.set(room, true);
        ctl.abort(); watched.delete(room);
        playRoom({ BASE, room, bot, summon: m, log })
          .finally(() => engaged.delete(room));
      }
    }, () => watched.delete(room));
    watched.set(room, ctl);
  }
  async function scan() {
    if (engaged.size >= max) return;
    if (watchRoom) return watch(watchRoom);
    try {
      const list = (await fetch(BASE + '/room/list').then((r) => r.json())).rooms || [];
      for (const t of list) { if (watched.size > 50) break; watch(t.room); }
    } catch { /* directory unreachable; retry next tick */ }
  }
  setInterval(scan, 4000);
  scan();
  log(`${bot.id}: watching ${watchRoom ? 'room ' + watchRoom : 'the lobby'} at ${BASE} (max ${max})`);
}
