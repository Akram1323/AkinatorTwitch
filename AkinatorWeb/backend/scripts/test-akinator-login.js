/**
 * Script de test pour vérifier la connexion du compte Akinator
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const config = require('../config/config');

const dbPath = config.database.path;
const db = new Database(dbPath);

const TEST_PASSWORD = '6?;8aH3V3yBe@r';

async function testLogin() {
    try {
        console.log('🔍 Test de connexion pour le compte Akinator...\n');
        
        // Trouver le compte Akinator
        const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get('Akinator');
        
        if (!user) {
            console.log('❌ Compte Akinator non trouvé');
            process.exit(1);
        }
        
        console.log('✅ Compte trouvé');
        console.log(`   Username: ${user.username}`);
        console.log(`   Hash: ${user.password_hash.substring(0, 30)}...\n`);
        
        // Tester le mot de passe
        console.log('🔐 Test du mot de passe...');
        const isValid = await bcrypt.compare(TEST_PASSWORD, user.password_hash);
        
        if (isValid) {
            console.log('✅ Mot de passe CORRECT !');
        } else {
            console.log('❌ Mot de passe INCORRECT !');
            console.log('\n💡 Le mot de passe dans la base ne correspond pas au mot de passe attendu.');
            console.log('   Il faudra peut-être recréer le compte avec le bon mot de passe.');
        }
        
        // Vérifier l'état du compte
        console.log('\n📊 État du compte:');
        console.log(`   Tentatives échouées: ${user.failed_login_attempts || 0}`);
        if (user.locked_until) {
            const lockedUntil = new Date(user.locked_until);
            const now = new Date();
            if (lockedUntil > now) {
                console.log(`   🔒 VERROUILLÉ jusqu'à: ${lockedUntil.toLocaleString('fr-FR')}`);
            } else {
                console.log(`   ✅ Non verrouillé`);
            }
        } else {
            console.log(`   ✅ Non verrouillé`);
        }
        
    } catch (error) {
        console.error('❌ Erreur:', error);
        console.error(error.stack);
        process.exit(1);
    } finally {
        db.close();
    }
}

testLogin();
