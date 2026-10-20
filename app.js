const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const multer = require('multer');
const db = require('./lib/db');
const { isProd, UPLOAD_DIR, SESSION_SECRET } = require('./lib/config');
const { MongoStore } = require('./lib/store');
const { HttpError } = require('./lib/service');

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy / PaaS load balancer: needed for secure cookies and correct client IPs in rate limiting.
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'], // blob: = photo preview while resizing before upload
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"], // pages use small inline handlers such as onclick="logout()"
      styleSrc: ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
}));
app.use(compression());

// Liveness/readiness probe for the host.
app.get('/health', async (req, res) => {
  try { await db.ping(); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'error' }); }
});

// Pages, scripts and styles are re-checked on every load (cheap 304 when unchanged), so a deploy shows up immediately
// and a browser never mixes an old script with a new one. Fonts never change, so they are cached for a year.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => res.setHeader('Cache-Control', /[\\/]fonts[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'),
}));
// Upload names are random UUIDs, so they can be cached forever.
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

// API docs viewer (Swagger UI), served from node_modules so no third-party CDN is needed
app.use('/api/docs/assets', express.static(path.dirname(require.resolve('swagger-ui-dist/package.json')), { index: false, maxAge: isProd ? '7d' : 0 }));

app.use(session({
  name: 'sid',
  secret: SESSION_SECRET,
  store: new MongoStore(() => db.cols.sessions),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd ? 'auto' : false, maxAge: 1000 * 60 * 60 * 12 },
}));
app.use('/api/v1', require('./routes/api'));
app.use(require('./routes/web'));

app.use((req, res) => (req.path.startsWith('/api/') ? res.status(404).json({ error: 'Not found' }) : res.status(404).type('text').send('Page not found')));

app.use((err, req, res, next) => {
  let status = err.status || 500, message = err.message;
  if (err instanceof multer.MulterError) { status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400; message = err.code === 'LIMIT_FILE_SIZE' ? 'Image too large (max 5MB)' : err.message; }
  else if (err.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON'; }
  else if (err.type === 'entity.too.large') { status = 413; message = 'That image is too large'; }
  else if (db.isDuplicate(err)) { status = 409; message = 'That value is already in use'; }
  else if (!(err instanceof HttpError) && !(status < 500)) { console.error(err); message = 'Internal server error'; }
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).send(status < 500 ? message : 'Something went wrong');
});

module.exports = app;
