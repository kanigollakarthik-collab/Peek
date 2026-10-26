// PM2 process file. One instance: the router's rate counters live in memory.
module.exports = {
  apps: [
    {
      name: 'peek',
      cwd: __dirname + '/../server',
      script: 'src/index.js',
      instances: 1,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
