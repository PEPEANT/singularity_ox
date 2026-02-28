module.exports = {
  apps: [
    {
      name: "reclaim-fps-client",
      script: "node_modules/vite/bin/vite.js",
      args: "preview --host 0.0.0.0 --port 5173 --strictPort",
      cwd: __dirname,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      env: {
        NODE_ENV: "production"
      },
      env_production: {
        NODE_ENV: "production"
      }
    },
    {
      name: "reclaim-fps-chat",
      script: "server.js",
      cwd: __dirname,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      env: {
        NODE_ENV: "production",
        PORT: "3001"
      },
      env_production: {
        NODE_ENV: "production",
        PORT: "3001"
      }
    }
  ]
};
