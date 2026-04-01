/**
 * Script d'analyse de la base de données
 * Affiche la structure et les données des utilisateurs
 */

const Database = require('better-sqlite3');
const path = require('path');
const config = require('./config/config');
const { decryptIP } = require('./services/encryption');

const dbPath = config.database.path;
console.log('📂 Chemin de la base de données:', dbPath);

const db = new Database(dbPath, { readonly: true });

console.log('\n═══════════════════════════════════════════════════════');
console.log('📊 STRUCTURE DE LA TABLE users');
console.log('═══════════════════════════════════════════════════════\n');

// Obtenir le schéma de la table
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
console.log('Schéma SQL:');
console.log(schema.sql);
console.log('\n');

// Lister toutes les colonnes
const columns = db.prepare("PRAGMA table_info(users)").all();
console.log('Colonnes de la table users:');
columns.forEach(col => {
    console.log(`  - ${col.name} (${col.type})${col.notnull ? ' NOT NULL' : ''}${col.dflt_value ? ` DEFAULT ${col.dflt_value}` : ''}`);
});

console.log('\n═══════════════════════════════════════════════════════');
console.log('👥 UTILISATEURS ENREGISTRÉS');
console.log('═══════════════════════════════════════════════════════\n');

// Compter les utilisateurs
const count = db.prepare("SELECT COUNT(*) as total FROM users").get();
console.log(`Total d'utilisateurs: ${count.total}\n`);

    // Récupérer tous les utilisateurs (sans le password_hash pour la sécurité, email supprimé)
    const users = db.prepare(`
    SELECT 
        id,
        username,
        tokens,
        total_games,
        last_daily_claim,
        failed_login_attempts,
        locked_until,
        a2f_enabled,
        avatar_url,
        created_at,
        last_login,
        ip_address
    FROM users
    ORDER BY created_at DESC
`).all();

if (users.length === 0) {
    console.log('❌ Aucun utilisateur trouvé dans la base de données.\n');
} else {
    users.forEach((user, index) => {
        console.log(`\n👤 Utilisateur #${index + 1}:`);
        console.log(`   ID: ${user.id}`);
        console.log(`   Username: ${user.username || '(vide)'}`);
        console.log(`   Jetons: ${user.tokens}`);
        console.log(`   Parties jouées: ${user.total_games}`);
        console.log(`   Dernière réclamation quotidienne: ${user.last_daily_claim || '(jamais)'}`);
        console.log(`   Tentatives de connexion échouées: ${user.failed_login_attempts}`);
        console.log(`   Compte verrouillé jusqu'à: ${user.locked_until || '(non verrouillé)'}`);
        console.log(`   A2F activé: ${user.a2f_enabled ? 'Oui' : 'Non'}`);
        console.log(`   Avatar: ${user.avatar_url || '(aucun)'}`);
        console.log(`   Créé le: ${user.created_at}`);
        console.log(`   Dernière connexion: ${user.last_login || '(jamais)'}`);
        // Déchiffrer l'IP pour l'affichage (ou masquer pour conformité RGPD)
        const decryptedIP = user.ip_address ? decryptIP(user.ip_address) : null;
        console.log(`   IP: ${decryptedIP || '(non enregistrée)'} ${user.ip_address && decryptedIP !== user.ip_address ? '(chiffrée)' : ''}`);
    });
}

// Recherche spécifique pour "MonPseudo123"
console.log('\n═══════════════════════════════════════════════════════');
console.log('🔍 RECHERCHE: "MonPseudo123"');
console.log('═══════════════════════════════════════════════════════\n');

const searchUser = db.prepare("SELECT * FROM users WHERE username LIKE ? COLLATE NOCASE").all('%MonPseudo123%');

if (searchUser.length === 0) {
    console.log('❌ Aucun utilisateur trouvé avec "MonPseudo123"\n');
    console.log('💡 Vérification avec recherche insensible à la casse...');
    
    // Recherche exacte
    const exactUser = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get('MonPseudo123');
    if (exactUser) {
        console.log('✅ Utilisateur trouvé avec recherche exacte:');
        console.log(`   Username: ${exactUser.username}`);
        console.log(`   ID: ${exactUser.id}`);
    } else {
        console.log('❌ Aucun utilisateur trouvé même avec recherche exacte');
        console.log('\n📋 Liste de tous les usernames dans la base:');
        const allUsernames = db.prepare("SELECT username FROM users").all();
        if (allUsernames.length > 0) {
            allUsernames.forEach(u => console.log(`   - ${u.username}`));
        } else {
            console.log('   (aucun username trouvé)');
        }
    }
} else {
    searchUser.forEach(user => {
        console.log(`✅ Trouvé: ${user.username} (ID: ${user.id})`);
    });
}

db.close();
console.log('\n✅ Analyse terminée !\n');
