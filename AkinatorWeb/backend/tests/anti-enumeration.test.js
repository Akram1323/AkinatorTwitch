const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, db } = require('./helpers/setup');

const PASSWORD = 'C0rrect!Horse#Battery9';
const USER = { username: 'enumuser', password: PASSWORD, rgpdConsent: true };

/** Inscrit un compte de test et retourne son username */
async function register(username) {
    const res = await request(app).post('/api/auth/register')
        .send({ username, password: PASSWORD, rgpdConsent: true });
    assert.strictEqual(res.status, 201, `inscription de ${username} : ${JSON.stringify(res.body)}`);
    return username;
}

/** Verrouille un compte directement en base (15 minutes, 5 échecs) */
function lockAccount(username) {
    db.prepare(`UPDATE users SET locked_until = datetime('now','+15 minutes'), failed_login_attempts = 5
        WHERE username = ?`).run(username);
}

function readLockState(username) {
    return db.prepare('SELECT locked_until, failed_login_attempts FROM users WHERE username = ?').get(username);
}

const login = (username, password) =>
    request(app).post('/api/auth/login').send({ username, password });

test('register sur un identifiant pris ne révèle pas l\'existence du compte', async () => {
    await request(app).post('/api/auth/register').send(USER);
    const res = await request(app).post('/api/auth/register').send(USER);
    assert.strictEqual(res.status, 400, 'plus de 409 révélateur');
    assert.ok(!/déjà utilisé/i.test(res.body.error), 'message générique');
    assert.strictEqual(res.body.error, 'Inscription impossible. Vérifiez vos informations et réessayez.');
});

test('login : utilisateur inconnu et mauvais mot de passe sont indistinguables', async () => {
    await register('enumlogin1');

    const inconnu = await login('enumlogin_inexistant', PASSWORD);
    const mauvaisMdp = await login('enumlogin1', 'Mauvais!MotDePasse#42');

    assert.notStrictEqual(inconnu.status, 429, 'pas de rate limit en test');
    assert.strictEqual(mauvaisMdp.status, inconnu.status, 'même code HTTP');
    assert.deepStrictEqual(mauvaisMdp.body, inconnu.body, 'même corps de réponse exactement');
    assert.strictEqual(inconnu.status, 401);
});

test('login : la réponse n\'expose ni compteur de tentatives ni verrouillage', async () => {
    await register('enumlogin2');

    // Six échecs consécutifs : même après le verrouillage (5e), la réponse reste générique
    for (let i = 0; i < 6; i++) {
        const res = await login('enumlogin2', 'Mauvais!MotDePasse#42');
        assert.strictEqual(res.status, 401, `échec n°${i + 1} : 401 générique`);
        assert.strictEqual(res.body.error, 'Identifiants incorrects');
        const corps = JSON.stringify(res.body);
        assert.ok(!/tentative/i.test(corps), 'aucune mention de "tentative"');
        assert.ok(!/restante/i.test(corps), 'aucune mention de "restante"');
        assert.ok(!/verrouill/i.test(corps), 'aucune mention de "verrouillé"');
    }
});

test('login : les bons identifiants fonctionnent toujours (non-régression)', async () => {
    await register('enumlogin3');

    const res = await login('enumlogin3', PASSWORD);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    const cookies = (res.headers['set-cookie'] || []).join(' ');
    assert.match(cookies, /access_token=/);
    assert.match(cookies, /refresh_token=/);
});

test('login : compte verrouillé + bon mot de passe → 423 et le verrou est conservé', async () => {
    await register('enumlogin4');
    lockAccount('enumlogin4');
    const avant = readLockState('enumlogin4');

    const res = await login('enumlogin4', PASSWORD);
    assert.strictEqual(res.status, 423);
    assert.match(res.body.error, /verrouill/i, 'le propriétaire légitime est informé du verrou');
    assert.ok(!(res.headers['set-cookie'] || []).join(' ').includes('access_token='),
        'aucun jeton émis sur un refus');

    const apres = readLockState('enumlogin4');
    assert.strictEqual(apres.locked_until, avant.locked_until, 'locked_until non effacé');
    assert.strictEqual(apres.failed_login_attempts, 5, 'failed_login_attempts non remis à 0');
});

test('login : compte verrouillé + mauvais mot de passe → 401 générique identique', async () => {
    await register('enumlogin5');
    lockAccount('enumlogin5');

    const res = await login('enumlogin5', 'Mauvais!MotDePasse#42');
    const inconnu = await login('enumlogin_inexistant2', PASSWORD);

    assert.strictEqual(res.status, inconnu.status, 'même code HTTP qu\'un utilisateur inconnu');
    assert.deepStrictEqual(res.body, inconnu.body, 'même corps qu\'un utilisateur inconnu');
    assert.strictEqual(res.status, 401);
});

// ===========================================
// Verrouillage de compte : pose et bornes
// ===========================================

test('verrouillage : 5 échecs posent réellement le verrou (bout en bout, via HTTP)', async () => {
    // Ce scénario n'était couvert par AUCUN test : les autres écrivent locked_until
    // directement en base et ne valident donc que sa LECTURE. Or le verrou n'était
    // jamais actif en pratique (horodatage SQLite UTC lu en heure locale).
    await register('lockpose');

    const etatInitial = readLockState('lockpose');
    assert.strictEqual(etatInitial.locked_until, null, 'compte neuf : aucun verrou');

    for (let i = 0; i < 5; i++) {
        await login('lockpose', 'Mauvais!MotDePasse#42');
    }

    const apres = readLockState('lockpose');
    assert.strictEqual(apres.failed_login_attempts, 5, '5 tentatives comptabilisées');
    assert.notStrictEqual(apres.locked_until, null, 'le verrou doit être posé en base');

    // Le verrou est-il RÉELLEMENT appliqué ? Seul le bon mot de passe le révèle.
    const avecBonMotDePasse = await login('lockpose', PASSWORD);
    assert.strictEqual(avecBonMotDePasse.status, 423,
        'après 5 échecs, même le bon mot de passe est refusé pendant 15 minutes');
    assert.ok(!(avecBonMotDePasse.headers['set-cookie'] || []).join(' ').includes('access_token='),
        'aucune session ouverte sur un compte verrouillé');
});

test('verrouillage : une tentative supplémentaire ne prolonge PAS un verrou actif', async () => {
    // Sans cette borne, connaître un simple pseudo suffirait à maintenir un compte
    // fermé indéfiniment (une requête toutes les 15 minutes) : déni de service ciblé.
    await register('lockprolong');

    for (let i = 0; i < 5; i++) {
        await login('lockprolong', 'Mauvais!MotDePasse#42');
    }

    const apresVerrou = readLockState('lockprolong');
    assert.notStrictEqual(apresVerrou.locked_until, null, 'verrou posé');

    // Trois tentatives de plus, comme le ferait un attaquant qui veut garder le compte fermé
    for (let i = 0; i < 3; i++) {
        await login('lockprolong', 'Mauvais!MotDePasse#42');
    }

    const apresHarcelement = readLockState('lockprolong');
    assert.strictEqual(apresHarcelement.locked_until, apresVerrou.locked_until,
        'l\'échéance du verrou ne doit pas être repoussée par de nouvelles tentatives');
    assert.strictEqual(apresHarcelement.failed_login_attempts, 8,
        'les tentatives restent comptées (signal d\'audit), seule l\'échéance est figée');
});

test('verrouillage : un horodatage illisible verrouille (fail-closed) au lieu d\'ouvrir', async () => {
    await register('lockcorrompu');
    db.prepare('UPDATE users SET locked_until = ? WHERE username = ?')
        .run('horodatage-corrompu', 'lockcorrompu');

    const res = await login('lockcorrompu', PASSWORD);
    assert.strictEqual(res.status, 423,
        'une valeur illisible ne doit jamais être interprétée comme "pas de verrou"');
});
