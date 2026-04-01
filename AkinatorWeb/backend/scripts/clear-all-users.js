/**
 * Script : Supprimer tous les utilisateurs de la base de données
 * ATTENTION : Cette action est irréversible !
 */

const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/config');

const dbPath = config.database.path;
console.log('🗑️  Suppression de tous les utilisateurs');
console.log('📂 Base de données:', dbPath);
console.log('');

const db = new Database(dbPath);

try {
    // Compter les utilisateurs avant suppression
    const countBefore = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    
    if (countBefore === 0) {
        console.log('✅ Aucun utilisateur à supprimer');
        db.close();
        process.exit(0);
    }
    
    console.log(`⚠️  ${countBefore} utilisateur(s) trouvé(s)`);
    console.log('');
    
    // Supprimer tous les utilisateurs (CASCADE supprimera aussi les données associées)
    db.exec('DELETE FROM users');
    
    // Vérifier après suppression
    const countAfter = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    
    console.log('✅ Tous les utilisateurs ont été supprimés');
    console.log(`   Avant: ${countBefore} utilisateur(s)`);
    console.log(`   Après: ${countAfter} utilisateur(s)`);
    
} catch (error) {
    console.error('❌ Erreur:', error.message);
    process.exit(1);
}

db.close();
