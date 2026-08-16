// lib/run.js — launch one bot from its directory.
//   node lib/run.js --bot ladder [--croupier URL] [--max 4] [--room CODE]
import { runFleet } from './seat.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const id = arg('bot', null);
if (!id) { console.error('usage: node lib/run.js --bot <dir>'); process.exit(1); }
const mod = (await import(`../${id}/index.js`)).default;
if (mod.init) await mod.init();
runFleet({
  BASE: arg('croupier', 'https://melvin.me/croupier'),
  bot: { id, ...mod },
  max: Number(arg('max', 4)),
  watchRoom: arg('room', null),
  log: (m) => console.log(`[${id}] ${m}`),
});
