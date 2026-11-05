const session = require('express-session');

/**
 * Sessions in SQLite, so signing in survives a restart and so Kora can sign a
 * person out everywhere when INFRA says they revoked access (sessions carry
 * the user id).
 */
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.getStmt = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(`
      INSERT INTO sessions (sid, user_id, sess, expires) VALUES (?, ?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET user_id = excluded.user_id, sess = excluded.sess, expires = excluded.expires
    `);
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires < ?');
    this.timer = setInterval(() => this.pruneStmt.run(Date.now()), 15 * 60 * 1000);
    this.timer.unref();
  }

  static expiryOf(sess) {
    const expires = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(expires) ? expires : Date.now() + 24 * 60 * 60 * 1000;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.setStmt.run(sid, sess.userId || null, JSON.stringify(sess), SqliteStore.expiryOf(sess));
      cb(null);
    } catch (err) { cb(err); }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.touchStmt.run(SqliteStore.expiryOf(sess), sid);
      cb(null);
    } catch (err) { cb(err); }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.destroyStmt.run(sid);
      cb(null);
    } catch (err) { cb(err); }
  }
}

module.exports = SqliteStore;
