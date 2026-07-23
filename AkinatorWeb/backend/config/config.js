/**
 * Configuration centralisée de l'application
 * Charge les variables d'environnement de manière sécurisée
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

require('dotenv').config();

// Validation des variables requises
const requiredEnvVars = ['JWT_SECRET'];
const optionalEnvVars = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'];

for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`❌ Variable d'environnement manquante: ${envVar}`);
        console.error('Copiez env.example.txt vers .env et remplissez les valeurs');
        process.exit(1);
    }
}

// Avertissement pour les variables optionnelles
for (const envVar of optionalEnvVars) {
    if (!process.env[envVar]) {
        console.warn(`⚠️ Variable optionnelle manquante: ${envVar} - L'API IGDB ne fonctionnera pas`);
    }
}

module.exports = {
    // Serveur
    port: parseInt(process.env.PORT) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    isDev: process.env.NODE_ENV !== 'production',
    isTest: process.env.NODE_ENV === 'test',

    // JWT
    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: '15m',
        algorithm: 'HS256'
    },

    // Twitch/IGDB
    twitch: {
        clientId: process.env.TWITCH_CLIENT_ID,
        clientSecret: process.env.TWITCH_CLIENT_SECRET,
        tokenUrl: 'https://id.twitch.tv/oauth2/token',
        igdbUrl: 'https://api.igdb.com/v4'
    },

    // Base de données
    database: {
        path: process.env.DATABASE_PATH || './data/akinator.db'
    },

    // Sécurité
    security: {
        rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
        rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || ((process.env.NODE_ENV !== 'production') ? 200 : 100),
        bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS) || 12
    },

    // CORS
    cors: {
        origin: process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? false : '*'),
        credentials: true
    }
};
