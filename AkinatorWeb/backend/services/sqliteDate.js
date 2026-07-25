/**
 * Lecture des horodatages SQLite.
 *
 * SQLite écrit `datetime('now', ...)` au format "YYYY-MM-DD HH:MM:SS", **toujours
 * en UTC** et sans indicateur de fuseau. `new Date()` interprète une telle chaîne
 * comme une heure LOCALE : dans un fuseau en avance sur UTC (Europe/Paris = UTC+2
 * en été), un verrou de 15 minutes paraît expiré depuis 1 h 45 dès sa pose — le
 * verrouillage de compte devient inopérant. D'où ce module, isolé et testable.
 *
 * @author AkinatorTwitch Team
 */

/**
 * Convertit un horodatage SQLite en Date, en l'interprétant comme de l'UTC.
 *
 * @param {string|Date|null|undefined} value Valeur brute lue en base
 * @returns {Date|null} Date correspondante, ou null si la valeur est absente ou illisible
 */
function parseSqliteDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    const raw = String(value);
    // Une chaîne portant déjà un fuseau ("...Z", "...+02:00", "...-05:00") est
    // laissée telle quelle ; sinon on la marque explicitement comme UTC.
    const hasTimezone = /[Z]$|[+-]\d{2}:?\d{2}$/.test(raw);
    const normalized = hasTimezone ? raw : raw.replace(' ', 'T') + 'Z';

    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Un horodatage de fin de verrou est-il encore actif ?
 *
 * FAIL-CLOSED : une valeur présente mais illisible est traitée comme un verrou
 * ACTIF. Un horodatage corrompu (migration bancale, restauration de dump) ne doit
 * jamais ouvrir un compte verrouillé — le coût d'un faux positif est un utilisateur
 * qui attend, celui d'un faux négatif est un contrôle de sécurité contourné.
 *
 * @param {string|Date|null|undefined} value Valeur brute lue en base
 * @returns {boolean} true si la date est dans le futur, ou si elle est illisible
 */
function isStillActive(value) {
    if (!value) return false;
    const date = parseSqliteDate(value);
    if (!date) return true;
    return date.getTime() > Date.now();
}

module.exports = { parseSqliteDate, isStillActive };
