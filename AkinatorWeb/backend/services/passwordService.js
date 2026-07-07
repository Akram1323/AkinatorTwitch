/**
 * Validation avancée des mots de passe :
 * - Force : score zxcvbn >= 3 (échelle 0-4)
 * - Compromission : HaveIBeenPwned via k-anonymity
 *   (seuls les 5 premiers caractères du SHA-1 sont transmis)
 */
const crypto = require('crypto');
const zxcvbn = require('zxcvbn');
const config = require('../config/config');

const MIN_ZXCVBN_SCORE = 3;
const HIBP_TIMEOUT_MS = 3000;

async function isPwnedPassword(password, fetchImpl = fetch) {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
        const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
            signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
            headers: { 'Add-Padding': 'true' }
        });
        if (!response.ok) return false; // fail-open
        const body = await response.text();
        return body.split(/\r?\n/).some(line => line.split(':')[0] === suffix);
    } catch (error) {
        // Fail-open : ne pas bloquer l'inscription si HIBP est injoignable
        console.warn('⚠️ HIBP injoignable, vérification ignorée:', error.message);
        return false;
    }
}

async function validateNewPassword(password, username = '') {
    const strength = zxcvbn(password, [username, 'akinator', 'twitch']);
    if (strength.score < MIN_ZXCVBN_SCORE) {
        return {
            ok: false,
            error: 'Mot de passe trop prévisible. Utilisez une phrase de passe longue et originale.'
        };
    }
    // En environnement de test, on n'appelle jamais l'API HIBP réelle :
    // cela éviterait un appel réseau réel (flakiness + dépendance externe) pendant `npm test`.
    // La logique isPwnedPassword reste entièrement couverte par tests/password-service.test.js
    // via un fetch injecté.
    if (!config.isTest && await isPwnedPassword(password)) {
        return {
            ok: false,
            error: 'Ce mot de passe apparaît dans des fuites de données connues. Choisissez-en un autre.'
        };
    }
    return { ok: true };
}

module.exports = { validateNewPassword, isPwnedPassword, MIN_ZXCVBN_SCORE };
