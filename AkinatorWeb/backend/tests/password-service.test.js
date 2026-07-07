const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers/setup');
const { validateNewPassword, isPwnedPassword } = require('../services/passwordService');
const crypto = require('crypto');

test('refuse un mot de passe faible (zxcvbn < 3)', async () => {
    const result = await validateNewPassword('Azerty123!', 'alice');
    assert.strictEqual(result.ok, false);
});

test('accepte un mot de passe fort non compromis', async () => {
    const fetchStub = async () => ({ ok: true, text: async () => 'AAAAA:1\r\nBBBBB:2' });
    const pwned = await isPwnedPassword('C0rrect!Horse#Battery9', fetchStub);
    assert.strictEqual(pwned, false);
});

test('détecte un mot de passe présent dans une fuite (k-anonymity)', async () => {
    const password = 'password123';
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const fetchStub = async (url) => {
        assert.ok(url.endsWith(sha1.slice(0, 5)), 'seuls 5 caractères du hash sont envoyés');
        return { ok: true, text: async () => `${sha1.slice(5)}:52579` };
    };
    assert.strictEqual(await isPwnedPassword(password, fetchStub), true);
});

test('fail-open si l\'API HIBP est injoignable', async () => {
    const fetchStub = async () => { throw new Error('network down'); };
    assert.strictEqual(await isPwnedPassword('whatever-Pass-99!', fetchStub), false);
});
