const session = require('express-session');

// Login sessions in MongoDB, so they survive restarts. `getCol` is called lazily because the
// collection only exists once db.init() has connected.
class MongoStore extends session.Store {
  constructor(getCol) { super(); this.col = getCol; }
  get(sid, cb) {
    this.col().findOne({ _id: sid, expires: { $gt: new Date() } }).then(d => cb(null, d ? JSON.parse(d.data) : null), cb);
  }
  set(sid, sess, cb) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 864e5);
    this.col().updateOne({ _id: sid }, { $set: { data: JSON.stringify(sess), expires } }, { upsert: true }).then(() => cb?.(), e => cb?.(e));
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  destroy(sid, cb) { this.col().deleteOne({ _id: sid }).then(() => cb?.(), e => cb?.(e)); }
}

module.exports = { MongoStore };
