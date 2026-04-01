/**
 * Script : Créer le compte admin "Akinator"
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const config = require('../config/config');

const username = 'Akinator';
const password = '6?;8aH3V3yBe@r';
const BCRYPT_ROUNDS = 12;

const dbPath = config.database.path;
console.log('🔐 Création du compte admin Akinator');
console.log('📂 Base de données:', dbPath);
console.log('');

const db = new Database(dbPath);

async function createAdmin() {
    try {
        // Vérifier si l'utilisateur existe déjà
        const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
        
        if (existing) {
            console.log('⚠️  L\'utilisateur "Akinator" existe déjà');
            console.log('   ID:', existing.id);
            
            // Mettre à jour le mot de passe et promouvoir en admin
            const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
            db.prepare('UPDATE users SET password_hash = ?, is_admin = 1 WHERE id = ?').run(passwordHash, existing.id);
            
            console.log('✅ Compte mis à jour avec succès');
            console.log('   Username: Akinator');
            console.log('   Mot de passe: mis à jour');
            console.log('   Admin: Oui');
            db.close();
            return;
        }
        
        // Créer le hash du mot de passe
        console.log('🔒 Hachage du mot de passe...');
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        
        // Générer un ID unique
        const userId = uuidv4();
        
        // Insérer l'utilisateur avec is_admin = 1
        db.prepare(`
            INSERT INTO users (id, username, password_hash, tokens, is_admin)
            VALUES (?, ?, ?, ?, ?)
        `).run(userId, username, passwordHash, 3, 1);
        
        console.log('✅ Compte admin créé avec succès !');
        console.log('');
        console.log('📋 Informations du compte:');
        console.log('   Username: Akinator');
        console.log('   Mot de passe: 6?;8aH3V3yBe@r');
        console.log('   ID: ' + userId);
        console.log('   Jetons: 3');
        console.log('   Admin: Oui');
        console.log('');
        console.log('🔐 Vous pouvez maintenant vous connecter avec ces identifiants');
        
    } catch (error) {
        console.error('❌ Erreur:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

createAdmin().then(() => {
    db.close();
    process.exit(0);
}).catch(error => {
    console.error('❌ Erreur fatale:', error);
    db.close();
    process.exit(1);
});
