const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

const USER = { username: 'cookieuser', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

function getCookie(res, name) {
    const raw = (res.headers['set-cookie'] || []).find(c => c.startsWith(name + '='));
    return raw ? raw.split(';')[0].split('=')[1] : null;
}

test('register pose les cookies access_token et refresh_token httpOnly', async () => {
    const res = await request(app).post('/api/auth/register').send(USER);
    assert.strictEqual(res.status, 201);
    const cookies = res.headers['set-cookie'].join(' ');
    assert.match(cookies, /access_token=/);
    assert.match(cookies, /refresh_token=/);
    assert.match(cookies, /HttpOnly/i);
    assert.match(cookies, /SameSite=Strict/i);
});

test('une route protégée accepte le cookie access_token', async () => {
    const login = await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    const access = getCookie(login, 'access_token');
    const me = await request(app).get('/api/auth/me').set('Cookie', `access_token=${access}`);
    assert.strictEqual(me.status, 200);
});

test('POST /api/auth/refresh fait tourner le refresh token', async () => {
    const login = await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    const refresh = getCookie(login, 'refresh_token');

    const r1 = await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${refresh}`);
    assert.strictEqual(r1.status, 200);
    assert.ok(getCookie(r1, 'access_token'), 'nouveau access token posé');

    // Rejouer l'ancien refresh → 401 (reuse) et famille révoquée
    const r2 = await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${refresh}`);
    assert.strictEqual(r2.status, 401);
    const r3 = await request(app).post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${getCookie(r1, 'refresh_token')}`);
    assert.strictEqual(r3.status, 401, 'toute la famille est révoquée');
});

test('logout révoque l\'access token (blacklist persistante)', async () => {
    const login = await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    const access = getCookie(login, 'access_token');
    const cookieHeader = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookieHeader);
    assert.strictEqual(out.status, 200);
    const me = await request(app).get('/api/auth/me').set('Cookie', `access_token=${access}`);
    assert.strictEqual(me.status, 401, 'jeton révoqué même avant expiration');
});
