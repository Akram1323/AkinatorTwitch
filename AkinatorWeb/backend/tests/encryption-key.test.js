const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
require('./helpers/setup');
const { encryptIP, decryptIP } = require('../services/encryption');

test('chiffrement/déchiffrement avec une ENCRYPTION_KEY hex de 64 caractères', () => {
    const encrypted = encryptIP('192.168.1.42');
    assert.ok(encrypted, 'le chiffrement doit réussir avec une clé hex');
    assert.strictEqual(decryptIP(encrypted), '192.168.1.42');
});
