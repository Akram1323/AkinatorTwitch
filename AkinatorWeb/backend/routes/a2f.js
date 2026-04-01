/**
 * Routes A2F (Authentification à 2 Facteurs)
 * Implémentation TOTP (Time-based One-Time Password)
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/security');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { db, queries } = require('../services/database');

/**
 * POST /api/a2f/setup
 * Génère un secret A2F et le QR code
 */
router.post('/setup', authenticateToken, async (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
        }

        // Vérifier si A2F déjà activé
        if (user.a2f_enabled) {
            return res.status(400).json({ 
                success: false, 
                error: 'A2F déjà activé. Désactivez-le d\'abord.' 
            });
        }

        // Générer un nouveau secret avec speakeasy
        const secretObj = speakeasy.generateSecret({
            name: `AkinatorTwitch:${user.username}`,
            issuer: 'AkinatorTwitch',
            length: 20
        });
        
        const secret = secretObj.base32;
        
        // Stocker temporairement le secret (non activé)
        const updateStmt = db.prepare(
            'UPDATE users SET a2f_secret = ?, a2f_enabled = 0 WHERE id = ?'
        );
        updateStmt.run(secret, user.id);

        // Générer le QR code en base64
        const qrCodeDataUrl = await QRCode.toDataURL(secretObj.otpauth_url, {
            width: 200,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        });

        console.log(`🔐 A2F setup initié: ${user.username}`);

        res.json({
            success: true,
            data: {
                qrCode: qrCodeDataUrl,
                // Secret non exposé pour sécurité (utiliser uniquement le QR code)
                otpauthUrl: secretObj.otpauth_url
            }
        });

    } catch (error) {
        console.error('Erreur A2F setup:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de la configuration A2F' });
    }
});

/**
 * POST /api/a2f/verify-setup
 * Vérifie le code A2F et active l'A2F
 */
router.post('/verify-setup', authenticateToken, async (req, res) => {
    try {
        const { code } = req.body;

        if (!code || code.length !== 6) {
            return res.status(400).json({ success: false, error: 'Code invalide (6 chiffres)' });
        }

        const user = queries.users.findById.get(req.user.id);
        if (!user || !user.a2f_secret) {
            return res.status(400).json({ success: false, error: 'Aucun secret A2F configuré' });
        }

        // Vérifier le code avec speakeasy
        const isValid = speakeasy.totp.verify({
            secret: user.a2f_secret,
            encoding: 'base32',
            token: code,
            window: 1
        });

        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Code incorrect' });
        }

        // Activer l'A2F
        const updateStmt = db.prepare(
            'UPDATE users SET a2f_enabled = 1 WHERE id = ?'
        );
        updateStmt.run(user.id);

        console.log(`✅ A2F activé: ${user.username}`);

        res.json({
            success: true,
            message: 'A2F activé avec succès'
        });

    } catch (error) {
        console.error('Erreur verify-setup:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de l\'activation A2F' });
    }
});

/**
 * POST /api/a2f/verify
 * Vérifie un code A2F (pour la connexion)
 * SÉCURISÉ : Utilise req.user.id du token JWT pour éviter IDOR
 */
router.post('/verify', authenticateToken, async (req, res) => {
    try {
        const { code } = req.body;

        if (!code || code.length !== 6) {
            return res.status(400).json({ success: false, error: 'Code invalide (6 chiffres)' });
        }

        // Utiliser req.user.id du token JWT (sécurisé contre IDOR)
        const user = queries.users.findById.get(req.user.id);
        if (!user || !user.a2f_enabled || !user.a2f_secret) {
            return res.status(400).json({ success: false, error: 'A2F non configuré' });
        }

        const isValid = speakeasy.totp.verify({
            secret: user.a2f_secret,
            encoding: 'base32',
            token: code,
            window: 1
        });

        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Code A2F incorrect' });
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Erreur A2F verify:', error);
        res.status(500).json({ success: false, error: 'Erreur de vérification' });
    }
});

/**
 * POST /api/a2f/disable
 * Désactive l'A2F
 */
router.post('/disable', authenticateToken, async (req, res) => {
    try {
        const { code, password } = req.body;
        const bcrypt = require('bcrypt');

        const user = queries.users.findById.get(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
        }

        // Vérifier le mot de passe
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ success: false, error: 'Mot de passe incorrect' });
        }

        // Vérifier le code A2F actuel
        if (user.a2f_enabled && user.a2f_secret) {
            const isValid = speakeasy.totp.verify({
                secret: user.a2f_secret,
                encoding: 'base32',
                token: code,
                window: 1
            });

            if (!isValid) {
                return res.status(401).json({ success: false, error: 'Code A2F incorrect' });
            }
        }

        // Désactiver l'A2F
        const updateStmt = db.prepare(
            'UPDATE users SET a2f_enabled = 0, a2f_secret = NULL WHERE id = ?'
        );
        updateStmt.run(user.id);

        console.log(`🔓 A2F désactivé: ${user.username}`);

        res.json({
            success: true,
            message: 'A2F désactivé'
        });

    } catch (error) {
        console.error('Erreur A2F disable:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de la désactivation' });
    }
});

/**
 * GET /api/a2f/status
 * Vérifie le statut A2F de l'utilisateur
 */
router.get('/status', authenticateToken, (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
        }

        res.json({
            success: true,
            data: {
                enabled: user.a2f_enabled === 1
            }
        });

    } catch (error) {
        console.error('Erreur A2F status:', error);
        res.status(500).json({ success: false, error: 'Erreur' });
    }
});

module.exports = router;
