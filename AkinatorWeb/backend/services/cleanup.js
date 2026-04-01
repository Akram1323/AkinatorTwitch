/**
 * Service de nettoyage automatique des données pour conformité RGPD
 * Supprime les IPs après 12 mois (recommandation CNIL)
 * 
 * @author AkinatorTwitch Team
 * @version 1.0
 */

const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config/config');

/**
 * Supprime les IPs stockées depuis plus de 12 mois
 * Conformité RGPD - Recommandation CNIL
 * 
 * @returns {Object} Statistiques du nettoyage
 */
function cleanupOldIPs() {
    const dbPath = config.database.path;
    const db = new Database(dbPath);
    
    try {
        // Calculer la date limite (12 mois avant aujourd'hui)
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        const limitDate = twelveMonthsAgo.toISOString().split('T')[0];
        
        console.log(`🧹 Nettoyage des IPs antérieures au ${limitDate}`);
        
        // Compter les IPs à supprimer
        const countQuery = db.prepare(`
            SELECT COUNT(*) as count 
            FROM users 
            WHERE ip_address IS NOT NULL 
            AND ip_address != '' 
            AND (last_login IS NULL OR DATE(last_login) < ?)
        `);
        
        const countResult = countQuery.get(limitDate);
        const countToDelete = countResult.count;
        
        if (countToDelete === 0) {
            console.log('✅ Aucune IP à supprimer');
            db.close();
            return {
                deleted: 0,
                dateLimit: limitDate
            };
        }
        
        // Supprimer les IPs anciennes
        const deleteQuery = db.prepare(`
            UPDATE users 
            SET ip_address = NULL 
            WHERE ip_address IS NOT NULL 
            AND ip_address != '' 
            AND (last_login IS NULL OR DATE(last_login) < ?)
        `);
        
        const result = deleteQuery.run(limitDate);
        
        console.log(`✅ ${result.changes} IP(s) supprimée(s) (anciennes de plus de 12 mois)`);
        
        db.close();
        
        return {
            deleted: result.changes,
            dateLimit: limitDate
        };
        
    } catch (error) {
        console.error('❌ Erreur lors du nettoyage des IPs:', error.message);
        db.close();
        throw error;
    }
}

/**
 * Nettoie également les IPs basées sur la date de création du compte
 * (pour les comptes qui n'ont jamais eu de connexion)
 */
function cleanupOldIPsByCreationDate() {
    const dbPath = config.database.path;
    const db = new Database(dbPath);
    
    try {
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        const limitDate = twelveMonthsAgo.toISOString().split('T')[0];
        
        // Supprimer les IPs des comptes créés il y a plus de 12 mois et jamais connectés
        const deleteQuery = db.prepare(`
            UPDATE users 
            SET ip_address = NULL 
            WHERE ip_address IS NOT NULL 
            AND ip_address != '' 
            AND last_login IS NULL 
            AND DATE(created_at) < ?
        `);
        
        const result = deleteQuery.run(limitDate);
        
        if (result.changes > 0) {
            console.log(`✅ ${result.changes} IP(s) supplémentaire(s) supprimée(s) (comptes inactifs)`);
        }
        
        db.close();
        
        return {
            deleted: result.changes,
            dateLimit: limitDate
        };
        
    } catch (error) {
        console.error('❌ Erreur lors du nettoyage des IPs par date de création:', error.message);
        db.close();
        throw error;
    }
}

/**
 * Exécute le nettoyage complet (IPs par dernière connexion + par date de création)
 */
function runFullCleanup() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('🧹 NETTOYAGE AUTOMATIQUE DES IPs (Conformité RGPD)');
    console.log('═══════════════════════════════════════════════════════\n');
    
    const result1 = cleanupOldIPs();
    const result2 = cleanupOldIPsByCreationDate();
    
    const totalDeleted = result1.deleted + result2.deleted;
    
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📊 RÉSUMÉ DU NETTOYAGE');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`✅ Total IPs supprimées: ${totalDeleted}`);
    console.log(`📅 Date limite: ${result1.dateLimit}`);
    console.log('═══════════════════════════════════════════════════════\n');
    
    return {
        totalDeleted,
        dateLimit: result1.dateLimit
    };
}

module.exports = {
    cleanupOldIPs,
    cleanupOldIPsByCreationDate,
    runFullCleanup
};
