/**
 * Script pour déverrouiller le compte Akinator
 */

const Database = require('better-sqlite3');
const config = require('../config/config');

const dbPath = config.database.path;
const db = new Database(dbPath);

try {
    console.log('🔓 Déverrouillage du compte Akinator...\n');
    
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get('Akinator');
    
    if (!user) {
        console.log('❌ Compte Akinator non trouvé');
        process.exit(1);
    }
    
    console.log(`✅ Compte trouvé: ${user.username}`);
    console.log(`   Tentatives échouées: ${user.failed_login_attempts || 0}`);
    
    if (user.locked_until) {
        const lockedUntil = new Date(user.locked_until);
        const now = new Date();
        if (lockedUntil > now) {
            console.log(`   🔒 Actuellement verrouillé jusqu'à: ${lockedUntil.toLocaleString('fr-FR')}`);
        }
    }
    
    // Déverrouiller
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
    
    console.log('\n✅ Compte déverrouillé avec succès !');
    console.log('   Vous pouvez maintenant vous connecter.');
    
} catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
} finally {
    db.close();
}
