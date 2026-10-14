const session = require('express-session');

// Persistent session store (the default MemoryStore leaks and loses sessions on restart).
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 10 * 60 * 1000).unref();
  }
  get(sid, cb) {
    try {
      const r = this.db.prepare('SELECT data FROM sessions WHERE sid=? AND expires>?').get(sid, Date.now());
      cb(null, r ? JSON.parse(r.data) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid,data,expires) VALUES (?,?,?)').run(sid, JSON.stringify(sess), exp);
      cb?.();
    } catch (e) { cb?.(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  destroy(sid, cb) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb?.(); } catch (e) { cb?.(e); }
  }
}

module.exports = { SqliteStore };
