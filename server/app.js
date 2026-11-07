const path = require('path');
const { usd, price } = require('./utils/money');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const db = require('./db');
const SqliteStore = require('./session-store');
const { createInfraClient } = require('./infra/client');
const { currentUser } = require('./services/session');
const { warnings } = require('./services/identity');
const viewIcons = require('./services/icons');

/**
 * Kora — a peer-to-peer USDC ↔ US dollar marketplace built on INFRA.
 * createApp takes the INFRA client so tests can swap in a fake one.
 */
function parseCookies(req, res, next) {
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
    }
  }
  next();
}

// Forms post from our own pages only. SameSite=Lax already stops cross-site
// POSTs carrying the session; this also refuses a foreign Origin outright.
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).render('error', { title: 'Blocked', message: 'This request came from another website, so Kora ignored it.' });
  }
  next();
}

function createApp({ infra } = {}) {
  infra = infra || createInfraClient({ log: db.logApiCall });
  const app = express();

  app.set('trust proxy', 1); // Railway terminates TLS in front of us
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../client/views'));
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    next();
  });
  app.use(express.static(path.join(__dirname, '../client/public'), { maxAge: config.isProduction ? '1h' : 0 }));
  // A short fingerprint of the style sheet, added to its link, so a new
  // design reaches browsers at once instead of after the 1-hour cache.
  const cssVersion = require('crypto').createHash('sha1')
    .update(require('fs').readFileSync(path.join(__dirname, '../client/public/kora.css'))).digest('hex').slice(0, 10);

  // Webhooks read the raw body to check signatures, so they come before the
  // body parsers and sessions.
  app.use('/webhooks', require('./routes/webhooks')({ infra }));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use(parseCookies);
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(express.json({ limit: '20kb' }));
  app.use(session({
    name: 'kora.sid',
    secret: config.sessionSecret,
    store: new SqliteStore(db.db),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 24 * 3600 * 1000 },
  }));
  app.use(sameOrigin);
  app.use((req, res, next) => {
    res.locals.accountsUrl = config.accountsUrl;
    res.locals.usd = usd;
    res.locals.price = price;
    res.locals.warningsFor = warnings;
    Object.assign(res.locals, viewIcons);
    res.locals.cssVersion = cssVersion;
    res.locals.active = req.path.split('/')[1] === 'offers' || req.path.startsWith('/trades') ? 'market' : req.path.split('/')[1];
    next();
  });

  app.get('/', (req, res) => {
    if (currentUser(req)) return res.redirect('/market');
    res.render('index', {
      title: 'Trade USDC with verified people',
      user: null,
      deleted: req.query.deleted === '1',
      configured: Boolean(config.oauth.clientId),
    });
  });

  app.use(require('./routes/auth')({ infra }));
  app.use(require('./routes/market')({ infra }));
  app.use(require('./routes/merchant')({ infra }));
  app.use(require('./routes/account')());
  app.use(require('./routes/zk')({ infra }));
  app.use(require('./routes/verify')());

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Page not found', message: "This page doesn't exist.", user: currentUser(req) });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[kora]', err);
    res.status(500).render('error', {
      title: 'Something went wrong',
      message: err.code === 'INFRA_UNREACHABLE' ? err.message : 'Something went wrong on our side. Please try again.',
    });
  });

  return app;
}

module.exports = { createApp };
