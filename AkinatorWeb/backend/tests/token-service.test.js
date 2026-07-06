const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const tokenService = require('../services/tokenService');
const { v4: uuidv4 } = require('uuid');

function createUser() {
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(id, `user_${id.slice(0, 8)}`, 'x');
    return { id, username: `user_${id.slice(0, 8)}`, is_admin: 0 };
}

test('issueTokenPair retourne un couple access/refresh', () => {
    const pair = tokenService.issueTokenPair(createUser());
    assert.ok(pair.accessToken.split('.').length === 3, 'access = JWT');
    assert.ok(pair.refreshToken.length >= 64, 'refresh = jeton opaque');
    assert.ok(pair.familyId);
});

test('rotateRefreshToken émet un nouveau jeton et invalide l\'ancien', () => {
    const pair = tokenService.issueTokenPair(createUser());
    const r1 = tokenService.rotateRefreshToken(pair.refreshToken);
    assert.strictEqual(r1.ok, true);
    assert.notStrictEqual(r1.newToken, pair.refreshToken);
    // Réutilisation de l'ancien jeton → reuse détecté
    const r2 = tokenService.rotateRefreshToken(pair.refreshToken);
    assert.deepStrictEqual({ ok: r2.ok, reason: r2.reason }, { ok: false, reason: 'reuse' });
    // ... et toute la famille est révoquée, y compris le jeton frais
    const r3 = tokenService.rotateRefreshToken(r1.newToken);
    assert.strictEqual(r3.ok, false);
});

test('jti révoqué est détecté', () => {
    const user = createUser();
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(tokenService.signAccessToken(user));
    assert.strictEqual(tokenService.isJtiRevoked(decoded.jti), false);
    tokenService.revokeAccessToken(decoded);
    assert.strictEqual(tokenService.isJtiRevoked(decoded.jti), true);
    const row = db.prepare('SELECT expires_at FROM revoked_tokens WHERE jti = ?').get(decoded.jti);
    assert.ok(!/T/.test(row.expires_at), 'expires_at au format SQLite, pas ISO');
});
