const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, db } = require('./helpers/setup');

const USER = { username: 'audituser', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

function lastEvent(type) {
    return db.prepare('SELECT * FROM audit_log WHERE event_type = ? ORDER BY id DESC LIMIT 1').get(type);
}

test('register et login (succès/échec) sont audités', async () => {
    await request(app).post('/api/auth/register').send(USER);
    assert.ok(lastEvent('auth.register'), 'auth.register journalisé');

    await request(app).post('/api/auth/login').send({ username: USER.username, password: 'mauvais-mdp-123!' });
    assert.ok(lastEvent('auth.login.failed'));

    await request(app).post('/api/auth/login').send({ username: USER.username, password: USER.password });
    assert.ok(lastEvent('auth.login.success'));
});

test('GET /api/admin/audit/verify répond avec l\'état de la chaîne', async () => {
    // Promouvoir l'utilisateur admin directement en base pour le test
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(USER.username);
    const login = await request(app).post('/api/auth/login').send({ username: USER.username, password: USER.password });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const res = await request(app).get('/api/admin/audit/verify').set('Cookie', cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.valid, true);
});

test('GET /api/admin/audit?limit=-5 est borné à 1 (pas de contournement du plafond via LIMIT négatif)', async () => {
    // USER a déjà été promu admin par le test précédent
    const login = await request(app).post('/api/auth/login').send({ username: USER.username, password: USER.password });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    // S'assurer qu'il existe au moins 2 entrées d'audit (les tests précédents en génèrent déjà)
    const totalEntries = db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count;
    assert.ok(totalEntries >= 2, 'au moins 2 entrées d\'audit doivent exister pour ce test');

    const res = await request(app).get('/api/admin/audit?limit=-5').set('Cookie', cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.entries.length, 1, 'limit=-5 doit être borné à 1, pas retourner tout le journal');
});
