const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const { generateBackupCodes, consumeBackupCode } = require('../services/twoFactor');
const { v4: uuidv4 } = require('uuid');

const userId = uuidv4();
db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
  .run(userId, 'backupuser', 'x');

test('generateBackupCodes crée 8 codes, stockés hashés', () => {
    const codes = generateBackupCodes(userId);
    assert.strictEqual(codes.length, 8);
    const rows = db.prepare('SELECT code_hash FROM a2f_backup_codes WHERE user_id = ?').all(userId);
    assert.strictEqual(rows.length, 8);
    assert.ok(!rows.some(r => codes.includes(r.code_hash)), 'jamais de code en clair en base');
});

test('un code de secours est à usage unique', () => {
    const codes = generateBackupCodes(userId);
    assert.strictEqual(consumeBackupCode(userId, codes[0]), true);
    assert.strictEqual(consumeBackupCode(userId, codes[0]), false, 'déjà consommé');
    assert.strictEqual(consumeBackupCode(userId, 'code-invalide'), false);
});

test('regénérer invalide les anciens codes', () => {
    const first = generateBackupCodes(userId);
    generateBackupCodes(userId);
    assert.strictEqual(consumeBackupCode(userId, first[1]), false);
});
