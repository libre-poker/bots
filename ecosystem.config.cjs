// pm2 fleet: one process per citizen.  pm2 start ecosystem.config.cjs
const bots = ['ladder', 'tag', 'rock', 'lag', 'station', 'maniac'];
module.exports = {
  apps: bots.map((b) => ({
    name: 'lpbot-' + b,
    script: 'lib/run.js',
    args: ['--bot', b],
    max_restarts: 20,
    restart_delay: 5000,
  })),
};
