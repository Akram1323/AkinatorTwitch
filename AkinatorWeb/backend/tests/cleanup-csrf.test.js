const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const { generateCSRFToken } = require('../middleware/csrf');
const { runFullCleanup } = require('../services/cleanup');

test('runFullCleanup() purge les tokens CSRF expirés sans lever d\'exception', () => {
    const token = generateCSRFToken('user-cleanup');
    db.prepare(`UPDATE csrf_tokens SET expires_at = datetime('now', '-1 hour') WHERE user_id = 'user-cleanup'`).run();

    const before = db.prepare('SELECT * FROM csrf_tokens WHERE user_id = ?').get('user-cleanup');
    assert.ok(before, 'le token expiré existe avant le nettoyage');

    assert.doesNotThrow(() => runFullCleanup());

    const after = db.prepare('SELECT * FROM csrf_tokens WHERE user_id = ?').get('user-cleanup');
    assert.strictEqual(after, undefined, 'le token expiré doit être supprimé par runFullCleanup()');
});
