/**
 * Migration : Ajout de la colonne is_admin pour les comptes administrateurs
 */

const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/config');

const dbPath = config.database.path;
console.log('📂 Migration : Ajout colonne is_admin');
console.log('📂 Base de données:', dbPath);

const db = new Database(dbPath);

try {
    // Ajouter la colonne is_admin si elle n'existe pas
    try {
        db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
        console.log('✅ Colonne is_admin ajoutée');
    } catch (e) {
        if (e.message.includes('duplicate column')) {
            console.log('⏭️  Colonne is_admin existe déjà');
        } else {
            throw e;
        }
    }
    
    console.log('✅ Migration terminée avec succès !');
    
} catch (error) {
    console.error('❌ Erreur lors de la migration:', error.message);
    process.exit(1);
}

db.close();
