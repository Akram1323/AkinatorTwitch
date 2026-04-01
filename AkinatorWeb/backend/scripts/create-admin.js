/**
 * Script : Promouvoir un utilisateur en administrateur
 * Usage: node scripts/create-admin.js <username>
 */

const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/config');

const username = process.argv[2];

if (!username) {
    console.error('❌ Usage: node scripts/create-admin.js <username>');
    console.error('   Exemple: node scripts/create-admin.js MonPseudo123');
    process.exit(1);
}

const dbPath = config.database.path;
console.log('🔐 Promotion en administrateur');
console.log('📂 Base de données:', dbPath);
console.log('👤 Utilisateur:', username);
console.log('');

const db = new Database(dbPath);

try {
    // Vérifier si l'utilisateur existe
    const user = db.prepare('SELECT id, username, is_admin FROM users WHERE username = ? COLLATE NOCASE').get(username);
    
    if (!user) {
        console.error(`❌ Utilisateur "${username}" introuvable`);
        process.exit(1);
    }
    
    if (user.is_admin === 1) {
        console.log(`⚠️  L'utilisateur "${username}" est déjà administrateur`);
        process.exit(0);
    }
    
    // Promouvoir en admin
    const update = db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?');
    update.run(user.id);
    
    console.log('✅ Utilisateur promu administrateur avec succès !');
    console.log(`   Username: ${user.username}`);
    console.log(`   ID: ${user.id}`);
    console.log('');
    console.log('🔐 Droits administrateur activés:');
    console.log('   - Accès au nettoyage des IPs');
    console.log('   - Gestion des comptes utilisateurs');
    console.log('   - Visualisation des statistiques');
    
} catch (error) {
    console.error('❌ Erreur:', error.message);
    process.exit(1);
}

db.close();
