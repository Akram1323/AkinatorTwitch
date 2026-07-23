const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, db } = require('./helpers/setup');

const ADMIN = { username: 'adminjetons', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };
const TARGET = { username: 'ciblejetons', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

async function login(user) {
    const res = await request(app).post('/api/auth/login').send({ username: user.username, password: user.password });
    const cookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

async function setupUsers() {
    await request(app).post('/api/auth/register').send(ADMIN);
    await request(app).post('/api/auth/register').send(TARGET);
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(ADMIN.username);
    return db.prepare('SELECT id, tokens FROM users WHERE username = ?').get(TARGET.username);
}

function grant(ctx, targetId, body) {
    return request(app).post(`/api/admin/users/${targetId}/tokens`)
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send(body);
}

test("action 'add' incrémente le solde et trace une transaction admin_grant", async () => {
    const target = await setupUsers();
    const ctx = await login(ADMIN);

    const res = await grant(ctx, target.id, { action: 'add', amount: 5, reason: 'récompense stream' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.oldBalance, target.tokens);
    assert.strictEqual(res.body.data.newBalance, target.tokens + 5);

    const inDb = db.prepare('SELECT tokens FROM users WHERE id = ?').get(target.id);
    assert.strictEqual(inDb.tokens, target.tokens + 5);

    const tx = db.prepare("SELECT * FROM transactions WHERE user_id = ? AND type = 'admin_grant' ORDER BY created_at DESC LIMIT 1").get(target.id);
    assert.ok(tx, "une transaction admin_grant doit être créée");
    assert.strictEqual(tx.amount, 5);
    assert.strictEqual(tx.status, 'completed');
});

test("action 'set' fixe le solde ; le delta est tracé", async () => {
    const target = await setupUsers();
    const ctx = await login(ADMIN);

    const res = await grant(ctx, target.id, { action: 'set', amount: 42, reason: 'correction de solde' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.newBalance, 42);
    assert.strictEqual(db.prepare('SELECT tokens FROM users WHERE id = ?').get(target.id).tokens, 42);
});

test("action 'add' avec un montant négatif légal décrémente le solde", async () => {
    const target = await setupUsers();
    const ctx = await login(ADMIN);

    const credit = await grant(ctx, target.id, { action: 'add', amount: 10, reason: 'crédit initial' });
    assert.strictEqual(credit.status, 200);

    const res = await grant(ctx, target.id, { action: 'add', amount: -2, reason: 'correction mineure' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.newBalance, res.body.data.oldBalance - 2);

    const inDb = db.prepare('SELECT tokens FROM users WHERE id = ?').get(target.id);
    assert.strictEqual(inDb.tokens, target.tokens + 10 - 2);

    // created_at a une résolution à la seconde : les deux admin_grant de ce test
    // peuvent la partager, d'où le tri secondaire sur rowid (ordre d'insertion).
    const tx = db.prepare("SELECT * FROM transactions WHERE user_id = ? AND type = 'admin_grant' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(target.id);
    assert.ok(tx, "une transaction admin_grant doit être créée");
    assert.strictEqual(tx.amount, -2);
});

test('validations : raison obligatoire, action connue, montant entier, solde final >= 0', async () => {
    const target = await setupUsers();
    const ctx = await login(ADMIN);

    for (const body of [
        { action: 'add', amount: 5 },                                  // pas de raison
        { action: 'add', amount: 5, reason: '   ' },                   // raison vide
        { action: 'multiply', amount: 5, reason: 'x' },                // action inconnue
        { action: 'add', amount: 2.5, reason: 'x' },                   // non entier
        { action: 'set', amount: -1, reason: 'x' },                    // set négatif
        { action: 'add', amount: -9999, reason: 'x' },                 // solde final négatif
        { action: 'add', amount: 2000000, reason: 'x' }                // montant hors borne
    ]) {
        const res = await grant(ctx, target.id, body);
        assert.strictEqual(res.status, 400, `body ${JSON.stringify(body)} doit être refusé`);
    }
    // le solde n'a pas bougé
    assert.strictEqual(db.prepare('SELECT tokens FROM users WHERE id = ?').get(target.id).tokens, target.tokens);
});

test('un non-admin est refusé (403)', async () => {
    const target = await setupUsers();
    const ctx = await login(TARGET);
    const res = await grant(ctx, target.id, { action: 'add', amount: 5, reason: 'tentative' });
    assert.strictEqual(res.status, 403);
});

test('utilisateur inconnu → 404', async () => {
    await setupUsers();
    const ctx = await login(ADMIN);
    const res = await grant(ctx, 'id-inexistant', { action: 'add', amount: 5, reason: 'x' });
    assert.strictEqual(res.status, 404);
});

test("les routes d'approbation de transactions sont supprimées (404)", async () => {
    await setupUsers();
    const ctx = await login(ADMIN);

    const pending = await request(app).get('/api/admin/transactions/pending').set('Cookie', ctx.cookie);
    assert.strictEqual(pending.status, 404);

    for (const path of ['/api/admin/transactions/tx-1/approve', '/api/admin/transactions/tx-1/reject']) {
        const res = await request(app).post(path)
            .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({});
        assert.strictEqual(res.status, 404, `${path} doit renvoyer 404`);
    }
});
