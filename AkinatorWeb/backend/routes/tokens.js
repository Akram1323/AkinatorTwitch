/**
 * Routes de gestion des jetons
 * Solde, historique, gift quotidien
 *
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { queries } = require('../services/database');
const { authenticateToken, tokenRequestLimiter } = require('../middleware/security');
const { claimDailyTokens, ALREADY_CLAIMED } = require('../services/dailyTokens');
const { appendAudit } = require('../services/auditService');
const { hashIPForLogging } = require('../services/encryption');

const router = express.Router();

/** Plafond d'une demande : au-delà, elle relève d'un échange direct avec un admin. */
const MONTANT_DEMANDE_MAX = 100;
const MOTIF_LONGUEUR_MAX = 200;

/** Projection publique d'une demande (jamais l'id interne de l'admin résolveur). */
function projectRequest(row) {
    return {
        id: row.id,
        amount: row.amount,
        reason: row.reason,
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at
    };
}

/**
 * GET /api/tokens/balance
 * Récupère le solde de jetons de l'utilisateur
 */
router.get('/balance', authenticateToken, (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur non trouvé'
            });
        }

        res.json({
            success: true,
            data: {
                tokens: user.tokens,
                totalGames: user.total_games
            }
        });

    } catch (error) {
        console.error('Erreur balance:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération du solde'
        });
    }
});

/**
 * GET /api/tokens/transactions
 * Récupère l'historique des transactions
 */
router.get('/transactions', authenticateToken, (req, res) => {
    try {
        const userTransactions = queries.transactions.findByUser.all(req.user.id);

        res.json({
            success: true,
            data: userTransactions.map(tx => ({
                id: tx.id,
                type: tx.type,
                amount: tx.amount,
                status: tx.status,
                createdAt: tx.created_at
            }))
        });

    } catch (error) {
        console.error('Erreur transactions:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération des transactions'
        });
    }
});

/**
 * POST /api/tokens/gift
 * Robinet quotidien de jetons gratuits — MÊME robinet que POST /api/auth/claim-daily
 * (les deux routes consomment la colonne `last_daily_claim`).
 *
 * Donne toujours 3 jetons : le champ `amount` du corps est encore accepté pour
 * ne pas casser les anciens appels, mais il est délibérément IGNORÉ (il permettait
 * auparavant de se servir jusqu'à 10 jetons/jour au lieu des 3 prévus).
 */
router.post('/gift', authenticateToken, (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur non trouvé'
            });
        }

        const claim = claimDailyTokens(user.id);

        if (!claim) {
            return res.status(ALREADY_CLAIMED.status).json(ALREADY_CLAIMED.body);
        }

        console.log(`🎁 Jetons quotidiens: ${req.user.username} +${claim.tokensAdded} jetons`);

        res.json({
            success: true,
            message: `${claim.tokensAdded} jetons quotidiens ajoutés !`,
            data: claim
        });

    } catch (error) {
        console.error('Erreur gift:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors du gift'
        });
    }
});

/**
 * GET /api/tokens/requests
 * Les 20 dernières demandes de jetons de l'utilisateur courant.
 */
router.get('/requests', authenticateToken, (req, res) => {
    try {
        const demandes = queries.tokenRequests.findByUser.all(req.user.id);
        res.json({ success: true, data: demandes.map(projectRequest) });
    } catch (error) {
        console.error('Erreur liste demandes de jetons:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la récupération des demandes'
        });
    }
});

/**
 * POST /api/tokens/requests
 * Adresse une demande de jetons aux administrateurs.
 * Body : { amount: entier 1..100, reason: string 3..200 }
 *
 * Une seule demande en attente à la fois : la garantie vient de l'index unique
 * partiel `idx_token_requests_une_en_attente`, la vérification préalable ne sert
 * qu'à produire un message clair.
 */
router.post('/requests', authenticateToken, tokenRequestLimiter, (req, res) => {
    try {
        const { amount, reason } = req.body;

        if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MONTANT_DEMANDE_MAX) {
            return res.status(400).json({
                success: false,
                error: `Montant invalide (entier entre 1 et ${MONTANT_DEMANDE_MAX})`
            });
        }

        const motif = typeof reason === 'string' ? reason.trim() : '';
        if (motif.length < 3 || motif.length > MOTIF_LONGUEUR_MAX) {
            return res.status(400).json({
                success: false,
                error: `Motif obligatoire (entre 3 et ${MOTIF_LONGUEUR_MAX} caractères)`
            });
        }

        const id = uuidv4();
        try {
            queries.tokenRequests.create.run(id, req.user.id, amount, motif);
        } catch (error) {
            // SQLITE_CONSTRAINT_UNIQUE : une demande est déjà en attente.
            if (error && typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
                return res.status(409).json({
                    success: false,
                    error: 'Vous avez déjà une demande en attente de traitement'
                });
            }
            throw error;
        }

        const rawIP = req.ip || req.connection.remoteAddress || 'unknown';
        appendAudit('tokens.request.create', {
            userId: req.user.id,
            ipHash: hashIPForLogging(rawIP),
            details: { requestId: id, username: req.user.username, amount, reason: motif }
        });

        console.log(`📨 Demande de jetons: ${req.user.username} demande ${amount} jeton(s)`);

        res.status(201).json({
            success: true,
            message: 'Demande envoyée aux administrateurs',
            data: projectRequest(queries.tokenRequests.findById.get(id))
        });

    } catch (error) {
        console.error('Erreur création demande de jetons:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de l\'envoi de la demande'
        });
    }
});

module.exports = router;
