/**
 * Script pour simuler une connexion et identifier l'erreur exacte
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { encryptIP } = require('../services/encryption');
const config = require('../config/config');

const dbPath = config.database.path;
const db = new Database(dbPath);

const TEST_USERNAME = 'Akinator';
const TEST_PASSWORD = '6?;8aH3V3yBe@r';
const TEST_IP = '127.0.0.1';

async function simulateLogin() {
    try {
        console.log('🔍 Simulation de connexion...\n');
        
        // Étape 1: Trouver l'utilisateur
        console.log('1️⃣ Recherche de l\'utilisateur...');
        const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(TEST_USERNAME);
        
        if (!user) {
            console.log('❌ Utilisateur non trouvé');
            return;
        }
        console.log('✅ Utilisateur trouvé:', user.username);
        
        // Étape 2: Vérifier le verrouillage
        console.log('\n2️⃣ Vérification du verrouillage...');
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            console.log('❌ Compte verrouillé');
            return;
        }
        console.log('✅ Compte non verrouillé');
        
        // Étape 3: Vérifier le mot de passe
        console.log('\n3️⃣ Vérification du mot de passe...');
        const validPassword = await bcrypt.compare(TEST_PASSWORD, user.password_hash);
        if (!validPassword) {
            console.log('❌ Mot de passe incorrect');
            return;
        }
        console.log('✅ Mot de passe correct');
        
        // Étape 4: Chiffrer l'IP
        console.log('\n4️⃣ Chiffrement de l\'IP...');
        const encryptedIP = encryptIP(TEST_IP);
        console.log('✅ IP chiffrée:', encryptedIP ? encryptedIP.substring(0, 30) + '...' : 'null');
        
        // Étape 5: Mettre à jour last_login
        console.log('\n5️⃣ Mise à jour de last_login...');
        try {
            const updateStmt = db.prepare(`
                UPDATE users SET 
                    last_login = CURRENT_TIMESTAMP,
                    failed_login_attempts = 0,
                    ip_address = ?
                WHERE id = ?
            `);
            updateStmt.run(encryptedIP, user.id);
            console.log('✅ last_login mis à jour');
        } catch (e) {
            console.log('❌ Erreur lors de la mise à jour:', e.message);
            throw e;
        }
        
        // Étape 6: Générer le token JWT
        console.log('\n6️⃣ Génération du token JWT...');
        try {
            const token = jwt.sign(
                { id: user.id, username: user.username, is_admin: user.is_admin === 1 },
                config.jwt.secret,
                { expiresIn: config.jwt.expiresIn, algorithm: config.jwt.algorithm }
            );
            console.log('✅ Token généré:', token.substring(0, 30) + '...');
        } catch (e) {
            console.log('❌ Erreur lors de la génération du token:', e.message);
            throw e;
        }
        
        console.log('\n✅ Simulation réussie ! Tous les tests passent.');
        console.log('\n💡 Si la connexion échoue toujours, vérifiez:');
        console.log('   - Les logs du serveur pour l\'erreur exacte');
        console.log('   - La console du navigateur pour les erreurs JavaScript');
        console.log('   - Que le serveur est bien démarré');
        
    } catch (error) {
        console.error('\n❌ ERREUR DÉTECTÉE:', error.message);
        console.error('Stack:', error.stack);
    } finally {
        db.close();
    }
}

simulateLogin();
