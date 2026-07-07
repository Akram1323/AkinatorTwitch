const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('./helpers/setup');

function craftPendingToken() {
    return jwt.sign(
        { id: 'attacker-id', username: 'attacker', pending2FA: true },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
    );
}

test('un token pending2FA est refusé par une route protégée (via cookie)', async () => {
    const temp = craftPendingToken();
    const res = await request(app).get('/api/auth/me')
        .set('Cookie', `access_token=${temp}`);
    assert.strictEqual(res.status, 401, 'le token 2FA temporaire ne doit pas authentifier');
});

test('un token pending2FA est refusé par une route protégée (via Authorization)', async () => {
    const temp = craftPendingToken();
    const res = await request(app).get('/api/auth/me')
        .set('Authorization', `Bearer ${temp}`);
    assert.strictEqual(res.status, 401, 'le token 2FA temporaire ne doit pas authentifier');
});
