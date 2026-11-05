const config = require('./config');
const { createApp } = require('./app');

const app = createApp();

app.listen(config.port, () => {
  const missing = [
    !config.oauth.clientId && 'CLIENT_ID',
    !config.oauth.clientSecret && 'CLIENT_SECRET',
    !config.webhookSecret && 'WEBHOOK_SECRET',
    !config.payv.clientId && 'PayV credentials (merchant badge off)',
  ].filter(Boolean);
  console.log(`Kora is running on http://localhost:${config.port}`);
  console.log(`INFRA API: ${config.apiBase}`);
  if (missing.length) console.log(`Not set: ${missing.join(', ')}. See README.md.`);
});
