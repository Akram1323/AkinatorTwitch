const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('./helpers/setup');

/**
 * Inscrit un VRAI utilisateur puis fabrique un token temporaire `pending2FA`
 * à son nom. Utiliser un id réel (au lieu d'un id fantaisiste) est essentiel :
 * sinon le garde-fou « compte introuvable → 401 » ajouté dans
 * `authenticateToken` renvoie déjà 401, et le test ne prouverait plus rien
 * sur le garde-fou `pending2FA` lui-même.
 */
async function craftPendingTokenForRealUser() {
    // Suffixe aléatoire : cette fonction est appelée une fois par test, un
    // même nom d'utilisateur en base ferait échouer la seconde inscription
    // (compte déjà pris) et fausserait la preuve de discrimination du test.
    const username = `pending2fauser${crypto.randomBytes(3).toString('hex')}`;
    const password = 'C0rrect!Horse#Battery9';

    const registerRes = await request(app).post('/api/auth/register').send({
        username,
        password,
        rgpdConsent: true
    });
    const userId = registerRes.body.data.user.id;

    // jti aléatoire : garantit que le token n'est pas rejeté par le
    // garde-fou de révocation (jti inconnu ≠ révoqué). password_changed_at
    // est NULL pour un utilisateur fraîchement créé, donc le garde-fou iat
    // ne se déclenche pas non plus : seul le garde-fou pending2FA doit agir.
    return jwt.sign(
        { id: userId, username, pending2FA: true, jti: crypto.randomUUID() },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
    );
}

test('un token pending2FA est refusé par une route protégée (via cookie)', async () => {
    const temp = await craftPendingTokenForRealUser();
    const res = await request(app).get('/api/auth/me')
        .set('Cookie', `access_token=${temp}`);
    assert.strictEqual(res.status, 401, 'le token 2FA temporaire ne doit pas authentifier');
});

test('un token pending2FA est refusé par une route protégée (via Authorization)', async () => {
    const temp = await craftPendingTokenForRealUser();
    const res = await request(app).get('/api/auth/me')
        .set('Authorization', `Bearer ${temp}`);
    assert.strictEqual(res.status, 401, 'le token 2FA temporaire ne doit pas authentifier');
});
