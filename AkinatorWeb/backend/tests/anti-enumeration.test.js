const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

const USER = { username: 'enumuser', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

test('register sur un identifiant pris ne révèle pas l\'existence du compte', async () => {
    await request(app).post('/api/auth/register').send(USER);
    const res = await request(app).post('/api/auth/register').send(USER);
    assert.strictEqual(res.status, 400, 'plus de 409 révélateur');
    assert.ok(!/déjà utilisé/i.test(res.body.error), 'message générique');
    assert.strictEqual(res.body.error, 'Inscription impossible. Vérifiez vos informations et réessayez.');
});
