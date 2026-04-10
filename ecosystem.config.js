module.exports = {
  apps: [{
    name: 'nectar',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
    },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // Graceful shutdown: send SIGINT, wait 10s before SIGKILL
    kill_timeout: 10000,
    listen_timeout: 8000,
  }],
};
