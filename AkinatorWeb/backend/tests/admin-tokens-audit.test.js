const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, db } = require('./helpers/setup');
const { appendAudit } = require('../services/auditService');

const ADMIN = { username: 'adminaudit', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };
const TARGET = { username: 'cibleaudit', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

async function adminContext() {
    await request(app).post('/api/auth/register').send(ADMIN);
    await request(app).post('/api/auth/register').send(TARGET);
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(ADMIN.username);
    const login = await request(app).post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    const target = db.prepare('SELECT id, tokens FROM users WHERE username = ?').get(TARGET.username);
    const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN.username);
    return { cookie, csrfToken: csrf.body.data.csrfToken, target, admin };
}

test("l'attribution de jetons produit une entrée d'audit complète", async () => {
    const { cookie, csrfToken, target, admin } = await adminContext();

    const res = await request(app).post(`/api/admin/users/${target.id}/tokens`)
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken)
        .send({ action: 'add', amount: 7, reason: 'gagnant du concours' });
    assert.strictEqual(res.status, 200);

    const entry = db.prepare("SELECT * FROM audit_log WHERE event_type = 'admin.user.tokens' ORDER BY id DESC LIMIT 1").get();
    assert.ok(entry, "entrée d'audit attendue");
    assert.strictEqual(entry.user_id, admin.id, "user_id = admin acteur");
    assert.ok(entry.ip_hash, 'ip_hash renseigné');

    const details = JSON.parse(entry.details);
    assert.strictEqual(details.targetId, target.id);
    assert.strictEqual(details.targetUsername, TARGET.username);
    assert.strictEqual(details.adminUsername, ADMIN.username);
    assert.strictEqual(details.action, 'add');
    assert.strictEqual(details.amount, 7);
    assert.strictEqual(details.oldBalance, target.tokens);
    assert.strictEqual(details.newBalance, target.tokens + 7);
    assert.strictEqual(details.reason, 'gagnant du concours');
});

test('la chaîne d\'audit reste vérifiable après attribution', async () => {
    const { cookie } = await adminContext();
    const res = await request(app).get('/api/admin/audit/verify').set('Cookie', cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.valid, true);
});

test('GET /api/admin/audit?event_type= filtre par type', async () => {
    const { cookie, csrfToken, target } = await adminContext();
    await request(app).post(`/api/admin/users/${target.id}/tokens`)
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken)
        .send({ action: 'add', amount: 1, reason: 'test filtre' });

    const res = await request(app)
        .get('/api/admin/audit?event_type=admin.user.tokens&limit=50')
        .set('Cookie', cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.entries.length >= 1);
    for (const entry of res.body.data.entries) {
        assert.strictEqual(entry.event_type, 'admin.user.tokens');
    }

    // sans filtre : les autres types (auth.register, ...) sont présents
    const all = await request(app).get('/api/admin/audit?limit=100').set('Cookie', cookie);
    assert.ok(all.body.data.entries.some(e => e.event_type !== 'admin.user.tokens'));
});

test('GET /api/admin/audit?event_type= accepte plusieurs types séparés par des virgules', async () => {
    // Le tableau « Attributions de crédits » du panneau admin doit réunir les
    // attributions directes ET les demandes de jetons approuvées, qui portent
    // deux types d'événement distincts. Sans ce filtre multiple, les
    // approbations étaient journalisées mais jamais affichées.
    const { cookie, csrfToken, target } = await adminContext();

    await request(app).post(`/api/admin/users/${target.id}/tokens`)
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken)
        .send({ action: 'add', amount: 1, reason: 'attribution directe' });

    appendAudit('admin.token_request.approve', {
        userId: target.id,
        details: { targetUsername: TARGET.username, amount: 4, reason: 'demande approuvée' }
    });

    const res = await request(app)
        .get('/api/admin/audit?event_type=admin.user.tokens,admin.token_request.approve&limit=50')
        .set('Cookie', cookie);

    assert.strictEqual(res.status, 200);
    const types = new Set(res.body.data.entries.map(e => e.event_type));
    assert.ok(types.has('admin.user.tokens'), 'les attributions directes doivent être présentes');
    assert.ok(types.has('admin.token_request.approve'), 'les demandes approuvées doivent être présentes');
    assert.strictEqual(types.size, 2, 'aucun autre type ne doit passer le filtre');
});
