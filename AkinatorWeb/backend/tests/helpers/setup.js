/**
 * Bootstrap des tests : environnement isolé + base temporaire.
 * À require AVANT tout module applicatif (fige les variables d'env).
 */
const path = require('path');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secret-de-test-0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `akinator-test-${process.pid}-${Date.now()}.db`);

const { app } = require('../../server');
const { db, initializeTables } = require('../../services/database');

initializeTables();

module.exports = { app, db };
