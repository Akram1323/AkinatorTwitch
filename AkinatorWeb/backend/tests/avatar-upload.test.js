const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const sharp = require('sharp');
const { app } = require('./helpers/setup');

const USER = { username: 'avataruser', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

/**
 * /api/avatar est monté derrière `csrfProtection` (server.js:100) : il faut le
 * cookie de session ET un token CSRF valide, sinon 403. On renvoie les deux.
 */
async function authContext() {
    const reg = await request(app).post('/api/auth/register').send(USER);
    const res = reg.status === 201 ? reg : await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    const cookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

test('un faux fichier image (contenu non décodable) est refusé', async () => {
    const { cookie, csrfToken } = await authContext();
    const res = await request(app).post('/api/avatar/upload')
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken)
        .attach('avatar', Buffer.from('<?php system($_GET["c"]); ?>'), 'evil.jpg');
    assert.strictEqual(res.status, 400);
});

test('une image aux dimensions démesurées est refusée (anti compression-bomb)', async () => {
    const { cookie, csrfToken } = await authContext();
    const bomb = await sharp({
        create: { width: 8000, height: 4000, channels: 3, background: { r: 0, g: 0, b: 0 } }
    }).jpeg({ quality: 10 }).toBuffer();
    const res = await request(app).post('/api/avatar/upload')
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken)
        .attach('avatar', bomb, 'bomb.jpg');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /trop grande|dimensions/i);
});
