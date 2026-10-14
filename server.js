const { PORT, BASE_URL } = require('./lib/config');
const { db } = require('./lib/db');
const app = require('./app');

const server = app.listen(PORT, () => console.log(`Menu Card listening on :${PORT} (public URL ${BASE_URL})`));

// Graceful shutdown so in-flight requests finish and SQLite flushes on deploys/restarts.
function shutdown(sig) {
  console.log(`${sig} received, shutting down`);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => shutdown(s)));
