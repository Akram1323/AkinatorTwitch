/**
 * Service de chiffrement pour la conformité RGPD
 * Chiffrement des données sensibles (IPs, etc.)
 * 
 * Conformité RGPD :
 * - Les adresses IP sont considérées comme des données personnelles
 * - Elles doivent être chiffrées avant stockage
 * - Utilisation d'AES-256-GCM (authentifié et sécurisé)
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const crypto = require('crypto');
const config = require('../config/config');

// Clé de chiffrement dérivée du JWT_SECRET (ou générée)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || deriveKeyFromJWTSecret();
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 16 bytes pour AES
const SALT_LENGTH = 64; // 64 bytes pour le salt
const TAG_LENGTH = 16; // 16 bytes pour l'authentification tag

/**
 * Dérive une clé de chiffrement depuis le JWT_SECRET si ENCRYPTION_KEY n'est pas définie
 */
function deriveKeyFromJWTSecret() {
    const jwtSecret = config.jwt.secret;
    return crypto.createHash('sha256').update(jwtSecret + 'encryption_salt').digest();
}

/**
 * Chiffre une adresse IP (ou autre donnée sensible)
 * 
 * @param {string} text - Texte à chiffrer (ex: "192.168.1.1")
 * @returns {string} - Texte chiffré au format base64
 */
function encryptIP(text) {
    if (!text || text.trim() === '') {
        return null;
    }

    try {
        // Générer un IV (Initialization Vector) aléatoire
        const iv = crypto.randomBytes(IV_LENGTH);
        
        // Créer le cipher
        const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
        
        // Chiffrer le texte
        let encrypted = cipher.update(text, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        
        // Récupérer l'authentication tag
        const authTag = cipher.getAuthTag();
        
        // Combiner IV + authTag + texte chiffré
        const result = {
            iv: iv.toString('base64'),
            tag: authTag.toString('base64'),
            encrypted: encrypted
        };
        
        // Encoder en JSON puis base64 pour stockage
        return Buffer.from(JSON.stringify(result)).toString('base64');
        
    } catch (error) {
        console.error('❌ Erreur chiffrement IP:', error.message);
        // En cas d'erreur, retourner null plutôt que de planter
        return null;
    }
}

/**
 * Déchiffre une adresse IP (ou autre donnée sensible)
 * 
 * @param {string} encryptedText - Texte chiffré au format base64
 * @returns {string|null} - Texte déchiffré ou null si erreur
 */
function decryptIP(encryptedText) {
    if (!encryptedText || encryptedText.trim() === '') {
        return null;
    }

    try {
        // Vérifier si c'est du JSON base64 valide
        const decoded = JSON.parse(Buffer.from(encryptedText, 'base64').toString('utf8'));
        
        // Vérifier la structure attendue
        if (!decoded.iv || !decoded.tag || !decoded.encrypted) {
            // Format invalide, probablement une IP en clair
            return encryptedText;
        }
        
        // Extraire les composants
        const iv = Buffer.from(decoded.iv, 'base64');
        const authTag = Buffer.from(decoded.tag, 'base64');
        const encrypted = decoded.encrypted;
        
        // Créer le decipher
        const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
        decipher.setAuthTag(authTag);
        
        // Déchiffrer
        let decrypted = decipher.update(encrypted, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
        
    } catch (error) {
        // Si erreur de parsing JSON ou déchiffrement, c'est probablement une IP en clair
        // Retourner tel quel pour compatibilité avec les anciennes données
        return encryptedText;
    }
}

/**
 * Hash une IP pour le logging (irréversible, conforme RGPD)
 * Utilisé pour le logging anonymisé
 * 
 * @param {string} ip - Adresse IP
 * @returns {string} - Hash SHA-256 de l'IP
 */
function hashIPForLogging(ip) {
    if (!ip || ip.trim() === '') {
        return 'N/A';
    }
    
    // Utilise SHA256 pour hasher l'IP, mais ne la rend pas réversible
    return crypto.createHash('sha256').update(ip + (process.env.IP_HASH_SALT || 'ip_salt')).digest('hex').substring(0, 16); // Tronqué pour la concision
}

module.exports = {
    encryptIP,
    decryptIP,
    hashIPForLogging
};
