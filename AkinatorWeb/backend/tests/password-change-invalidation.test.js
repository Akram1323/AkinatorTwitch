const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { app } = require('./helpers/setup');

const USER = { username: 'pwdchange', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };
const NEW_PASSWORD = 'An0ther!Str0ng#Passphrase7';

function getCookie(res, name) {
    const raw = (res.headers['set-cookie'] || []).find(c => c.startsWith(name + '='));
    return raw ? raw.split(';')[0].split('=')[1] : null;
}

test('le changement de mot de passe invalide les sessions antérieures', async () => {
    await request(app).post('/api/auth/register').send(USER);
    const login = await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    const sessionCookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const oldRefresh = getCookie(login, 'refresh_token');

    // Récupère l'id utilisateur pour forger un access token antérieur (iat dans le passé)
    const me = await request(app).get('/api/auth/me').set('Cookie', sessionCookie);
    const userId = me.body.data.id;
    const staleToken = jwt.sign(
        { id: userId, username: USER.username, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) - 30 },
        process.env.JWT_SECRET
    );

    // Le token antérieur fonctionne AVANT le changement
    const before = await request(app).get('/api/auth/me').set('Cookie', `access_token=${staleToken}`);
    assert.strictEqual(before.status, 200, 'token antérieur valide avant changement');

    // Changement de mot de passe depuis la session courante légitime
    const change = await request(app).post('/api/auth/change-password')
        .set('Cookie', sessionCookie)
        .send({ currentPassword: USER.password, newPassword: NEW_PASSWORD });
    assert.strictEqual(change.status, 200);

    // 1) Le token antérieur est désormais rejeté
    const after = await request(app).get('/api/auth/me').set('Cookie', `access_token=${staleToken}`);
    assert.strictEqual(after.status, 401, 'token émis avant le changement doit être rejeté');

    // 2) La session courante survit grâce aux cookies ré-émis par change-password
    const freshAccess = getCookie(change, 'access_token');
    assert.ok(freshAccess, 'change-password ré-émet un access token');
    const current = await request(app).get('/api/auth/me').set('Cookie', `access_token=${freshAccess}`);
    assert.strictEqual(current.status, 200, 'la session courante reste active');

    // 3) L'ancien refresh est révoqué (toutes familles)
    const refresh = await request(app).post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${oldRefresh}`);
    assert.strictEqual(refresh.status, 401, 'refresh antérieur révoqué');
});
