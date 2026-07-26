/**
 * Service de base de données SQLite
 * Gestion SÉCURISÉE des données utilisateurs, jetons et jeux
 * 
 * SÉCURITÉ CYBERSÉCURITÉ:
 * - Mots de passe hashés avec bcrypt (12+ rounds)
 * - Prepared statements pour prévenir les injections SQL
 * - Données sensibles jamais en clair
 * - Audit trail avec timestamps
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');

// Créer le dossier data si nécessaire
const dbDir = path.dirname(config.database.path);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Connexion à la base de données
const db = new Database(config.database.path, {
    verbose: config.isDev ? console.log : null
});

// Configuration sécurisée SQLite
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('secure_delete = ON');

// Object pour stocker les requêtes
const queries = {
    users: null,
    transactions: null,
    tokenRequests: null,
    games: null,
    tree: null,
    cache: null
};

/**
 * Initialisation des tables avec schéma sécurisé
 */
function initializeTables() {
    // Table des utilisateurs - SÉCURISÉE
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            wallet_address TEXT,
            tokens INTEGER DEFAULT 3 CHECK(tokens >= 0),
            total_games INTEGER DEFAULT 0,
            last_daily_claim DATE,
            failed_login_attempts INTEGER DEFAULT 0,
            locked_until DATETIME,
            a2f_enabled INTEGER DEFAULT 0,
            a2f_secret TEXT,
            avatar_url TEXT,
            is_admin INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME,
            ip_address TEXT
        )
    `);
    
    // Migration: ajouter colonnes si elles n'existent pas
    try {
        db.exec('ALTER TABLE users ADD COLUMN a2f_enabled INTEGER DEFAULT 0');
    } catch (e) { /* Colonne existe déjà */ }
    try {
        db.exec('ALTER TABLE users ADD COLUMN a2f_secret TEXT');
    } catch (e) { /* Colonne existe déjà */ }
    try {
        db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
    } catch (e) { /* Colonne existe déjà */ }
    try {
        db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
    } catch (e) { /* Colonne existe déjà */ }
    try {
        db.exec('ALTER TABLE users ADD COLUMN a2f_last_step INTEGER');
    } catch (e) { /* Colonne existe déjà */ }
    try {
        db.exec('ALTER TABLE users ADD COLUMN password_changed_at INTEGER');
    } catch (e) { /* Colonne existe déjà */ }

    // Table des transactions
    db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('purchase', 'gift', 'daily', 'game', 'admin_grant')),
            amount INTEGER NOT NULL,
            tx_hash TEXT,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // Migration : le CHECK de transactions.type n'inclut pas 'admin_grant' sur
    // les bases existantes et SQLite ne modifie pas un CHECK — rebuild de la table.
    const txTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get();
    if (txTable && !txTable.sql.includes('admin_grant')) {
        db.exec(`
            DROP TABLE IF EXISTS transactions_new;
            BEGIN;
            CREATE TABLE transactions_new (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('purchase', 'gift', 'daily', 'game', 'admin_grant')),
                amount INTEGER NOT NULL,
                tx_hash TEXT,
                status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            INSERT INTO transactions_new SELECT * FROM transactions;
            DROP TABLE transactions;
            ALTER TABLE transactions_new RENAME TO transactions;
            COMMIT;
        `);
    }

    // Demandes de jetons adressées aux administrateurs.
    // `resolved_by` est ON DELETE SET NULL : la suppression d'un compte admin ne
    // doit pas effacer l'historique des décisions (contrairement au demandeur,
    // dont les données partent en CASCADE au titre du RGPD).
    db.exec(`
        CREATE TABLE IF NOT EXISTS token_requests (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK(amount > 0),
            reason TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            resolved_at DATETIME,
            resolved_by TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
        )
    `);
    // Une seule demande en attente par utilisateur : la contrainte est posée par la
    // base (index unique partiel) et non par un contrôle applicatif, pour qu'aucune
    // course entre deux requêtes simultanées ne puisse en créer deux.
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_token_requests_une_en_attente
        ON token_requests(user_id) WHERE status = 'pending'
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_token_requests_status ON token_requests(status)`);

    // Table des parties
    db.exec(`
        CREATE TABLE IF NOT EXISTS games (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            filters_used TEXT,
            games_recommended TEXT,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        )
    `);

    // Table de l'arbre de décision
    db.exec(`
        CREATE TABLE IF NOT EXISTS decision_tree (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question_text TEXT NOT NULL,
            slug_igdb TEXT,
            parent_id INTEGER DEFAULT 0,
            depth INTEGER DEFAULT 0,
            filter_type TEXT
        )
    `);

    // Table cache IGDB
    db.exec(`
        CREATE TABLE IF NOT EXISTS igdb_cache (
            cache_key TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME
        )
    `);

    // Table des sessions (pour audit)
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            ip_address TEXT,
            user_agent TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // Jetons de rafraîchissement (rotation + détection de réutilisation)
    db.exec(`
        CREATE TABLE IF NOT EXISTS refresh_tokens (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            family_id TEXT NOT NULL,
            token_hash TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            used_at DATETIME,
            revoked INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // Blacklist persistante des access tokens révoqués (par jti)
    db.exec(`
        CREATE TABLE IF NOT EXISTS revoked_tokens (
            jti TEXT PRIMARY KEY,
            expires_at DATETIME NOT NULL
        )
    `);

    // Codes de secours 2FA (hashés, usage unique)
    db.exec(`
        CREATE TABLE IF NOT EXISTS a2f_backup_codes (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            used_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_user ON a2f_backup_codes(user_id)`);

    // Tokens CSRF persistants (survivent au redémarrage)
    db.exec(`
        CREATE TABLE IF NOT EXISTS csrf_tokens (
            user_id TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            PRIMARY KEY (user_id, token_hash)
        )
    `);

    // Journal d'audit inviolable (append-only, chaînage de hash)
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            user_id TEXT,
            ip_hash TEXT,
            details TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            prev_hash TEXT NOT NULL,
            hash TEXT NOT NULL
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_type)`);

    // Index pour optimisation et sécurité
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
        CREATE INDEX IF NOT EXISTS idx_games_user ON games(user_id);
        CREATE INDEX IF NOT EXISTS idx_tree_parent ON decision_tree(parent_id);
        CREATE INDEX IF NOT EXISTS idx_cache_expires ON igdb_cache(expires_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
    `);

    console.log('✅ Tables de base de données initialisées (schéma sécurisé)');
    
    // Initialiser les requêtes juste après les tables
    initializeQueries();
}

function initializeQueries() {
    // REQUÊTES UTILISATEURS
    queries.users = {
        create: db.prepare(`
            INSERT INTO users (id, username, password_hash, tokens, ip_address)
            VALUES (?, ?, ?, ?, ?)
        `),
        findById: db.prepare('SELECT * FROM users WHERE id = ?'),
        findByUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
        updateTokens: db.prepare('UPDATE users SET tokens = tokens + ? WHERE id = ?'),
        setTokens: db.prepare('UPDATE users SET tokens = ? WHERE id = ?'),
        updateLastLogin: db.prepare(`
            UPDATE users SET
                last_login = CURRENT_TIMESTAMP,
                failed_login_attempts = 0,
                locked_until = NULL,
                ip_address = ?
            WHERE id = ?
        `),
        incrementGames: db.prepare('UPDATE users SET total_games = total_games + 1 WHERE id = ?'),
        // Verrou posé à partir de la 5e tentative échouée, pour 15 minutes.
        // La condition `locked_until IS NULL OR locked_until <= datetime('now')`
        // est essentielle : sans elle, chaque tentative sur un compte DÉJÀ verrouillé
        // repousserait l'échéance, et connaître un simple pseudo suffirait à garder
        // un compte fermé indéfiniment (déni de service ciblé).
        incrementFailedLogin: db.prepare(`
            UPDATE users SET
                failed_login_attempts = failed_login_attempts + 1,
                locked_until = CASE
                    WHEN failed_login_attempts >= 4
                         AND (locked_until IS NULL OR locked_until <= datetime('now'))
                    THEN datetime('now', '+15 minutes')
                    ELSE locked_until
                END
            WHERE id = ?
        `),
        resetFailedLogin: db.prepare(`
            UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?
        `),
        getLastDailyClaim: db.prepare('SELECT last_daily_claim FROM users WHERE id = ?'),
        canClaimDaily: db.prepare(`
            SELECT CASE 
                WHEN last_daily_claim IS NULL THEN 1
                WHEN last_daily_claim < date('now') THEN 1
                ELSE 0
            END as can_claim
            FROM users WHERE id = ?
        `),
        // Robinet quotidien : vérifie ET met à jour en une seule requête conditionnelle.
        // Seule voie d'écriture de `last_daily_claim` (cf. services/dailyTokens.js) —
        // aucune fenêtre entre le contrôle et l'écriture, donc pas de double claim.
        claimDailyAtomic: db.prepare(`
            UPDATE users 
            SET last_daily_claim = date('now'), tokens = tokens + ? 
            WHERE id = ? AND (last_daily_claim IS NULL OR last_daily_claim < date('now'))
        `),
        getLeaderboard: db.prepare(`
            SELECT username, total_games, created_at 
            FROM users 
            ORDER BY total_games DESC 
            LIMIT 10
        `),
        findAll: db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?'),
        count: db.prepare('SELECT COUNT(*) as count FROM users'),
        delete: db.prepare('DELETE FROM users WHERE id = ?')
    };

    // REQUÊTES TRANSACTIONS
    queries.transactions = {
        create: db.prepare(`
            INSERT INTO transactions (id, user_id, type, amount, tx_hash, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `),
        findByUser: db.prepare(`
            SELECT * FROM transactions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 50
        `)
    };

    // REQUÊTES DEMANDES DE JETONS
    queries.tokenRequests = {
        create: db.prepare(`
            INSERT INTO token_requests (id, user_id, amount, reason)
            VALUES (?, ?, ?, ?)
        `),
        findById: db.prepare('SELECT * FROM token_requests WHERE id = ?'),
        findByUser: db.prepare(`
            SELECT * FROM token_requests
            WHERE user_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 20
        `),
        // Jointure sur users pour éviter un N+1 côté panneau admin.
        findByStatus: db.prepare(`
            SELECT tr.*, u.username, u.tokens AS user_tokens
            FROM token_requests tr
            JOIN users u ON u.id = tr.user_id
            WHERE tr.status = ?
            ORDER BY tr.created_at ASC, tr.rowid ASC
            LIMIT ?
        `),
        // Résolution conditionnelle : le `WHERE status = 'pending'` rend l'opération
        // idempotente. Deux admins qui cliquent en même temps ne peuvent pas créditer
        // deux fois — le second UPDATE renvoie changes = 0.
        resolve: db.prepare(`
            UPDATE token_requests
            SET status = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
            WHERE id = ? AND status = 'pending'
        `)
    };

    // REQUÊTES PARTIES
    queries.games = {
        create: db.prepare(`
            INSERT INTO games (id, user_id, filters_used)
            VALUES (?, ?, ?)
        `),
        findById: db.prepare('SELECT * FROM games WHERE id = ?'),
        complete: db.prepare(`
            UPDATE games 
            SET completed_at = CURRENT_TIMESTAMP, games_recommended = ?
            WHERE id = ?
        `),
        findByUser: db.prepare(`
            SELECT * FROM games 
            WHERE user_id = ? 
            ORDER BY started_at DESC 
            LIMIT 20
        `)
    };

    // REQUÊTES ARBRE DE DÉCISION
    queries.tree = {
        getRoot: db.prepare('SELECT * FROM decision_tree WHERE parent_id = 0'),
        getChildren: db.prepare('SELECT * FROM decision_tree WHERE parent_id = ?'),
        getById: db.prepare('SELECT * FROM decision_tree WHERE id = ?'),
        getAll: db.prepare('SELECT * FROM decision_tree ORDER BY id'),
        insert: db.prepare(`
            INSERT INTO decision_tree (question_text, slug_igdb, parent_id, depth, filter_type)
            VALUES (?, ?, ?, ?, ?)
        `),
        clear: db.prepare('DELETE FROM decision_tree'),
        count: db.prepare('SELECT COUNT(*) as count FROM decision_tree')
    };

    // REQUÊTES CACHE
    queries.cache = {
        get: db.prepare(`
            SELECT data FROM igdb_cache 
            WHERE cache_key = ? AND expires_at > datetime('now')
        `),
        // 3e paramètre obligatoire : modificateur SQLite datetime (ex. "+7 days", "+1 hour").
        set: db.prepare(`
            INSERT OR REPLACE INTO igdb_cache (cache_key, data, expires_at)
            VALUES (?, ?, datetime('now', ?))
        `),
        cleanup: db.prepare(`DELETE FROM igdb_cache WHERE expires_at < datetime('now')`)
    };
    
    console.log('✅ Requêtes préparées');
}

// Exporter l'objet queries directement
module.exports = {
    db,
    initializeTables,
    queries
};
