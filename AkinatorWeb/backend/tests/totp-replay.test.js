const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const speakeasy = require('speakeasy');
const { verifyTotp } = require('../services/twoFactor');
const { v4: uuidv4 } = require('uuid');

function createA2FUser() {
    const id = uuidv4();
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    db.prepare('INSERT INTO users (id, username, password_hash, a2f_enabled, a2f_secret) VALUES (?, ?, ?, 1, ?)')
      .run(id, `totp_${id.slice(0, 8)}`, 'x', secret);
    return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(id), secret };
}

test('un code TOTP valide passe, le même code rejoué est refusé', () => {
    const { user, secret } = createA2FUser();
    const code = speakeasy.totp({ secret, encoding: 'base32' });

    assert.strictEqual(verifyTotp(user, code).ok, true);

    const replayed = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const second = verifyTotp(replayed, code);
    assert.strictEqual(second.ok, false, 'anti-rejeu : code déjà consommé');
});

test('un code invalide est refusé', () => {
    const { user } = createA2FUser();
    assert.strictEqual(verifyTotp(user, '000000').ok, false);
});
