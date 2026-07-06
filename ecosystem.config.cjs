// PM2 process config for the Road Cruise API.
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup   (survive reboots)
// Env values come from server/.env (loaded by src/loadEnv.js); the few set here
// are process-level defaults. dotenv does NOT override these, so PORT/NODE_ENV
// set here win — keep them in sync with your intent.
module.exports = {
  apps: [
    {
      name: "roadcruise-api",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",           // single instance — SQLite is file-local
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PORT: 5000,
      },
    },
  ],
};
