const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, db } = require('./helpers/setup');

const ADMIN = { username: 'adminexpo', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };
const TARGET = { username: 'cibleexpo', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

// Champs qui ne doivent JAMAIS sortir de l'API, quelle que soit la route
const CHAMPS_INTERDITS = [
    'password_hash',
    'a2f_secret',
    'a2f_last_step',
    'password_changed_at',
    'wallet_address'
];

async function login(user) {
    const res = await request(app).post('/api/auth/login').send({ username: user.username, password: user.password });
    return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

async function setupUsers() {
    await request(app).post('/api/auth/register').send(ADMIN);
    await request(app).post('/api/auth/register').send(TARGET);
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(ADMIN.username);
    // On renseigne les colonnes sensibles pour que leur fuite éventuelle soit détectable
    db.prepare("UPDATE users SET a2f_secret = ?, a2f_last_step = ?, wallet_address = ? WHERE username = ?")
        .run('JBSWY3DPEHPK3PXP', 12345, '0xdeadbeef', TARGET.username);
    return db.prepare('SELECT id, tokens, total_games FROM users WHERE username = ?').get(TARGET.username);
}

/**
 * Vérifie l'absence de chaque champ interdit sur la sérialisation JSON complète
 * (et pas seulement sur le premier élément d'une liste).
 */
function assertAucunChampSensible(payload, contexte) {
    const brut = JSON.stringify(payload);
    for (const champ of CHAMPS_INTERDITS) {
        assert.ok(
            !brut.includes(`"${champ}"`),
            `${contexte} : le champ "${champ}" ne doit pas être exposé`
        );
    }
    // Le hash bcrypt lui-même ne doit apparaître sous aucune clé
    assert.ok(!/\$2[aby]\$/.test(brut), `${contexte} : aucun hash bcrypt ne doit être exposé`);
    assert.ok(!brut.includes('JBSWY3DPEHPK3PXP'), `${contexte} : aucun secret TOTP ne doit être exposé`);
}

test('GET /api/admin/users n\'expose aucun champ sensible', async () => {
    await setupUsers();
    const cookie = await login(ADMIN);

    const res = await request(app).get('/api/admin/users').set('Cookie', cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data.users));
    assert.ok(res.body.data.users.length >= 2, 'les deux comptes doivent être listés');

    assertAucunChampSensible(res.body, 'GET /api/admin/users');
});

test('GET /api/admin/users/:id n\'expose aucun champ sensible', async () => {
    const target = await setupUsers();
    const cookie = await login(ADMIN);

    const res = await request(app).get(`/api/admin/users/${target.id}`).set('Cookie', cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.user);

    assertAucunChampSensible(res.body, 'GET /api/admin/users/:id');
});

test('non-régression : les champs attendus par le front restent présents et corrects', async () => {
    const target = await setupUsers();
    const cookie = await login(ADMIN);

    const liste = await request(app).get('/api/admin/users').set('Cookie', cookie);
    assert.strictEqual(liste.status, 200);

    const cible = liste.body.data.users.find(u => u.id === target.id);
    assert.ok(cible, 'la cible doit figurer dans la liste');
    assert.strictEqual(cible.username, TARGET.username);
    assert.strictEqual(cible.tokens, target.tokens);
    assert.strictEqual(cible.total_games, target.total_games);
    assert.strictEqual(cible.is_admin, false);
    for (const champ of ['created_at', 'last_login', 'locked_until', 'failed_login_attempts', 'avatar_url', 'ip_address']) {
        assert.ok(champ in cible, `le champ "${champ}" doit rester présent dans la liste`);
    }

    const admin = liste.body.data.users.find(u => u.username === ADMIN.username);
    assert.ok(admin, "l'admin doit figurer dans la liste");
    assert.strictEqual(admin.is_admin, true, 'is_admin doit être converti en booléen');

    const detail = await request(app).get(`/api/admin/users/${target.id}`).set('Cookie', cookie);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.data.user.username, TARGET.username);
    assert.strictEqual(detail.body.data.user.tokens, target.tokens);
    assert.strictEqual(detail.body.data.user.total_games, target.total_games);
    assert.strictEqual(detail.body.data.user.is_admin, false);
    assert.ok('ip_address' in detail.body.data.user, 'ip_address doit rester présent (déchiffrée)');
    assert.ok(Array.isArray(detail.body.data.transactions));
    assert.strictEqual(typeof detail.body.data.games, 'number');
});
