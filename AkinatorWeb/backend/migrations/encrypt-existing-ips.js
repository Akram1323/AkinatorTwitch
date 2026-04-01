/**
 * Migration : Chiffrement des IPs existantes pour conformité RGPD
 * Chiffre toutes les IPs stockées en clair dans la base de données
 */

const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/config');
const { encryptIP, decryptIP } = require('../services/encryption');

const dbPath = config.database.path;
console.log('📂 Migration : Chiffrement des IPs existantes');
console.log('📂 Base de données:', dbPath);

const db = new Database(dbPath);

try {
    // Récupérer tous les utilisateurs avec leurs IPs
    const users = db.prepare("SELECT id, ip_address FROM users WHERE ip_address IS NOT NULL AND ip_address != ''").all();
    
    console.log(`\n📊 ${users.length} utilisateur(s) avec IP à chiffrer\n`);
    
    if (users.length === 0) {
        console.log('✅ Aucune IP à chiffrer');
        db.close();
        process.exit(0);
    }
    
    let encrypted = 0;
    let alreadyEncrypted = 0;
    let errors = 0;
    
    const updateIP = db.prepare('UPDATE users SET ip_address = ? WHERE id = ?');
    
    for (const user of users) {
        const currentIP = user.ip_address;
        
        // Vérifier si déjà chiffré (format base64 JSON)
        try {
            // Tenter de déchiffrer pour voir si c'est déjà chiffré
            const decrypted = decryptIP(currentIP);
            
            // Si le déchiffrement retourne quelque chose de différent ET que c'est une IP valide
            // alors c'était déjà chiffré
            if (decrypted !== currentIP && (decrypted.includes('.') || decrypted.includes(':'))) {
                console.log(`⏭️  Utilisateur ${user.id}: IP déjà chiffrée`);
                alreadyEncrypted++;
                continue;
            }
        } catch (e) {
            // Erreur de déchiffrement = IP en clair, on continue
        }
        
        // Chiffrer l'IP
        const encryptedIP = encryptIP(currentIP);
        
        if (!encryptedIP) {
            console.error(`❌ Erreur chiffrement pour utilisateur ${user.id}`);
            errors++;
            continue;
        }
        
        // Mettre à jour dans la base
        updateIP.run(encryptedIP, user.id);
        encrypted++;
        
        console.log(`✅ Utilisateur ${user.id}: IP chiffrée`);
    }
    
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📊 Résumé de la migration');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`✅ IPs chiffrées: ${encrypted}`);
    console.log(`⏭️  IPs déjà chiffrées: ${alreadyEncrypted}`);
    console.log(`❌ Erreurs: ${errors}`);
    console.log('═══════════════════════════════════════════════════════\n');
    
    if (errors === 0) {
        console.log('✅ Migration terminée avec succès !');
    } else {
        console.log('⚠️ Migration terminée avec des erreurs');
    }
    
} catch (error) {
    console.error('❌ Erreur lors de la migration:', error.message);
    console.error(error.stack);
    process.exit(1);
}

db.close();
