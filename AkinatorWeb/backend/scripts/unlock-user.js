/**
 * Script : Déverrouiller un utilisateur (réinitialiser les tentatives de connexion)
 * Usage: node scripts/unlock-user.js <username>
 */

const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/config');

const username = process.argv[2] || 'Akinator';

const dbPath = config.database.path;
console.log('🔓 Déverrouillage du compte');
console.log('📂 Base de données:', dbPath);
console.log('👤 Utilisateur:', username);
console.log('');

const db = new Database(dbPath);

try {
    // Trouver l'utilisateur
    const user = db.prepare('SELECT id, username, failed_login_attempts, locked_until FROM users WHERE username = ? COLLATE NOCASE').get(username);
    
    if (!user) {
        console.error(`❌ Utilisateur "${username}" introuvable`);
        process.exit(1);
    }
    
    console.log(`📋 État actuel:`);
    console.log(`   Tentatives échouées: ${user.failed_login_attempts || 0}`);
    console.log(`   Verrouillé jusqu'à: ${user.locked_until || '(non verrouillé)'}`);
    console.log('');
    
    // Réinitialiser les tentatives et déverrouiller
    db.prepare(`
        UPDATE users 
        SET failed_login_attempts = 0, 
            locked_until = NULL 
        WHERE id = ?
    `).run(user.id);
    
    console.log('✅ Compte déverrouillé avec succès !');
    console.log(`   Username: ${user.username}`);
    console.log(`   Tentatives réinitialisées: 0`);
    console.log(`   Verrouillage: Supprimé`);
    console.log('');
    console.log('🔐 Vous pouvez maintenant vous connecter');
    
} catch (error) {
    console.error('❌ Erreur:', error.message);
    process.exit(1);
}

db.close();
