/**
 * Script de diagnostic complet pour identifier le problème de connexion
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

async function diagnostic() {
    console.log('🔍 DIAGNOSTIC COMPLET DU SYSTÈME DE CONNEXION\n');
    console.log('═══════════════════════════════════════════════════════\n');
    
    try {
        // Test 1: Configuration
        console.log('1️⃣ Vérification de la configuration...');
        if (!config.jwt.secret) {
            console.log('   ❌ JWT_SECRET non défini !');
            console.log('   💡 Vérifiez votre fichier .env');
            return;
        }
        console.log('   ✅ JWT_SECRET défini');
        console.log('   ✅ Base de données:', config.database.path);
        console.log('   ✅ Mode:', config.nodeEnv);
        
        // Test 2: Base de données
        console.log('\n2️⃣ Vérification de la base de données...');
        try {
            const testQuery = db.prepare('SELECT COUNT(*) as count FROM users').get();
            console.log('   ✅ Connexion à la base de données OK');
            console.log('   ✅ Nombre d\'utilisateurs:', testQuery.count);
        } catch (dbError) {
            console.log('   ❌ Erreur base de données:', dbError.message);
            return;
        }
        
        // Test 3: Utilisateur Akinator
        console.log('\n3️⃣ Recherche de l\'utilisateur Akinator...');
        const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(TEST_USERNAME);
        if (!user) {
            console.log('   ❌ Utilisateur Akinator non trouvé');
            console.log('   💡 Le compte doit être recréé');
            return;
        }
        console.log('   ✅ Utilisateur trouvé');
        console.log('      ID:', user.id);
        console.log('      Admin:', user.is_admin === 1 ? 'Oui' : 'Non');
        console.log('      A2F:', user.a2f_enabled === 1 ? 'Activé' : 'Désactivé');
        console.log('      Verrouillé:', user.locked_until ? 'Oui' : 'Non');
        
        // Test 4: Mot de passe
        console.log('\n4️⃣ Vérification du mot de passe...');
        try {
            const isValid = await bcrypt.compare(TEST_PASSWORD, user.password_hash);
            if (!isValid) {
                console.log('   ❌ Mot de passe incorrect');
                console.log('   💡 Le hash dans la base ne correspond pas au mot de passe fourni');
                return;
            }
            console.log('   ✅ Mot de passe correct');
        } catch (bcryptError) {
            console.log('   ❌ Erreur lors de la vérification:', bcryptError.message);
            return;
        }
        
        // Test 5: Chiffrement IP
        console.log('\n5️⃣ Test du chiffrement IP...');
        try {
            const testIP = '127.0.0.1';
            const encrypted = encryptIP(testIP);
            if (!encrypted) {
                console.log('   ⚠️  encryptIP a retourné null (acceptable)');
            } else {
                console.log('   ✅ Chiffrement IP fonctionne');
            }
        } catch (encryptError) {
            console.log('   ❌ Erreur chiffrement IP:', encryptError.message);
            return;
        }
        
        // Test 6: Requête canClaimDaily
        console.log('\n6️⃣ Test de la requête canClaimDaily...');
        try {
            const canClaimStmt = db.prepare(`
                SELECT CASE 
                    WHEN last_daily_claim IS NULL THEN 1
                    WHEN last_daily_claim < date('now') THEN 1
                    ELSE 0
                END as can_claim
                FROM users WHERE id = ?
            `);
            const result = canClaimStmt.get(user.id);
            console.log('   ✅ Requête canClaimDaily fonctionne');
            console.log('      Résultat:', result);
        } catch (queryError) {
            console.log('   ❌ Erreur requête canClaimDaily:', queryError.message);
            return;
        }
        
        // Test 7: Génération JWT
        console.log('\n7️⃣ Test de génération du token JWT...');
        try {
            const token = jwt.sign(
                { id: user.id, username: user.username, is_admin: user.is_admin === 1 },
                config.jwt.secret,
                { expiresIn: config.jwt.expiresIn, algorithm: config.jwt.algorithm }
            );
            console.log('   ✅ Token JWT généré avec succès');
            console.log('      Longueur:', token.length);
            
            // Vérifier le token
            const decoded = jwt.verify(token, config.jwt.secret);
            console.log('   ✅ Token JWT vérifié avec succès');
            console.log('      Payload:', JSON.stringify(decoded, null, 2));
        } catch (jwtError) {
            console.log('   ❌ Erreur JWT:', jwtError.message);
            return;
        }
        
        // Test 8: Mise à jour last_login
        console.log('\n8️⃣ Test de mise à jour last_login...');
        try {
            const updateStmt = db.prepare(`
                UPDATE users SET 
                    last_login = CURRENT_TIMESTAMP,
                    failed_login_attempts = 0,
                    ip_address = ?
                WHERE id = ?
            `);
            const encryptedIP = encryptIP('127.0.0.1');
            updateStmt.run(encryptedIP || null, user.id);
            console.log('   ✅ Mise à jour last_login réussie');
        } catch (updateError) {
            console.log('   ❌ Erreur mise à jour:', updateError.message);
            return;
        }
        
        console.log('\n═══════════════════════════════════════════════════════');
        console.log('✅ TOUS LES TESTS SONT PASSÉS !');
        console.log('═══════════════════════════════════════════════════════\n');
        console.log('💡 Le problème pourrait venir de:');
        console.log('   1. Le serveur n\'est pas démarré');
        console.log('   2. Un problème de CORS');
        console.log('   3. Un problème réseau entre le navigateur et le serveur');
        console.log('   4. Une erreur dans le frontend qui n\'est pas visible ici');
        console.log('\n📋 Actions recommandées:');
        console.log('   - Vérifiez que le serveur est démarré: npm start ou node server.js');
        console.log('   - Vérifiez les logs du serveur lors de la tentative de connexion');
        console.log('   - Vérifiez la console du navigateur (F12) pour les erreurs JavaScript');
        console.log('   - Vérifiez l\'onglet Network dans les DevTools pour voir la requête HTTP');
        
    } catch (error) {
        console.error('\n❌ ERREUR CRITIQUE:', error.message);
        console.error('Stack:', error.stack);
    } finally {
        db.close();
    }
}

diagnostic();
