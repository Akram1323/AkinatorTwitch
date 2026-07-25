/**
 * Robinet quotidien de jetons — source unique de vérité.
 *
 * Deux routes y donnent accès : POST /api/auth/claim-daily et POST /api/tokens/gift.
 * Elles partagent la colonne `users.last_daily_claim`, elles doivent donc donner
 * exactement la même chose et tracer la même transaction — d'où ce module commun
 * plutôt qu'une logique dupliquée de chaque côté.
 *
 * @author AkinatorTwitch Team
 */

const { v4: uuidv4 } = require('uuid');
const { db, queries } = require('./database');

/** Montant offert par jour, quelle que soit la route empruntée. */
const DAILY_TOKENS = 3;

/**
 * Réclame les jetons du jour pour un utilisateur.
 *
 * Atomique à deux niveaux :
 * - `claimDailyAtomic` vérifie ET met à jour en une seule requête conditionnelle
 *   (aucune fenêtre entre le contrôle et l'écriture, y compris en multi-instance) ;
 * - la transaction SQLite garantit qu'aucune ligne `transactions` n'est écrite
 *   lorsque le robinet a déjà été utilisé aujourd'hui.
 *
 * @param {string} userId Identifiant de l'utilisateur
 * @returns {{tokensAdded: number, newBalance: number}|null} null si déjà réclamé aujourd'hui
 */
const claimDailyTokens = db.transaction((userId) => {
    const result = queries.users.claimDailyAtomic.run(DAILY_TOKENS, userId);

    // Aucune ligne modifiée = robinet déjà utilisé aujourd'hui
    if (result.changes === 0) {
        return null;
    }

    queries.transactions.create.run(
        uuidv4(), userId, 'daily', DAILY_TOKENS, null, 'completed'
    );

    const updatedUser = queries.users.findById.get(userId);
    return { tokensAdded: DAILY_TOKENS, newBalance: updatedUser.tokens };
});

/**
 * Réponse HTTP commune aux deux routes quand le robinet est déjà épuisé.
 * Gelée : elle est passée telle quelle à res.json() par deux routes différentes,
 * une mutation accidentelle depuis l'une contaminerait l'autre.
 */
const ALREADY_CLAIMED = Object.freeze({
    status: 429,
    body: Object.freeze({
        success: false,
        error: 'Vous avez déjà réclamé vos jetons quotidiens aujourd\'hui. Réessayez demain.'
    })
});

module.exports = { DAILY_TOKENS, claimDailyTokens, ALREADY_CLAIMED };
