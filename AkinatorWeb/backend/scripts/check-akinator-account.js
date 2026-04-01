/**
 * Script de diagnostic pour le compte Akinator
 * Vérifie l'état du compte et peut le déverrouiller si nécessaire
 */

const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/config');

const dbPath = config.database.path;
const db = new Database(dbPath);

try {
    console.log('🔍 Vérification du compte Akinator...\n');
    
    // Trouver le compte Akinator
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get('Akinator');
    
    if (!user) {
        console.log('❌ Compte Akinator non trouvé dans la base de données');
        console.log('\n📋 Liste des utilisateurs existants:');
        const allUsers = db.prepare('SELECT username, is_admin, created_at FROM users').all();
        allUsers.forEach(u => {
            console.log(`  - ${u.username} (Admin: ${u.is_admin === 1 ? 'Oui' : 'Non'})`);
        });
        process.exit(1);
    }
    
    console.log('✅ Compte Akinator trouvé\n');
    console.log('📊 Informations du compte:');
    console.log(`   ID: ${user.id}`);
    console.log(`   Username: ${user.username}`);
    console.log(`   Admin: ${user.is_admin === 1 ? 'Oui' : 'Non'}`);
    console.log(`   A2F activé: ${user.a2f_enabled === 1 ? 'Oui' : 'Non'}`);
    console.log(`   Jetons: ${user.tokens}`);
    console.log(`   Tentatives échouées: ${user.failed_login_attempts || 0}`);
    
    if (user.locked_until) {
        const lockedUntil = new Date(user.locked_until);
        const now = new Date();
        if (lockedUntil > now) {
            const remainingMinutes = Math.ceil((lockedUntil - now) / 60000);
            console.log(`   🔒 Compte VERROUILLÉ jusqu'à: ${lockedUntil.toLocaleString('fr-FR')}`);
            console.log(`   ⏱️  Temps restant: ${remainingMinutes} minutes`);
            
            console.log('\n🔓 Voulez-vous déverrouiller le compte maintenant ? (O/n)');
            // Pour l'instant, on déverrouille automatiquement
            console.log('   → Déverrouillage automatique...');
            db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
            console.log('   ✅ Compte déverrouillé !');
        } else {
            console.log(`   ✅ Compte non verrouillé (verrou expiré)`);
            // Nettoyer le verrou expiré
            db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
        }
    } else {
        console.log(`   ✅ Compte non verrouillé`);
    }
    
    console.log('\n🔐 Vérification du mot de passe hashé:');
    if (user.password_hash) {
        console.log(`   Hash présent: Oui (${user.password_hash.substring(0, 20)}...)`);
        console.log(`   Longueur: ${user.password_hash.length} caractères`);
    } else {
        console.log('   ❌ Aucun hash de mot de passe trouvé !');
    }
    
    console.log('\n✅ Diagnostic terminé');
    
} catch (error) {
    console.error('❌ Erreur lors du diagnostic:', error);
    process.exit(1);
} finally {
    db.close();
}
