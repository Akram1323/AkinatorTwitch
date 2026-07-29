/**
 * Test de la migration de la table transactions (ancien schéma sans 'admin_grant').
 *
 * Le module services/database est un singleton (la connexion et les CREATE TABLE
 * s'exécutent au chargement). Pour tester la branche de migration sur une base
 * pointant vers un ANCIEN schéma sans réutiliser la base des autres tests, le
 * scénario est exécuté dans un sous-processus Node dédié : la base temporaire est
 * d'abord construite avec l'ancien schéma via better-sqlite3, puis un script isolé
 * charge services/database avec DATABASE_PATH pointé dessus et appelle
 * initializeTables().
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

test("migration transactions : ancien schéma (CHECK sans 'admin_grant') migré de façon atomique", () => {
    const dbPath = path.join(os.tmpdir(), `akinator-migration-test-${process.pid}-${Date.now()}.db`);

    // 1. Construire une base au VIEUX schéma, SANS contrainte FK active, avec une
    //    ligne historique de transaction.
    const oldDb = new Database(dbPath);
    oldDb.pragma('foreign_keys = OFF');
    // Table users au schéma complet requis par services/database (CREATE TABLE
    // IF NOT EXISTS ne la recrée pas si elle existe déjà, et initializeQueries()
    // prépare toutes les requêtes users au chargement, colonnes incluses).
    oldDb.exec(`
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            wallet_address TEXT,
            tokens INTEGER DEFAULT 3 CHECK(tokens >= 0),
            total_games INTEGER DEFAULT 0,
            last_daily_claim DATE,
            failed_login_attempts INTEGER DEFAULT 0,
            locked_until DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME,
            ip_address TEXT
        )
    `);
    // Index sur la colonne morte : sans un DROP INDEX préalable, SQLite refuse le
    // DROP COLUMN. Le poser ici garantit que la migration teste bien cet ordre.
    oldDb.exec('CREATE INDEX idx_users_wallet ON users(wallet_address)');
    oldDb.exec(`
        CREATE TABLE transactions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('purchase', 'gift', 'daily', 'game')),
            amount INTEGER NOT NULL,
            tx_hash TEXT,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    // La ligne historique référence u1 : on crée aussi l'utilisateur pour que la
    // future re-création de la table (FK active dans services/database) n'échoue pas.
    oldDb.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run('u1', 'u1', 'x');
    oldDb.prepare(`
        INSERT INTO transactions (id, user_id, type, amount, tx_hash, status)
        VALUES ('t1', 'u1', 'purchase', 5, NULL, 'completed')
    `).run();
    oldDb.close();

    // 2. Dans un sous-processus frais : pointer DATABASE_PATH sur cette base AVANT
    //    le premier require de services/database, puis appeler initializeTables()
    //    et vérifier qu'un INSERT 'admin_grant' passe désormais.
    const databaseModulePath = path.join(__dirname, '..', 'services', 'database.js');
    const script = `
        process.env.DATABASE_PATH = ${JSON.stringify(dbPath)};
        const { initializeTables, queries } = require(${JSON.stringify(databaseModulePath)});
        initializeTables();
        const { v4: uuidv4 } = require('uuid');
        queries.transactions.create.run(uuidv4(), 'u1', 'admin_grant', 7, 'completed');
        console.log('MIGRATION_OK');
    `;

    const output = execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        cwd: path.join(__dirname, '..')
    });
    assert.match(output, /MIGRATION_OK/, 'le sous-processus doit migrer la table puis insérer un admin_grant sans erreur');

    // 3. Vérifier l'état final de la base : ligne historique préservée, admin_grant inséré
    const checkDb = new Database(dbPath, { readonly: true });
    try {
        const historic = checkDb.prepare("SELECT * FROM transactions WHERE id = 't1'").get();
        assert.ok(historic, 'la ligne historique doit être préservée après migration');
        assert.strictEqual(historic.user_id, 'u1');
        assert.strictEqual(historic.type, 'purchase');
        assert.strictEqual(historic.amount, 5);
        assert.strictEqual(historic.status, 'completed');

        const grant = checkDb.prepare("SELECT * FROM transactions WHERE type = 'admin_grant'").get();
        assert.ok(grant, "un INSERT de type 'admin_grant' doit être accepté après migration");
        assert.strictEqual(grant.amount, 7);
        assert.strictEqual(grant.status, 'completed');

        // La table temporaire de migration ne doit pas subsister
        const orphan = checkDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions_new'").get();
        assert.strictEqual(orphan, undefined, 'transactions_new ne doit pas subsister après un rebuild réussi');

        // Vestiges du paiement crypto : la migration doit les avoir retirés
        const colonnesTx = checkDb.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
        assert.ok(!colonnesTx.includes('tx_hash'), 'la colonne tx_hash doit avoir disparu de transactions');

        const colonnesUsers = checkDb.prepare('PRAGMA table_info(users)').all().map(c => c.name);
        assert.ok(!colonnesUsers.includes('wallet_address'), 'la colonne wallet_address doit avoir disparu de users');

        const indexWallet = checkDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_wallet'").get();
        assert.strictEqual(indexWallet, undefined, "l'index idx_users_wallet doit avoir disparu");
    } finally {
        checkDb.close();
    }

    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { fs.unlinkSync(dbPath + suffix); } catch (e) { /* fichier absent */ }
    }
});
