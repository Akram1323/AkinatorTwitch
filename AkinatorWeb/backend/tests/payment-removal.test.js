const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

const USER = { username: 'paiementuser', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

// Contexte authentifié + CSRF : nécessaire car /api/tokens est derrière
// csrfProtection, qui répondrait 403 avant le 404 attendu.
async function authContext() {
    await request(app).post('/api/auth/register').send(USER);
    const login = await request(app).post('/api/auth/login').send({ username: USER.username, password: USER.password });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

test('les routes de paiement sont supprimées (404)', async () => {
    const { cookie, csrfToken } = await authContext();
    const gone = [
        ['post', '/api/tokens/purchase'],
        ['post', '/api/tokens/verify'],
        ['get', '/api/tokens/prices'],
        ['post', '/api/tokens/btcpay/create'],
        ['get', '/api/tokens/btcpay/status/inv_12345'],
        ['post', '/api/tokens/webhook/btcpay']
    ];
    for (const [method, path] of gone) {
        const res = await request(app)[method](path)
            .set('Cookie', cookie).set('X-CSRF-Token', csrfToken).send({});
        assert.strictEqual(res.status, 404, `${method.toUpperCase()} ${path} doit renvoyer 404, reçu ${res.status}`);
    }
});

test('les routes jetons conservées fonctionnent toujours', async () => {
    const { cookie, csrfToken } = await authContext();

    const balance = await request(app).get('/api/tokens/balance').set('Cookie', cookie);
    assert.strictEqual(balance.status, 200);
    assert.strictEqual(typeof balance.body.data.tokens, 'number');

    const gift = await request(app).post('/api/tokens/gift')
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken).send({ amount: 5 });
    assert.strictEqual(gift.status, 200);

    const history = await request(app).get('/api/tokens/transactions').set('Cookie', cookie);
    assert.strictEqual(history.status, 200);
    assert.ok(Array.isArray(history.body.data));
});
