/**
 * Tests d'intégration du middleware CSRF TEL QU'IL EST MONTÉ dans server.js.
 *
 * Contrairement à csrf-persistent.test.js (qui teste generateCSRFToken /
 * verifyCSRFToken en isolation), ce fichier passe par supertest sur l'app
 * complète : c'est le seul moyen de détecter une erreur d'ordre de montage
 * (csrfProtection placé avant authenticateToken → req.user toujours undefined
 * → toutes les requêtes mutantes passaient sans vérification).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

const PASSWORD = 'C0rrect!Horse#Battery9';

/**
 * Crée un compte dédié et renvoie son cookie de session + un token CSRF valide.
 * @param {string} username Nom d'utilisateur unique à ce fichier de test
 */
async function authContext(username) {
    await request(app).post('/api/auth/register').send({ username, password: PASSWORD, rgpdConsent: true });
    const login = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    assert.strictEqual(csrf.status, 200, 'le token CSRF doit être délivré à un utilisateur authentifié');
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

test('requête mutante authentifiée SANS header X-CSRF-Token → 403', async () => {
    const { cookie } = await authContext('csrfmwmissing');

    const res = await request(app).post('/api/tokens/gift')
        .set('Cookie', cookie)
        .send({ amount: 5 });

    assert.strictEqual(res.status, 403, `attendu 403, reçu ${res.status}`);
    assert.strictEqual(res.body.success, false);
    assert.match(res.body.error, /CSRF/i);
});

test('requête mutante authentifiée avec un token CSRF invalide → 403', async () => {
    const { cookie } = await authContext('csrfmwinvalid');

    const res = await request(app).post('/api/a2f/setup')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', 'token-bidon-0123456789abcdef')
        .send({});

    assert.strictEqual(res.status, 403, `attendu 403, reçu ${res.status}`);
    assert.strictEqual(res.body.success, false);
    assert.match(res.body.error, /CSRF/i);
});

test('le token CSRF d\'un autre utilisateur est rejeté (403)', async () => {
    const victime = await authContext('csrfmwvictime');
    const attaquant = await authContext('csrfmwattaquant');

    const res = await request(app).post('/api/tokens/gift')
        .set('Cookie', victime.cookie)
        .set('X-CSRF-Token', attaquant.csrfToken)
        .send({ amount: 5 });

    assert.strictEqual(res.status, 403, `attendu 403, reçu ${res.status}`);
    assert.match(res.body.error, /CSRF/i);
});

test('requête mutante authentifiée avec un token CSRF valide → succès', async () => {
    const { cookie, csrfToken } = await authContext('csrfmwvalide');

    const res = await request(app).post('/api/tokens/gift')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ amount: 5 });

    assert.strictEqual(res.status, 200, `attendu 200, reçu ${res.status} (${JSON.stringify(res.body)})`);
    assert.strictEqual(res.body.success, true);
});

test('requête GET authentifiée sans token CSRF → succès (pas 403)', async () => {
    const { cookie } = await authContext('csrfmwget');

    const balance = await request(app).get('/api/tokens/balance').set('Cookie', cookie);
    assert.strictEqual(balance.status, 200, `attendu 200, reçu ${balance.status}`);

    const status = await request(app).get('/api/a2f/status').set('Cookie', cookie);
    assert.strictEqual(status.status, 200, `attendu 200, reçu ${status.status}`);
});

test('requête mutante NON authentifiée sur un router protégé → 401/403, jamais 2xx', async () => {
    const mutantes = [
        ['post', '/api/tokens/gift'],
        ['post', '/api/a2f/setup'],
        ['post', '/api/avatar/upload'],
        ['delete', '/api/avatar'],
        ['post', '/api/admin/users/00000000-0000-0000-0000-000000000000/tokens']
    ];

    for (const [method, path] of mutantes) {
        const res = await request(app)[method](path).send({});
        assert.ok(
            res.status === 401 || res.status === 403,
            `${method.toUpperCase()} ${path} : attendu 401/403, reçu ${res.status}`
        );
    }
});

test('les 4 routers protégés refusent une mutation authentifiée sans token CSRF', async () => {
    const { cookie } = await authContext('csrfmwrouters');

    const mutantes = [
        ['post', '/api/tokens/gift'],
        ['post', '/api/a2f/disable'],
        ['delete', '/api/avatar'],
        ['post', '/api/admin/users/00000000-0000-0000-0000-000000000000/tokens']
    ];

    for (const [method, path] of mutantes) {
        const res = await request(app)[method](path).set('Cookie', cookie).send({});
        assert.strictEqual(res.status, 403, `${method.toUpperCase()} ${path} : attendu 403, reçu ${res.status}`);
        assert.match(res.body.error, /CSRF/i, `${method.toUpperCase()} ${path} : l'erreur doit être une erreur CSRF`);
    }
});

test('upload multipart avec token CSRF valide : le middleware laisse passer jusqu\'à multer', async () => {
    // Cas limite désigné : csrfProtection lit `req.headers['x-csrf-token'] || req.body._csrf`,
    // or en multipart `req.body` n'est pas encore parsé. Si quelqu'un inversait un jour
    // la priorité au profit de req.body._csrf, l'upload d'avatar casserait sans qu'aucun
    // autre test ne le voie (les autres ne testent l'upload qu'en anonyme).
    const { cookie, csrfToken } = await authContext('csrfmwmultipart');

    const res = await request(app).post('/api/avatar/upload')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .attach('avatar', Buffer.from('pas-une-vraie-image'), 'avatar.png');

    assert.notStrictEqual(res.status, 403,
        'le middleware CSRF ne doit pas bloquer un upload multipart légitime');
    // 400 = la requête a atteint le handler, qui rejette le contenu (pas une image).
    assert.strictEqual(res.status, 400, `attendu 400 depuis le handler, reçu ${res.status}`);
    assert.ok(!/CSRF/i.test(res.body.error || ''), 'le rejet doit venir du contenu, pas du CSRF');
});

test('les routes mutantes hors des 4 routers sont protégées route par route', async () => {
    // /api/game et /api/auth ne sont pas protégés globalement (login, register et le
    // parcours de jeu public n'ont pas de session), mais leurs routes mutantes qui
    // touchent au solde de jetons, elles, doivent l'être.
    const { cookie, csrfToken } = await authContext('csrfmwhorsrouters');

    for (const path of ['/api/game/start', '/api/auth/claim-daily']) {
        const sansToken = await request(app).post(path).set('Cookie', cookie).send({});
        assert.strictEqual(sansToken.status, 403, `${path} sans token CSRF : attendu 403, reçu ${sansToken.status}`);
        assert.match(sansToken.body.error, /CSRF/i);

        const avecToken = await request(app).post(path)
            .set('Cookie', cookie).set('X-CSRF-Token', csrfToken).send({});
        assert.notStrictEqual(avecToken.status, 403, `${path} avec token CSRF valide ne doit pas être bloqué`);
    }
});
