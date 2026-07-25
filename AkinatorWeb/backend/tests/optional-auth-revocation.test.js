const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

const OWNER = { username: 'oaowner', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };
const ATTACKER = { username: 'oaattacker', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

function getCookie(res, name) {
    const raw = (res.headers['set-cookie'] || []).find(c => c.startsWith(name + '='));
    return raw ? raw.split(';')[0].split('=')[1] : null;
}

test('optionalAuth traite un access token révoqué comme anonyme (POST /api/game/choose)', async () => {
    // Propriétaire : crée une partie
    await request(app).post('/api/auth/register').send(OWNER);
    const ownerLogin = await request(app).post('/api/auth/login')
        .send({ username: OWNER.username, password: OWNER.password });
    const ownerAccess = getCookie(ownerLogin, 'access_token');

    // POST /api/game/start est mutant (il débite un jeton) : token CSRF requis
    const ownerCsrf = await request(app).get('/api/csrf-token')
        .set('Cookie', `access_token=${ownerAccess}`);

    const start = await request(app).post('/api/game/start')
        .set('Cookie', `access_token=${ownerAccess}`)
        .set('X-CSRF-Token', ownerCsrf.body.data.csrfToken);
    assert.strictEqual(start.status, 200);
    const gameId = start.body.data.gameId;

    // Attaquant : se connecte puis se déconnecte (révoque son access token)
    await request(app).post('/api/auth/register').send(ATTACKER);
    const attackerLogin = await request(app).post('/api/auth/login')
        .send({ username: ATTACKER.username, password: ATTACKER.password });
    const attackerAccess = getCookie(attackerLogin, 'access_token');
    const attackerCookieHeader = (attackerLogin.headers['set-cookie'] || [])
        .map(c => c.split(';')[0]).join('; ');

    const logout = await request(app).post('/api/auth/logout').set('Cookie', attackerCookieHeader);
    assert.strictEqual(logout.status, 200);

    // Baseline : requête totalement anonyme (aucun cookie)
    const anonBaseline = await request(app).post('/api/game/choose')
        .send({ gameId, nodeId: 999999 });

    // Requête avec l'ancien access token révoqué de l'attaquant
    const revokedReq = await request(app).post('/api/game/choose')
        .set('Cookie', `access_token=${attackerAccess}`)
        .send({ gameId, nodeId: 999999 });

    // Le token révoqué doit être traité exactement comme une requête anonyme :
    // avant le correctif, optionalAuth positionne req.user malgré la révocation,
    // ce qui déclenche la vérification IDOR et renvoie 403 au lieu de suivre
    // le même chemin que l'anonyme.
    assert.strictEqual(revokedReq.status, anonBaseline.status,
        'le token révoqué ne doit plus être honoré par optionalAuth');
    assert.deepStrictEqual(revokedReq.body, anonBaseline.body,
        'la réponse doit refléter un état anonyme, pas celui de l\'attaquant authentifié');
});
