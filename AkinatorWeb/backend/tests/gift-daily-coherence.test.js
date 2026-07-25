/**
 * Cohérence du robinet quotidien de jetons.
 *
 * `POST /api/tokens/gift` et `POST /api/auth/claim-daily` partagent la même
 * colonne `last_daily_claim` : ils doivent donc se comporter comme UN SEUL
 * robinet, donner le MÊME montant (3 jetons) et tracer la MÊME transaction.
 */
const { app, db } = require('./helpers/setup');
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const PASSWORD = 'C0rrect!Horse#Battery9';
const DAILY_TOKENS = 3;

/**
 * Crée un utilisateur dédié au test et renvoie son contexte authentifié.
 * Le token CSRF est obligatoire : /api/tokens est monté derrière csrfProtection.
 */
async function newUserContext(username) {
    const register = await request(app).post('/api/auth/register')
        .send({ username, password: PASSWORD, rgpdConsent: true });
    assert.strictEqual(register.status, 201, `inscription de ${username} échouée: ${register.body.error}`);

    const login = await request(app).post('/api/auth/login')
        .send({ username, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);

    const row = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);

    return { cookie, csrfToken: csrf.body.data.csrfToken, userId: row.id };
}

function postGift(ctx, body = {}) {
    return request(app).post('/api/tokens/gift')
        .set('Cookie', ctx.cookie)
        .set('X-CSRF-Token', ctx.csrfToken)
        .send(body);
}

function postClaimDaily(ctx) {
    return request(app).post('/api/auth/claim-daily')
        .set('Cookie', ctx.cookie)
        .set('X-CSRF-Token', ctx.csrfToken)
        .send({});
}

function getTokens(userId) {
    return db.prepare('SELECT tokens FROM users WHERE id = ?').get(userId).tokens;
}

function countTransactions(userId) {
    return db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?').get(userId).n;
}

function lastTransaction(userId) {
    return db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(userId);
}

test('/gift ignore le montant demandé par le client et ne donne que 3 jetons', async () => {
    const ctx = await newUserContext('giftcoh_amount');
    const before = getTokens(ctx.userId);

    const res = await postGift(ctx, { amount: 10 });

    assert.strictEqual(res.status, 200, `attendu 200, reçu ${res.status}`);
    assert.strictEqual(res.body.data.tokensAdded, DAILY_TOKENS);
    assert.strictEqual(getTokens(ctx.userId), before + DAILY_TOKENS,
        'le solde ne doit augmenter que de 3 jetons même avec amount: 10');
    assert.strictEqual(res.body.data.newBalance, before + DAILY_TOKENS);
});

test('/gift crée une ligne transactions de 3 jetons', async () => {
    const ctx = await newUserContext('giftcoh_tx');
    const before = countTransactions(ctx.userId);

    const res = await postGift(ctx);
    assert.strictEqual(res.status, 200);

    assert.strictEqual(countTransactions(ctx.userId), before + 1,
        '/gift doit tracer le gain dans transactions comme claim-daily');

    const tx = lastTransaction(ctx.userId);
    assert.strictEqual(tx.amount, DAILY_TOKENS);
    assert.strictEqual(tx.type, 'daily', 'même type que claim-daily (robinet quotidien unique)');
    assert.strictEqual(tx.status, 'completed');
});

test('après un /gift réussi, claim-daily est refusé (même robinet)', async () => {
    const ctx = await newUserContext('giftcoh_giftdaily');

    const gift = await postGift(ctx);
    assert.strictEqual(gift.status, 200);

    const balanceAfterGift = getTokens(ctx.userId);
    const txAfterGift = countTransactions(ctx.userId);

    const daily = await postClaimDaily(ctx);
    assert.strictEqual(daily.status, 429, `claim-daily doit être refusé avec le même statut que /gift, reçu ${daily.status}`);
    assert.strictEqual(getTokens(ctx.userId), balanceAfterGift, 'aucun jeton supplémentaire');
    assert.strictEqual(countTransactions(ctx.userId), txAfterGift, 'aucune transaction supplémentaire');
});

test('claim-daily et /gift renvoient exactement la même réponse de succès', async () => {
    const viaDaily = await newUserContext('giftcoh_symdaily');
    const viaGift = await newUserContext('giftcoh_symgift');

    const daily = await postClaimDaily(viaDaily);
    const gift = await postGift(viaGift, { amount: 10 });

    assert.strictEqual(daily.status, gift.status, 'même statut HTTP');
    assert.deepStrictEqual(daily.body, gift.body,
        'même corps : un seul robinet, deux portes d\'entrée');
});

test('un second claim-daily le même jour renvoie 429, sans jeton ni transaction en plus', async () => {
    const ctx = await newUserContext('giftcoh_dailytwice');

    const first = await postClaimDaily(ctx);
    assert.strictEqual(first.status, 200);

    const balance = getTokens(ctx.userId);
    const txCount = countTransactions(ctx.userId);

    const second = await postClaimDaily(ctx);
    assert.strictEqual(second.status, 429, `attendu 429, reçu ${second.status}`);
    assert.strictEqual(getTokens(ctx.userId), balance, 'solde inchangé');
    assert.strictEqual(countTransactions(ctx.userId), txCount,
        'aucune ligne transactions ne doit être créée quand le claim est refusé');
});

test('claim-daily trace une transaction daily de 3 jetons', async () => {
    const ctx = await newUserContext('giftcoh_dailytx');
    const before = countTransactions(ctx.userId);

    const res = await postClaimDaily(ctx);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(countTransactions(ctx.userId), before + 1);

    const tx = lastTransaction(ctx.userId);
    assert.strictEqual(tx.amount, DAILY_TOKENS);
    assert.strictEqual(tx.type, 'daily');
    assert.strictEqual(tx.status, 'completed');
});

test('après un claim-daily réussi, /gift renvoie 429 (non-régression)', async () => {
    const ctx = await newUserContext('giftcoh_dailygift');

    const daily = await postClaimDaily(ctx);
    assert.strictEqual(daily.status, 200);

    const balanceAfterDaily = getTokens(ctx.userId);
    const txAfterDaily = countTransactions(ctx.userId);

    const gift = await postGift(ctx, { amount: 10 });
    assert.strictEqual(gift.status, 429, `attendu 429, reçu ${gift.status}`);
    assert.strictEqual(getTokens(ctx.userId), balanceAfterDaily, 'solde inchangé');
    assert.strictEqual(countTransactions(ctx.userId), txAfterDaily,
        'aucune transaction orpheline quand le claim est refusé');
});

test('un second /gift le même jour renvoie 429, sans jeton ni transaction en plus', async () => {
    const ctx = await newUserContext('giftcoh_twice');

    const first = await postGift(ctx);
    assert.strictEqual(first.status, 200);

    const balance = getTokens(ctx.userId);
    const txCount = countTransactions(ctx.userId);

    const second = await postGift(ctx);
    assert.strictEqual(second.status, 429, `attendu 429, reçu ${second.status}`);
    assert.strictEqual(getTokens(ctx.userId), balance, 'solde inchangé');
    assert.strictEqual(countTransactions(ctx.userId), txCount,
        'aucune ligne transactions ne doit être créée quand le /gift est refusé');
});
