/**
 * Désactivation de la 2FA.
 * Le code de secours doit être accepté au même titre que le TOTP : sans cela, un
 * utilisateur ayant perdu son téléphone peut se connecter (le login les accepte)
 * mais reste bloqué avec une 2FA qu'il ne peut plus désactiver.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const speakeasy = require('speakeasy');
const { app, db } = require('./helpers/setup');

const PASSWORD = 'C0rrect!Horse#Battery9';

async function contexteAuthentifie(username) {
    await request(app).post('/api/auth/register').send({ username, password: PASSWORD, rgpdConsent: true });
    const login = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    const userId = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username).id;
    return { cookie, csrfToken: csrf.body.data.csrfToken, userId };
}

/** Active (ou réactive) la 2FA pour un contexte donné. */
async function activerA2FPour(ctx) {
    const setup = await request(app).post('/api/a2f/setup')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({});
    assert.strictEqual(setup.status, 200, 'setup 2FA échoué');
    const secret = setup.body.data.secret;

    const verify = await request(app).post('/api/a2f/verify-setup')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken)
        .send({ code: speakeasy.totp({ secret, encoding: 'base32' }) });
    assert.strictEqual(verify.status, 200, 'activation 2FA échouée');

    return { secret, codes: verify.body.data.codes };
}

/** Crée un compte et active sa 2FA. Renvoie { ctx, secret, codes }. */
async function activerA2F(username) {
    const ctx = await contexteAuthentifie(username);
    const { secret, codes } = await activerA2FPour(ctx);
    return { ctx, secret, codes };
}

function disable(ctx, body) {
    return request(app).post('/api/a2f/disable')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send(body);
}

test('un code de secours désactive la 2FA', async () => {
    const { ctx, codes } = await activerA2F('a2fdis1');

    const res = await disable(ctx, { password: PASSWORD, code: codes[0] });

    assert.strictEqual(res.status, 200, `attendu 200, reçu ${res.status} (${res.body.error})`);
    const user = db.prepare('SELECT a2f_enabled, a2f_secret FROM users WHERE id = ?').get(ctx.userId);
    assert.strictEqual(user.a2f_enabled, 0);
    assert.strictEqual(user.a2f_secret, null, 'le secret doit être effacé');
});

test('un code TOTP désactive toujours la 2FA (non-régression)', async () => {
    const { ctx, secret } = await activerA2F('a2fdis2');

    // Code du pas suivant : l'activation vient de consommer le pas courant (anti-rejeu)
    const futur = speakeasy.totp({
        secret, encoding: 'base32', time: (Date.now() / 1000) + 30
    });
    const res = await disable(ctx, { password: PASSWORD, code: futur });

    assert.strictEqual(res.status, 200, `attendu 200, reçu ${res.status} (${res.body.error})`);
    assert.strictEqual(
        db.prepare('SELECT a2f_enabled FROM users WHERE id = ?').get(ctx.userId).a2f_enabled, 0);
});

test('un ancien code de secours ne repasse pas après réactivation', async () => {
    const { ctx, codes } = await activerA2F('a2fdis3');
    const ancienCode = codes[0];

    const premier = await disable(ctx, { password: PASSWORD, code: ancienCode });
    assert.strictEqual(premier.status, 200);

    // Réactivation : de NOUVEAUX codes sont émis, les anciens sont purgés.
    // Attention : sans cette réactivation, /disable serait un no-op renvoyant 200
    // (le second facteur n'est exigé que si la 2FA est active), et le test ne
    // vérifierait rien du tout.
    await activerA2FPour(ctx);

    const rejeu = await disable(ctx, { password: PASSWORD, code: ancienCode });
    assert.strictEqual(rejeu.status, 401, 'un code d\'une génération précédente doit être refusé');
    assert.strictEqual(
        db.prepare('SELECT a2f_enabled FROM users WHERE id = ?').get(ctx.userId).a2f_enabled, 1,
        'la 2FA doit rester active après un code refusé');
});

test('mot de passe incorrect refusé même avec un code valide', async () => {
    const { ctx, codes } = await activerA2F('a2fdis4');

    const res = await disable(ctx, { password: 'Mauvais!MotDePasse#42', code: codes[0] });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(
        db.prepare('SELECT a2f_enabled FROM users WHERE id = ?').get(ctx.userId).a2f_enabled, 1,
        'la 2FA doit rester active');
});

test('un mauvais mot de passe ne consomme pas le code de secours fourni avec', async () => {
    const { ctx, codes } = await activerA2F('a2fdis9');

    const refus = await disable(ctx, { password: 'Mauvais!MotDePasse#42', code: codes[0] });
    assert.strictEqual(refus.status, 401);

    // Sans cette assertion, une inversion future de l'ordre des contrôles (facteur 2
    // avant facteur 1) brûlerait le code de secours à chaque simple faute de frappe
    // sur le mot de passe, sans que la suite verte ne le remarque. On rejoue avec le
    // bon mot de passe : le code doit toujours être utilisable.
    const rejeu = await disable(ctx, { password: PASSWORD, code: codes[0] });
    assert.strictEqual(rejeu.status, 200,
        `le code de secours doit rester utilisable après un refus par mot de passe, reçu ${rejeu.status} (${rejeu.body.error})`);
});

test('bon mot de passe, aucun second facteur fourni → refusé (verrouille la garde actuelle)', async () => {
    const { ctx } = await activerA2F('a2fdis7');

    const res = await disable(ctx, { password: PASSWORD });

    assert.strictEqual(res.status, 401,
        `attendu 401 (aucun code fourni ne doit jamais suffire), reçu ${res.status}`);
    assert.strictEqual(
        db.prepare('SELECT a2f_enabled FROM users WHERE id = ?').get(ctx.userId).a2f_enabled, 1,
        'la 2FA doit rester active');
});

test('code de secours à 10 caractères non hexadécimaux refusé', async () => {
    const { ctx } = await activerA2F('a2fdis8');

    const res = await disable(ctx, { password: PASSWORD, code: 'zzzzzzzzzz' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(
        db.prepare('SELECT a2f_enabled FROM users WHERE id = ?').get(ctx.userId).a2f_enabled, 1,
        'la 2FA doit rester active');
});

test('mot de passe absent → 400, jamais 500', async () => {
    const { ctx, codes } = await activerA2F('a2fdis5');

    const res = await disable(ctx, { code: codes[0] });

    assert.strictEqual(res.status, 400,
        'bcrypt.compare(undefined, hash) lève : ce chemin doit être gardé en amont');
});

test('désactiver purge les codes de secours restants', async () => {
    const { ctx, codes } = await activerA2F('a2fdis6');

    await disable(ctx, { password: PASSWORD, code: codes[0] });

    const restants = db.prepare(
        'SELECT COUNT(*) AS n FROM a2f_backup_codes WHERE user_id = ?'
    ).get(ctx.userId).n;
    assert.strictEqual(restants, 0, 'aucun code ne doit survivre à la désactivation');
});
