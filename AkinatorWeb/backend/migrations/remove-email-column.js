/**
 * Migration : Suppression de la colonne email
 * SQLite ne supporte pas DROP COLUMN directement,
 * donc on recrée la table sans la colonne email
 */

const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/config');

const dbPath = config.database.path;
console.log('📂 Migration : Suppression de la colonne email');
console.log('📂 Base de données:', dbPath);

const db = new Database(dbPath);

try {
    // Vérifier si la colonne email existe
    const columns = db.prepare("PRAGMA table_info(users)").all();
    const hasEmailColumn = columns.some(col => col.name === 'email');
    
    if (!hasEmailColumn) {
        console.log('✅ La colonne email n\'existe pas, migration non nécessaire');
        db.close();
        process.exit(0);
    }
    
    console.log('⚠️ Colonne email trouvée, migration en cours...');
    
    // Désactiver les foreign keys temporairement
    db.pragma('foreign_keys = OFF');
    
    // Créer une nouvelle table sans la colonne email
    db.exec(`
        CREATE TABLE IF NOT EXISTS users_new (
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME,
            ip_address TEXT
        )
    `);
    
    // Copier les données (sans la colonne email)
    db.exec(`
        INSERT INTO users_new (
            id, username, password_hash, wallet_address, tokens, total_games,
            last_daily_claim, failed_login_attempts, locked_until,
            a2f_enabled, a2f_secret, avatar_url,
            created_at, last_login, ip_address
        )
        SELECT 
            id, username, password_hash, wallet_address, tokens, total_games,
            last_daily_claim, failed_login_attempts, locked_until,
            a2f_enabled, a2f_secret, avatar_url,
            created_at, last_login, ip_address
        FROM users
    `);
    
    // Supprimer l'ancienne table
    db.exec('DROP TABLE users');
    
    // Renommer la nouvelle table
    db.exec('ALTER TABLE users_new RENAME TO users');
    
    // Recréer les index
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
    
    // Réactiver les foreign keys
    db.pragma('foreign_keys = ON');
    
    console.log('✅ Migration terminée avec succès !');
    console.log('✅ La colonne email a été supprimée');
    
} catch (error) {
    console.error('❌ Erreur lors de la migration:', error.message);
    db.pragma('foreign_keys = ON');
    process.exit(1);
}

db.close();
