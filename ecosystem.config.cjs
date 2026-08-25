// pm2 fleet: one process per citizen, plus the cashier.
//   pm2 start ecosystem.config.cjs && pm2 save
// cwd is pinned so pm2 resurrect works from anywhere after a reboot.
const HERE = __dirname;
const bots = ['ladder', 'tag', 'rock', 'lag', 'station', 'maniac', 'citizen', 'monk', 'abbot'];
module.exports = {
  apps: [
    ...bots.map((b) => ({
      name: 'lpbot-' + b,
      script: 'lib/run.js',
      args: ['--bot', b],
      cwd: HERE,
      max_restarts: 20,
      restart_delay: 5000,
    })),
    {
      name: 'lp-cashier',
      script: 'cashier/cashier.js',
      cwd: HERE,
      max_restarts: 20,
      restart_delay: 5000,
    },
  ],
};
