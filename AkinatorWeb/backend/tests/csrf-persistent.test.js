const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const { generateCSRFToken, verifyCSRFToken } = require('../middleware/csrf');

test('le token CSRF est persisté en base (hashé) et vérifiable', () => {
    const token = generateCSRFToken('user-1');
    assert.strictEqual(verifyCSRFToken('user-1', token), true);
    const row = db.prepare('SELECT * FROM csrf_tokens WHERE user_id = ?').get('user-1');
    assert.ok(row, 'présent en base → survit à un redémarrage');
    assert.notStrictEqual(row.token_hash, token, 'stocké hashé');
});

test('un token expiré est refusé', () => {
    const token = generateCSRFToken('user-2');
    db.prepare(`UPDATE csrf_tokens SET expires_at = datetime('now', '-1 hour') WHERE user_id = 'user-2'`).run();
    assert.strictEqual(verifyCSRFToken('user-2', token), false);
});

test('un token d\'un autre utilisateur est refusé', () => {
    const token = generateCSRFToken('user-3');
    assert.strictEqual(verifyCSRFToken('user-4', token), false);
});
