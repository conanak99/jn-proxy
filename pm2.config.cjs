// PM2 ecosystem for the Bun server. Drop-in replacement for
// references/image-proxy-playwright/pm2.json (which ran a Node app and a
// separate Xvfb sidecar for Playwright). Neither is needed here — there is
// no browser and the runtime is Bun.
//
// We use a CommonJS `.cjs` file (not `pm2.json`) because the Bun docs'
// recommended PM2 setup needs the absolute path to the Bun binary, which
// PM2 cannot expand from `~/.bun/bin/bun` if it's specified as JSON.
//   https://bun.com/docs/guides/ecosystem/pm2
//
// The package's package.json declares `"type": "module"`, so a `.js` file
// would be treated as ESM and `module.exports` would fail — hence `.cjs`.

const path = require('node:path');
const os = require('node:os');

const BUN_BIN_DIR = path.join(os.homedir(), '.bun', 'bin');
const BUN_PATH = process.env.BUN_PATH || path.join(BUN_BIN_DIR, 'bun');

module.exports = {
  apps: [
    {
      name: 'janitor-mobile-ts',
      script: 'index.ts',
      interpreter: BUN_PATH,
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '3000',
        // Tell crawl.ts which Python has curl_cffi installed. Default works
        // on Debian/Ubuntu; override with `JANITOR_PYTHON=...` in the env
        // when launching this config (e.g. `JANITOR_PYTHON=/opt/...` pm2 …).
        JANITOR_PYTHON: process.env.JANITOR_PYTHON || '/usr/bin/python3',
        // Make sure `bun` is resolvable from child processes that pm2 spawns
        // with a minimal PATH.
        PATH: `${BUN_BIN_DIR}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      },
      cron_restart: '0 */3 * * *',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '512M',
    },
  ],
};
