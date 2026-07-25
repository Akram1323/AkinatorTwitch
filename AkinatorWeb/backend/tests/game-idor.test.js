/**
 * Non-régression IDOR sur les routes de jeu (optionalAuth).
 * Un gameId fourni doit toujours être validé, y compris pour un appelant sans
 * session : sans ce contrôle, une requête anonyme peut clôturer la partie d'un tiers.
 *
 * Distinction importante entre les deux refus :
 * - 401 = pas de session (absente ou access token expiré). Ces routes sont sous
 *   `optionalAuth`, qui ne renvoie jamais 401 lui-même ; c'est donc au contrôle de
 *   propriété de le faire, sinon le propriétaire légitime dont le token a expiré
 *   en pleine partie reçoit un 403 que le client ne sait pas rejouer → partie et
 *   jeton perdus.
 * - 403 = session valide, mais la partie appartient à quelqu'un d'autre.
 *
 * Note : les identifiants IGDB ne sont pas configurés en test, la recherche
 * retombe sur une liste vide — on n'assert donc jamais sur le contenu de `games`.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, db } = require('./helpers/setup');

const VICTIME = { username: 'idorvictime', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };
const ATTAQUANT = { username: 'idorattaquant', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

const FILTRES = [{ type: 'genre', slug: 'action', text: 'Action' }];

/**
 * Inscrit puis connecte un utilisateur, et le crédite en jetons :
 * ce fichier enchaîne plusieurs parties (1 jeton chacune).
 * Le token CSRF est nécessaire : POST /api/game/start est mutant et débite un jeton.
 */
async function connecter(user) {
    await request(app).post('/api/auth/register').send(user);
    const login = await request(app).post('/api/auth/login')
        .send({ username: user.username, password: user.password });
    assert.strictEqual(login.status, 200, `connexion de ${user.username} impossible`);
    db.prepare('UPDATE users SET tokens = 50 WHERE username = ?').run(user.username);

    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

let contextePromise = null;
function contexte() {
    if (!contextePromise) {
        contextePromise = (async () => ({
            victime: await connecter(VICTIME),
            attaquant: await connecter(ATTAQUANT)
        }))();
    }
    return contextePromise;
}

async function nouvellePartie(ctx) {
    const start = await request(app).post('/api/game/start')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken);
    assert.strictEqual(start.status, 200, 'la partie doit démarrer');
    return start.body.data.gameId;
}

function lignePartie(gameId) {
    return db.prepare(
        'SELECT id, user_id, filters_used, games_recommended, completed_at FROM games WHERE id = ?'
    ).get(gameId);
}

// Nœud feuille créé à la volée : l'arbre n'est pas semé dans l'environnement de test
let noeudFeuille = null;
function nodeIdValide() {
    if (noeudFeuille === null) {
        noeudFeuille = db.prepare(`
            INSERT INTO decision_tree (question_text, slug_igdb, parent_id, depth, filter_type)
            VALUES (?, ?, ?, ?, ?)
        `).run('Action', 'action', 0, 1, 'genre').lastInsertRowid;
    }
    return noeudFeuille;
}

// ===========================================
// POST /api/game/recommend
// ===========================================

test('recommend sans session avec le gameId d\'un tiers → 401 et partie intacte', async () => {
    const { victime } = await contexte();
    const gameId = await nouvellePartie(victime);

    const avant = lignePartie(gameId);
    assert.strictEqual(avant.completed_at, null, 'la partie doit être ouverte au départ');

    const res = await request(app).post('/api/game/recommend').send({ gameId, filters: FILTRES });

    assert.strictEqual(res.status, 401, 'sans session, la partie d\'un tiers est refusée');
    assert.strictEqual(res.body.success, false);

    const apres = lignePartie(gameId);
    assert.deepStrictEqual(apres, avant, 'la ligne games de la victime doit être inchangée');
    assert.strictEqual(apres.completed_at, null, 'la partie ne doit pas avoir été clôturée');
});

test('recommend authentifié sur la partie d\'un autre → 403 et partie intacte', async () => {
    const { victime, attaquant } = await contexte();
    const gameId = await nouvellePartie(victime);
    const avant = lignePartie(gameId);

    const res = await request(app).post('/api/game/recommend')
        .set('Cookie', attaquant.cookie).send({ gameId, filters: FILTRES });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.deepStrictEqual(lignePartie(gameId), avant, 'la ligne games de la victime doit être inchangée');
});

test('recommend par le propriétaire → 200 et partie clôturée', async () => {
    const { victime } = await contexte();
    const gameId = await nouvellePartie(victime);

    const res = await request(app).post('/api/game/recommend')
        .set('Cookie', victime.cookie).send({ gameId, filters: FILTRES });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);

    const apres = lignePartie(gameId);
    assert.notStrictEqual(apres.completed_at, null, 'le propriétaire doit pouvoir clôturer sa partie');
});

test('recommend anonyme sans gameId → 200 (jeu anonyme sans persistance)', async () => {
    const res = await request(app).post('/api/game/recommend').send({ filters: FILTRES });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
});

test('recommend authentifié avec un gameId inexistant → 404', async () => {
    const { attaquant } = await contexte();
    const res = await request(app).post('/api/game/recommend')
        .set('Cookie', attaquant.cookie).send({ gameId: 'partie-qui-nexiste-pas', filters: FILTRES });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.success, false);
});

test('recommend authentifié sur une partie orpheline (user_id NULL) → 403', async () => {
    const { victime, attaquant } = await contexte();
    const gameId = await nouvellePartie(victime);
    db.prepare('UPDATE games SET user_id = NULL WHERE id = ?').run(gameId);
    const avant = lignePartie(gameId);

    const res = await request(app).post('/api/game/recommend')
        .set('Cookie', attaquant.cookie).send({ gameId, filters: FILTRES });

    assert.strictEqual(res.status, 403, 'une partie orpheline n\'appartient à aucun appelant');
    assert.deepStrictEqual(lignePartie(gameId), avant, 'la partie orpheline doit rester inchangée');
});

test('recommend avec un gameId non-string → 400 (pas de 500 sur le binding SQL)', async () => {
    const { victime } = await contexte();
    const res = await request(app).post('/api/game/recommend')
        .set('Cookie', victime.cookie).send({ gameId: { $ne: null }, filters: FILTRES });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
});

// ===========================================
// POST /api/game/choose
// ===========================================

test('choose sans session avec le gameId d\'un tiers → 401', async () => {
    const { victime } = await contexte();
    const gameId = await nouvellePartie(victime);

    const res = await request(app).post('/api/game/choose')
        .send({ gameId, nodeId: nodeIdValide() });

    assert.strictEqual(res.status, 401, 'sans session, la partie d\'un tiers est refusée');
    assert.strictEqual(res.body.success, false);
});

test('choose authentifié sur la partie d\'un autre → 403', async () => {
    const { victime, attaquant } = await contexte();
    const gameId = await nouvellePartie(victime);

    const res = await request(app).post('/api/game/choose')
        .set('Cookie', attaquant.cookie).send({ gameId, nodeId: nodeIdValide() });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
});

test('choose par le propriétaire → 200', async () => {
    const { victime } = await contexte();
    const gameId = await nouvellePartie(victime);

    const res = await request(app).post('/api/game/choose')
        .set('Cookie', victime.cookie).send({ gameId, nodeId: nodeIdValide() });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
});

test('choose anonyme sans gameId → 200 (jeu anonyme sans persistance)', async () => {
    const res = await request(app).post('/api/game/choose').send({ nodeId: nodeIdValide() });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
});

test('choose authentifié avec un gameId inexistant → 404', async () => {
    const { attaquant } = await contexte();
    const res = await request(app).post('/api/game/choose')
        .set('Cookie', attaquant.cookie).send({ gameId: 'partie-qui-nexiste-pas', nodeId: nodeIdValide() });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.success, false);
});

test('choose avec un gameId non-string → 400', async () => {
    const { victime } = await contexte();
    const res = await request(app).post('/api/game/choose')
        .set('Cookie', victime.cookie).send({ gameId: 42, nodeId: nodeIdValide() });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
});

// ===========================================
// Régression : session expirée en cours de partie
// ===========================================

test('propriétaire dont l\'access token a expiré → 401 (le client peut rafraîchir et rejouer)', async () => {
    const { victime } = await contexte();
    const gameId = await nouvellePartie(victime);

    // Un access token expiré n'est pas envoyé par le navigateur (maxAge 15 min) :
    // du point de vue du serveur, la requête arrive donc sans cookie de session.
    const res = await request(app).post('/api/game/choose')
        .send({ gameId, nodeId: nodeIdValide() });

    assert.strictEqual(res.status, 401,
        '403 serait fatal : le client ne rejoue que sur 401, la partie et le jeton seraient perdus');

    // Et la reprise après refresh fonctionne : même requête, session valide.
    const reprise = await request(app).post('/api/game/choose')
        .set('Cookie', victime.cookie).send({ gameId, nodeId: nodeIdValide() });

    assert.strictEqual(reprise.status, 200, 'la partie doit reprendre normalement après refresh');
});
