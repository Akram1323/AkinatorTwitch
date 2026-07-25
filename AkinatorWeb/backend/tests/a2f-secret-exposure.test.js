/**
 * /a2f/setup doit renvoyer le secret TOTP en base32.
 * Le QR code l'encode déjà en clair : ne pas le renvoyer n'apportait aucune
 * sécurité et empêchait l'appairage manuel (poste sans caméra, lecteur d'écran).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

const PASSWORD = 'C0rrect!Horse#Battery9';

async function contexteAuthentifie(username) {
    await request(app).post('/api/auth/register').send({ username, password: PASSWORD, rgpdConsent: true });
    const login = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

test('/a2f/setup renvoie un secret base32 cohérent avec le QR code', async () => {
    const ctx = await contexteAuthentifie('a2fsecret1');

    const res = await request(app).post('/api/a2f/setup')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({});

    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.data.secret, 'string', 'le secret doit être renvoyé');
    assert.match(res.body.data.secret, /^[A-Z2-7]+$/, 'base32 sans padding');
    assert.ok(res.body.data.secret.length >= 16, 'secret d\'au moins 16 caractères');

    // Le secret affiché doit être CELUI du QR : sinon l'appairage manuel produit
    // des codes qui ne valideront jamais.
    const otpauth = decodeURIComponent(res.body.data.otpauthUrl);
    assert.ok(otpauth.includes(res.body.data.secret),
        'le secret renvoyé doit être celui encodé dans l\'otpauth_url');
});
