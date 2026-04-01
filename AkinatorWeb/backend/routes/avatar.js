/**
 * Routes Avatar
 * Upload sécurisé de photos de profil (protection anti-RCE)
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/security');
const { db, queries } = require('../services/database');

// Configuration du dossier avatars
const AVATARS_DIR = path.join(__dirname, '../../frontend/avatars');
if (!fs.existsSync(AVATARS_DIR)) {
    fs.mkdirSync(AVATARS_DIR, { recursive: true });
}

// Configuration Multer (stockage en mémoire pour validation)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5 MB max
        files: 1
    },
    fileFilter: (req, file, cb) => {
        // Validation STRICTE du type MIME
        const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
        
        if (!allowedMimes.includes(file.mimetype)) {
            return cb(new Error('Format non autorisé. Utilisez JPEG, PNG ou WebP.'), false);
        }
        
        // Validation de l'extension
        const ext = path.extname(file.originalname).toLowerCase();
        const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];
        
        if (!allowedExts.includes(ext)) {
            return cb(new Error('Extension non autorisée.'), false);
        }
        
        cb(null, true);
    }
});

/**
 * Valide qu'un buffer est vraiment une image
 * Protection contre les fichiers déguisés (ex: PHP avec extension .jpg)
 */
async function validateImageBuffer(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        
        // Vérifier que c'est un format d'image valide
        const validFormats = ['jpeg', 'png', 'webp', 'gif'];
        if (!validFormats.includes(metadata.format)) {
            return { valid: false, error: 'Format d\'image non reconnu' };
        }
        
        // Vérifier les dimensions raisonnables
        if (metadata.width > 4096 || metadata.height > 4096) {
            return { valid: false, error: 'Image trop grande (max 4096x4096)' };
        }
        
        if (metadata.width < 10 || metadata.height < 10) {
            return { valid: false, error: 'Image trop petite' };
        }
        
        return { valid: true, metadata };
        
    } catch (error) {
        return { valid: false, error: 'Fichier corrompu ou non-image' };
    }
}

/**
 * POST /api/avatar/upload
 * Upload et traitement sécurisé de l'avatar
 */
router.post('/upload', authenticateToken, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                error: 'Aucun fichier fourni' 
            });
        }

        // Validation approfondie du contenu
        const validation = await validateImageBuffer(req.file.buffer);
        if (!validation.valid) {
            console.warn(`⚠️ Tentative d'upload malveillant: ${validation.error}`);
            return res.status(400).json({ 
                success: false, 
                error: validation.error 
            });
        }

        // Générer un nom de fichier unique et sécurisé
        const fileHash = crypto.randomBytes(16).toString('hex');
        const filename = `${req.user.id}_${fileHash}.webp`;
        const filepath = path.join(AVATARS_DIR, filename);

        // Traitement de l'image avec Sharp
        // - Conversion en WebP (plus léger, moderne)
        // - Redimensionnement à 256x256 max
        // - Suppression des métadonnées EXIF (vie privée)
        await sharp(req.file.buffer)
            .resize(256, 256, {
                fit: 'cover',
                position: 'center'
            })
            .webp({ quality: 85 })
            .toFile(filepath);

        // Supprimer l'ancien avatar si existe
        const user = queries.users.findById.get(req.user.id);
        if (user && user.avatar_url) {
            const oldFilename = user.avatar_url.replace('avatars/', '');
            const oldPath = path.join(AVATARS_DIR, oldFilename);
            if (fs.existsSync(oldPath)) {
                fs.unlinkSync(oldPath);
            }
        }

        // Mettre à jour en base
        const avatarUrl = `avatars/${filename}`;
        const updateStmt = db.prepare(
            'UPDATE users SET avatar_url = ? WHERE id = ?'
        );
        updateStmt.run(avatarUrl, req.user.id);

        console.log(`📷 Avatar mis à jour: ${user.username}`);

        res.json({
            success: true,
            data: {
                avatarUrl: avatarUrl
            }
        });

    } catch (error) {
        console.error('Erreur upload avatar:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Erreur lors de l\'upload' 
        });
    }
});

/**
 * DELETE /api/avatar
 * Supprime l'avatar actuel
 */
router.delete('/', authenticateToken, async (req, res) => {
    try {
        const user = queries.users.findById.get(req.user.id);
        
        if (user && user.avatar_url) {
            const filename = user.avatar_url.replace('avatars/', '');
            const filepath = path.join(AVATARS_DIR, filename);
            
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
        }

        const updateStmt = db.prepare(
            'UPDATE users SET avatar_url = NULL WHERE id = ?'
        );
        updateStmt.run(req.user.id);

        res.json({ success: true });

    } catch (error) {
        console.error('Erreur suppression avatar:', error);
        res.status(500).json({ success: false, error: 'Erreur' });
    }
});

// Gestion des erreurs Multer
router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ 
                success: false, 
                error: 'Fichier trop volumineux (max 5 MB)' 
            });
        }
    }
    
    if (error.message) {
        return res.status(400).json({ 
            success: false, 
            error: error.message 
        });
    }
    
    next(error);
});

module.exports = router;
