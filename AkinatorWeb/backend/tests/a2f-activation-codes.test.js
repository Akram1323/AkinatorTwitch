/**
 * Invariant : « 2FA active ⇒ codes de secours disponibles ».
 * L'activation et la génération des codes se font dans la même transaction, pour
 * qu'aucun utilisateur ne se retrouve protégé sans filet et sans le savoir.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const speakeasy = require('speakeasy');
const { app, db } = require('./helpers/setup');

const PASSWORD = 'C0rrect!Horse#Battery9';

async function contexteAuthentifie(username) {
    await request(app).post('/api/auth/register').send({ username, password: PASSWORD, rgpdConsent: true });
    const login = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    const userId = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username).id;
    return { cookie, csrfToken: csrf.body.data.csrfToken, userId };
}

/** Enchaîne /setup puis /verify-setup avec un vrai code TOTP. */
async function activerA2F(ctx) {
    const setup = await request(app).post('/api/a2f/setup')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({});
    assert.strictEqual(setup.status, 200);

    const code = speakeasy.totp({ secret: setup.body.data.secret, encoding: 'base32' });
    return request(app).post('/api/a2f/verify-setup')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({ code });
}

test('verify-setup renvoie 8 codes de secours distincts', async () => {
    const ctx = await contexteAuthentifie('a2fcodes1');

    const res = await activerA2F(ctx);

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data.codes), 'les codes doivent être renvoyés');
    assert.strictEqual(res.body.data.codes.length, 8);
    assert.strictEqual(new Set(res.body.data.codes).size, 8, 'codes tous distincts');
    for (const code of res.body.data.codes) {
        assert.match(code, /^[0-9a-f]{10}$/, 'code hexadécimal de 10 caractères');
    }
});

test('activation et codes sont atomiques : 2FA active ⇒ 8 codes utilisables en base', async () => {
    const ctx = await contexteAuthentifie('a2fcodes2');

    await activerA2F(ctx);

    const user = db.prepare('SELECT a2f_enabled FROM users WHERE id = ?').get(ctx.userId);
    assert.strictEqual(user.a2f_enabled, 1, '2FA activée');

    const dispo = db.prepare(
        'SELECT COUNT(*) AS n FROM a2f_backup_codes WHERE user_id = ? AND used_at IS NULL'
    ).get(ctx.userId).n;
    assert.strictEqual(dispo, 8, 'aucune 2FA active sans codes de secours disponibles');
});

test('les codes renvoyés fonctionnent réellement au login', async () => {
    const ctx = await contexteAuthentifie('a2fcodes3');
    const activation = await activerA2F(ctx);
    const codeSecours = activation.body.data.codes[0];

    // Login : la 2FA est active, on reçoit un token temporaire
    const login = await request(app).post('/api/auth/login')
        .send({ username: 'a2fcodes3', password: PASSWORD });
    assert.strictEqual(login.body.requiresA2F, true);

    const res = await request(app).post('/api/auth/verify-login-a2f')
        .set('Authorization', `Bearer ${login.body.data.tempToken}`)
        .send({ code: codeSecours });

    assert.strictEqual(res.status, 200, 'un code de secours doit ouvrir la session');
    assert.strictEqual(res.body.success, true);
});
