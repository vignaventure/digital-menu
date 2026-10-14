const { PORT, BASE_URL } = require('./lib/config');
const db = require('./lib/db');
const app = require('./app');

(async () => {
  await db.init(); // connect to MongoDB, create indexes, make sure the super admin exists
  const server = app.listen(PORT, () => console.log(`Menu Card listening on :${PORT} (public URL ${BASE_URL})`));

  // Graceful shutdown so in-flight requests finish and the database connection closes on deploys/restarts.
  function shutdown(sig) {
    console.log(`${sig} received, shutting down`);
    server.close(async () => { await db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  ['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => shutdown(s)));
})().catch(e => { console.error(e.message); process.exit(1); });
