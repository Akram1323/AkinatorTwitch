/**
 * Routes de gestion des jetons
 * Achat, vérification, transactions crypto
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');

const config = require('../config/config');
const { queries } = require('../services/database');
const { users, transactions } = {
    get users() { return queries.users; },
    get transactions() { return queries.transactions; }
};
const { authenticateToken, paymentLimiter } = require('../middleware/security');
const db = require('../services/database').db;
const btcpay = require('../services/btcpay');

// Prix des packs en EUR pour BTCPay
const PACK_EUR_PRICES = {
    'pack_10':  { tokens: 10,  eur: 0.50 },
    'pack_25':  { tokens: 25,  eur: 1.00 },
    'pack_50':  { tokens: 50,  eur: 1.80 },
    'pack_100': { tokens: 100, eur: 3.00 }
};

const router = express.Router();

/**
 * GET /api/tokens/balance
 * Récupère le solde de jetons de l'utilisateur
 */
router.get('/balance', authenticateToken, (req, res) => {
    try {
        const user = users.findById.get(req.user.id);
        
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
 * GET /api/tokens/prices
 * Récupère les prix des packs de jetons
 */
router.get('/prices', (req, res) => {
    res.json({
        success: true,
        data: {
            packs: [
                { id: 'pack_10', tokens: 10, btc: '0.00005', eth: '0.0005' },
                { id: 'pack_25', tokens: 25, btc: '0.0001', eth: '0.001' },
                { id: 'pack_50', tokens: 50, btc: '0.00018', eth: '0.0018' },
                { id: 'pack_100', tokens: 100, btc: '0.0003', eth: '0.003' }
            ],
            addresses: {
                btc: 'bc1qkm9qyw73f5n5fpj8etgytqczl3hjnafy6xrvs0',
                eth: '0x1cE68c57A2bA325CD61dD248159957130132EF05'
            }
        }
    });
});

/**
 * POST /api/tokens/purchase
 * Initie un achat de jetons
 */
router.post('/purchase',
    authenticateToken,
    paymentLimiter,
    [
        body('packId').isIn(['pack_10', 'pack_25', 'pack_50', 'pack_100']),
        body('txHash')
            .optional()
            .matches(/^0x[a-fA-F0-9]{64}$/)
            .withMessage('Hash de transaction invalide')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    errors: errors.array()
                });
            }

            const { packId, txHash } = req.body;

            // Définir les packs
            const packs = {
                'pack_10': { tokens: 10, price: '500000000000000000' },
                'pack_25': { tokens: 25, price: '1000000000000000000' },
                'pack_50': { tokens: 50, price: '1800000000000000000' },
                'pack_100': { tokens: 100, price: '3000000000000000000' }
            };

            const pack = packs[packId];

            // Créer la transaction en attente
            const transactionId = uuidv4();
            transactions.create.run(
                transactionId,
                req.user.id,
                'purchase',
                pack.tokens,
                txHash || null,
                txHash ? 'pending_verification' : 'awaiting_payment'
            );

            // Si un txHash est fourni, vérifier la transaction
            if (txHash) {
                // Vérifier que le hash n'a pas déjà été utilisé
                const existingTx = transactions.findByTxHash.get(txHash);
                if (existingTx && existingTx.id !== transactionId) {
                    return res.status(409).json({
                        success: false,
                        error: 'Cette transaction a déjà été utilisée'
                    });
                }

                // TODO: Vérifier la transaction sur la blockchain
                // Pour l'instant, on simule une vérification réussie
                const isValid = await verifyTransaction(txHash, pack.price);
                
                if (isValid) {
                    // Ajouter les jetons
                    users.updateTokens.run(pack.tokens, req.user.id);
                    transactions.updateStatus.run('completed', transactionId);

                    const user = users.findById.get(req.user.id);

                    console.log(`💰 Achat: ${req.user.username} +${pack.tokens} jetons`);

                    return res.json({
                        success: true,
                        message: `${pack.tokens} jetons ajoutés à votre compte`,
                        data: {
                            transactionId,
                            tokensAdded: pack.tokens,
                            newBalance: user.tokens
                        }
                    });
                } else {
                    transactions.updateStatus.run('failed', transactionId);
                    return res.status(400).json({
                        success: false,
                        error: 'Transaction non valide ou montant incorrect'
                    });
                }
            }

            // Retourner les infos pour le paiement
            res.json({
                success: true,
                data: {
                    transactionId,
                    pack: {
                        id: packId,
                        tokens: pack.tokens,
                        priceWei: pack.price
                    },
                    paymentAddress: config.crypto.walletAddress,
                    network: 'Polygon (MATIC)',
                    instructions: 'Envoyez le montant exact à l\'adresse indiquée, puis soumettez le hash de transaction'
                }
            });

        } catch (error) {
            console.error('Erreur purchase:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur lors de l\'achat'
            });
        }
    }
);

/**
 * POST /api/tokens/verify
 * Vérifie une transaction et crédite les jetons
 */
router.post('/verify',
    authenticateToken,
    paymentLimiter,
    [
        body('transactionId').isUUID(),
        body('txHash').matches(/^0x[a-fA-F0-9]{64}$/)
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    errors: errors.array()
                });
            }

            const { transactionId, txHash } = req.body;

            // Trouver la transaction par transactionId (sécurisé)
            const tx = transactions.findById.get(transactionId);
            
            if (!tx) {
                return res.status(404).json({
                    success: false,
                    error: 'Transaction non trouvée'
                });
            }

            // Vérifier que la transaction appartient à l'utilisateur (protection IDOR)
            if (tx.user_id !== req.user.id) {
                return res.status(403).json({
                    success: false,
                    error: 'Accès non autorisé à cette transaction'
                });
            }

            // Vérifier que le txHash correspond
            if (tx.tx_hash !== txHash) {
                return res.status(400).json({
                    success: false,
                    error: 'Le hash de transaction ne correspond pas'
                });
            }
            
            if (tx.status === 'completed') {
                return res.status(409).json({
                    success: false,
                    error: 'Cette transaction a déjà été traitée'
                });
            }

            // TODO: Vérification blockchain réelle
            const isValid = await verifyTransaction(txHash, '1000000000000000000');
            
            if (isValid) {
                // Créditer les jetons selon le montant de la transaction
                users.updateTokens.run(tx.amount, req.user.id);
                transactions.updateStatus.run('completed', transactionId);
                
                const user = users.findById.get(req.user.id);

                res.json({
                    success: true,
                    message: 'Transaction vérifiée, jetons ajoutés',
                    data: {
                        tokensAdded: tx.amount,
                        newBalance: user.tokens
                    }
                });
            } else {
                transactions.updateStatus.run('failed', transactionId);
                res.status(400).json({
                    success: false,
                    error: 'Transaction non valide ou montant incorrect'
                });
            }

        } catch (error) {
            console.error('Erreur verify:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur lors de la vérification'
            });
        }
    }
);

/**
 * GET /api/tokens/transactions
 * Récupère l'historique des transactions
 */
router.get('/transactions', authenticateToken, (req, res) => {
    try {
        const userTransactions = transactions.findByUser.all(req.user.id);

        res.json({
            success: true,
            data: userTransactions.map(tx => ({
                id: tx.id,
                type: tx.type,
                amount: tx.amount,
                status: tx.status,
                txHash: tx.tx_hash,
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
 * POST /api/tokens/gift (Demo)
 * Ajoute des jetons gratuits (limité à 1 fois par jour)
 */
router.post('/gift',
    authenticateToken,
    [
        body('amount')
            .optional()
            .isInt({ min: 1, max: 10 })
            .withMessage('Amount must be between 1 and 10')
    ],
    (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    error: errors.array()[0].msg
                });
            }

            const user = users.findById.get(req.user.id);
            
            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'Utilisateur non trouvé'
                });
            }

            // Validation et parsing sécurisé du montant
            const amount = req.body.amount ? parseInt(req.body.amount) : 5;
            if (isNaN(amount) || amount < 1 || amount > 10) {
                return res.status(400).json({
                    success: false,
                    error: 'Montant invalide (doit être entre 1 et 10)'
                });
            }

            const tokensToAdd = Math.min(amount, 10); // Max 10 en gift

            // Opération atomique : vérifie ET met à jour en une seule requête (protection race condition)
            const result = queries.users.claimGiftAtomic.run(tokensToAdd, req.user.id);
            
            // Si aucune ligne n'a été modifiée, c'est que le gift a déjà été utilisé aujourd'hui
            if (result.changes === 0) {
                return res.status(429).json({
                    success: false,
                    error: 'Vous avez déjà utilisé le gift aujourd\'hui. Réessayez demain.'
                });
            }
            
            const updatedUser = users.findById.get(req.user.id);

            console.log(`🎁 Gift: ${req.user.username} +${tokensToAdd} jetons`);

            res.json({
                success: true,
                message: `${tokensToAdd} jetons offerts !`,
                data: {
                    tokensAdded: tokensToAdd,
                    newBalance: updatedUser.tokens
                }
            });

        } catch (error) {
            console.error('Erreur gift:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur lors du gift'
            });
        }
    }
);

// ══════════════════════════════════════════════════════════
// BTCPAY SERVER - Paiement crypto automatisé
// ══════════════════════════════════════════════════════════

/**
 * POST /api/tokens/btcpay/create
 * Crée une invoice BTCPay pour un pack de jetons
 *
 * Flux de sécurité :
 * 1. Authentification JWT requise
 * 2. Validation du pack
 * 3. Création invoice BTCPay (ou simulée en mode démo)
 * 4. Transaction 'pending' enregistrée en DB (invoice_id = tx_hash)
 * 5. Le webhook BTCPay (vérifié HMAC) crédite ensuite les jetons
 */
router.post('/btcpay/create',
    authenticateToken,
    paymentLimiter,
    [
        body('packId').isIn(['pack_10', 'pack_25', 'pack_50', 'pack_100'])
            .withMessage('Pack invalide')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    error: errors.array()[0].msg
                });
            }

            const { packId } = req.body;
            const pack = PACK_EUR_PRICES[packId];

            const transactionId = uuidv4();

            // Créer la facture BTCPay
            const invoice = await btcpay.createInvoice({
                amount: pack.eur,
                currency: 'EUR',
                orderId: transactionId,
                metadata: {
                    userId: req.user.id,
                    username: req.user.username,
                    packId,
                    tokens: pack.tokens
                }
            });

            // Enregistrer la transaction en attente (tx_hash = invoice ID BTCPay)
            queries.transactions.create.run(
                transactionId,
                req.user.id,
                'purchase',
                pack.tokens,
                invoice.id,  // Stocké dans tx_hash pour retrouver via findByTxHash
                'pending'
            );

            console.log(`⚡ BTCPay: ${req.user.username} → ${pack.tokens} jetons, invoice ${invoice.id}`);

            res.json({
                success: true,
                data: {
                    transactionId,
                    invoiceId: invoice.id,
                    checkoutLink: invoice.checkoutLink,
                    isDemo: invoice.isDemo,
                    amount: pack.eur,
                    currency: 'EUR',
                    tokens: pack.tokens,
                    message: invoice.isDemo
                        ? 'Mode démo : paiement simulé (configurez BTCPAY_SERVER_URL pour le mode réel)'
                        : 'Facture créée. Cliquez sur le lien pour payer.'
                }
            });

        } catch (error) {
            console.error('❌ BTCPay create error:', error);
            res.status(500).json({
                success: false,
                error: error.message || 'Impossible de créer la facture BTCPay'
            });
        }
    }
);

/**
 * GET /api/tokens/btcpay/status/:invoiceId
 * Vérifie le statut d'une invoice et crédite les jetons si payée
 *
 * Appelé par le frontend en polling (toutes les 3 secondes).
 * En mode production, le webhook HMAC est le mécanisme primaire —
 * ce polling est une sécurité supplémentaire.
 */
router.get('/btcpay/status/:invoiceId',
    authenticateToken,
    [
        param('invoiceId').isLength({ min: 5, max: 100 }).trim()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ success: false, error: 'Invoice ID invalide' });
            }

            const { invoiceId } = req.params;

            // Trouver la transaction associée à cette invoice
            const tx = queries.transactions.findByTxHash.get(invoiceId);

            if (!tx) {
                return res.status(404).json({
                    success: false,
                    error: 'Transaction non trouvée pour cette invoice'
                });
            }

            // Vérifier que la transaction appartient à l'utilisateur (protection IDOR)
            if (tx.user_id !== req.user.id) {
                return res.status(403).json({
                    success: false,
                    error: 'Accès non autorisé'
                });
            }

            // Si déjà complétée (webhook l'a déjà traitée)
            if (tx.status === 'completed') {
                const user = queries.users.findById.get(req.user.id);
                return res.json({
                    success: true,
                    data: {
                        status: 'Settled',
                        alreadyCredited: true,
                        newBalance: user.tokens
                    }
                });
            }

            // Vérifier le statut sur BTCPay
            const invoiceStatus = await btcpay.getInvoiceStatus(invoiceId);

            let newBalance = null;

            // Si paiement confirmé → créditer les jetons
            if (invoiceStatus.status === 'Settled' && tx.status === 'pending') {
                queries.users.updateTokens.run(tx.amount, req.user.id);
                queries.transactions.updateStatus.run('completed', tx.id);

                const user = queries.users.findById.get(req.user.id);
                newBalance = user.tokens;

                console.log(`✅ BTCPay: ${req.user.username} +${tx.amount} jetons (invoice ${invoiceId})`);
            }

            // Si expirée ou invalide
            if (['Expired', 'Invalid'].includes(invoiceStatus.status) && tx.status === 'pending') {
                queries.transactions.updateStatus.run('failed', tx.id);
            }

            res.json({
                success: true,
                data: {
                    status: invoiceStatus.status,
                    isDemo: invoiceStatus.isDemo,
                    newBalance,
                    tokens: tx.amount
                }
            });

        } catch (error) {
            console.error('❌ BTCPay status error:', error);
            res.status(500).json({
                success: false,
                error: error.message || 'Impossible de vérifier le statut'
            });
        }
    }
);

/**
 * Gestionnaire de webhook BTCPay
 * Exporté pour être monté dans server.js AVANT la protection CSRF
 * (le webhook vient de BTCPay, pas d'un navigateur)
 *
 * SÉCURITÉ : Authentification par signature HMAC-SHA256
 * Seul BTCPay Server peut générer une signature valide.
 */
const handleBTCPayWebhook = async (req, res) => {
    try {
        const signature = req.headers['btcpay-sig'];
        const rawBody = req.rawBody; // Sauvegardé par express.json({ verify: ... })

        // Vérifier la signature HMAC-SHA256
        if (!btcpay.verifyWebhookSignature(rawBody, signature)) {
            console.warn('⚠️ BTCPay webhook: signature invalide - requête rejetée');
            return res.status(401).json({ success: false, error: 'Signature invalide' });
        }

        const event = req.body;

        console.log(`⚡ BTCPay webhook reçu: type=${event.type}, invoice=${event.invoiceId}`);

        // Traiter uniquement les paiements confirmés
        if (event.type === 'InvoiceSettled') {
            const invoiceId = event.invoiceId;
            const tx = queries.transactions.findByTxHash.get(invoiceId);

            if (tx && tx.status === 'pending') {
                queries.users.updateTokens.run(tx.amount, tx.user_id);
                queries.transactions.updateStatus.run('completed', tx.id);
                console.log(`✅ BTCPay webhook: +${tx.amount} jetons pour user ${tx.user_id}`);
            } else if (tx && tx.status === 'completed') {
                console.log(`ℹ️  BTCPay webhook: invoice ${invoiceId} déjà traitée`);
            } else {
                console.warn(`⚠️ BTCPay webhook: invoice ${invoiceId} introuvable en DB`);
            }
        }

        if (event.type === 'InvoiceExpired' || event.type === 'InvoiceInvalid') {
            const tx = queries.transactions.findByTxHash.get(event.invoiceId);
            if (tx && tx.status === 'pending') {
                queries.transactions.updateStatus.run('failed', tx.id);
                console.log(`❌ BTCPay webhook: invoice ${event.invoiceId} ${event.type}`);
            }
        }

        res.json({ success: true });

    } catch (error) {
        console.error('❌ BTCPay webhook error:', error);
        res.status(500).json({ success: false, error: 'Erreur traitement webhook' });
    }
};

/**
 * Vérifie une transaction sur la blockchain
 * TODO: Implémenter la vérification réelle avec ethers.js
 */
async function verifyTransaction(txHash, expectedAmount) {
    // En mode développement, on accepte toutes les transactions
    if (config.isDev) {
        console.log(`⚠️ Mode dev: Transaction ${txHash} auto-validée`);
        return true;
    }

    // TODO: Vérification réelle
    // const provider = new ethers.JsonRpcProvider(config.crypto.networkRpc);
    // const tx = await provider.getTransaction(txHash);
    // return tx && tx.to === config.crypto.walletAddress && tx.value >= expectedAmount;

    return false;
}

module.exports = router;
module.exports.handleBTCPayWebhook = handleBTCPayWebhook;
