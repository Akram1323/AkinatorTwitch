/**
 * API Client - Communication avec le backend
 * Gestion des requêtes HTTP sécurisées
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const API = {
    baseUrl: '/api',
    csrfToken: null,
    // Refresh en vol partagé : évite que plusieurs requêtes en 401
    // simultanées déclenchent chacune un /auth/refresh (le refresh token
    // tourne à chaque appel ; un 2e appel avec le même cookie serait
    // détecté comme réutilisation et révoquerait toute la famille).
    refreshPromise: null,

    /**
     * Appelé après un login/register/verify-a2f réussi : la session vit
     * désormais dans les cookies httpOnly, il ne reste qu'à récupérer le
     * token CSRF pour les futures requêtes mutantes.
     */
    async onLogin() {
        await this.refreshCSRFToken();
    },

    /**
     * Au chargement de la page : tente de restaurer la session depuis les
     * cookies httpOnly (aucun token n'est stocké côté client).
     * Retourne l'utilisateur si une session est active, sinon null.
     */
    async bootstrapSession() {
        try {
            const response = await this.get('/auth/me');
            if (response.success) {
                await this.refreshCSRFToken();
                return response.data;
            }
        } catch (error) { /* pas de session active */ }
        return null;
    },

    /**
     * Rafraîchit la session (access token) via le refresh token httpOnly.
     * Single-flight : si un refresh est déjà en cours, on réutilise la
     * même promesse au lieu de déclencher un second appel réseau, sinon
     * le refresh token (à usage unique, rotatif) serait détecté comme
     * réutilisé et la famille entière de tokens serait révoquée.
     * Retourne true si le refresh a réussi, false sinon.
     */
    async refreshSession() {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        this.refreshPromise = fetch(`${this.baseUrl}/auth/refresh`, {
            method: 'POST',
            credentials: 'same-origin'
        })
            .then(response => response.ok)
            .catch(() => false)
            .finally(() => {
                this.refreshPromise = null;
            });

        return this.refreshPromise;
    },

    /**
     * Un échec est-il imputable au token CSRF (manquant, invalide ou expiré) ?
     * Le serveur répond 403 avec un message contenant « CSRF » dans les trois cas
     * (cf. backend/middleware/csrf.js).
     */
    isCsrfFailure(status, data) {
        return status === 403 && !!data && typeof data.error === 'string' && /csrf/i.test(data.error);
    },

    /**
     * Récupère un nouveau token CSRF
     */
    async refreshCSRFToken() {
        try {
            const response = await this.get('/csrf-token');
            if (response.success) {
                this.csrfToken = response.data.csrfToken;
            }
        } catch (error) {
            console.warn('⚠️ Impossible de récupérer le token CSRF:', error);
        }
    },

    /**
     * Effectue une requête HTTP
     */
    async request(endpoint, options = {}, isRetry = false) {
        const url = `${this.baseUrl}${endpoint}`;

        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };

        // Ajouter le token CSRF pour les méthodes mutantes
        if (this.csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method || 'GET')) {
            headers['X-CSRF-Token'] = this.csrfToken;
        }

        try {
            const response = await fetch(url, {
                ...options,
                headers,
                credentials: 'same-origin' // cookies httpOnly
            });

            // Access token expiré → tenter un refresh silencieux puis rejouer une fois.
            // Le refresh est mutualisé (single-flight) : plusieurs requêtes en 401
            // en même temps attendent toutes le même appel /auth/refresh au lieu
            // d'en déclencher chacune un, ce qui casserait la rotation des tokens.
            if (response.status === 401 && !isRetry && endpoint !== '/auth/refresh' && endpoint !== '/auth/login') {
                const refreshed = await this.refreshSession();
                if (refreshed) {
                    return this.request(endpoint, options, true);
                }
            }

            let data = null;
            try {
                data = await response.json();
            } catch (jsonError) {
                // Réponse non-JSON : le corps est déjà consommé, on ne peut pas le relire
                console.error(`Réponse non-JSON de ${endpoint} (${response.status})`);
            }

            // Token CSRF expiré (durée de vie 60 min, bien plus courte que la session
            // qui se renouvelle indéfiniment) → en redemander un et rejouer une fois.
            // Sans cela, un onglet laissé ouvert plus d'une heure voit toutes ses
            // actions mutantes échouer jusqu'au rechargement complet de la page.
            if (this.isCsrfFailure(response.status, data) && !isRetry) {
                await this.refreshCSRFToken();
                return this.request(endpoint, options, true);
            }

            if (!response.ok) {
                throw new Error((data && data.error) || `Erreur ${response.status}`);
            }

            if (data === null) {
                throw new Error(`Erreur serveur (${response.status}): Réponse invalide`);
            }

            return data;
        } catch (error) {
            console.error(`API Error [${endpoint}]:`, error);
            throw error;
        }
    },

    /**
     * GET request
     */
    async get(endpoint) {
        return this.request(endpoint, { method: 'GET' });
    },

    /**
     * POST request
     */
    async post(endpoint, body) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    },

    // ══════════════════════════════════════════════════════════
    // AUTH
    // ══════════════════════════════════════════════════════════

    async register(username, password, rgpdConsent = true) {
        const response = await this.post('/auth/register', { username, password, rgpdConsent });
        if (response.success) {
            await this.onLogin();
        }
        return response;
    },

    async login(username, password) {
        const response = await this.post('/auth/login', { username, password });
        if (response.success && !response.requiresA2F) {
            await this.onLogin();
        }
        return response;
    },

    async getProfile() {
        return this.get('/auth/me');
    },

    async logout() {
        try {
            await this.post('/auth/logout', {});
        } catch (e) { /* non bloquant */ }
        this.csrfToken = null;
    },

    async changePassword(currentPassword, newPassword, a2fCode) {
        return this.post('/auth/change-password', { currentPassword, newPassword, a2fCode });
    },

    async forgotPassword(username, a2fCode, newPassword) {
        return this.post('/auth/forgot-password', { username, a2fCode, newPassword });
    },

    async verifyLoginA2F(code, tempToken) {
        // Le token temporaire A2F est court et mono-usage : il continue de
        // transiter via le header Authorization (backend inchangé sur ce point).
        const response = await this.request('/auth/verify-login-a2f', {
            method: 'POST',
            body: JSON.stringify({ code }),
            headers: { 'Authorization': `Bearer ${tempToken}` }
        });
        if (response.success) {
            await this.onLogin();
        }
        return response;
    },

    // ══════════════════════════════════════════════════════════
    // A2F
    // ══════════════════════════════════════════════════════════

    async setupA2F() {
        return this.post('/a2f/setup', {});
    },

    async verifyA2FSetup(code) {
        return this.post('/a2f/verify-setup', { code });
    },

    async getA2FStatus() {
        return this.get('/a2f/status');
    },

    async disableA2F(code, password) {
        return this.post('/a2f/disable', { code, password });
    },

    // ══════════════════════════════════════════════════════════
    // AVATAR
    // ══════════════════════════════════════════════════════════

    // L'upload passe en multipart : il ne peut pas emprunter request() (qui force
    // un Content-Type JSON), d'où ce chemin dédié — avec le même rejeu sur token
    // CSRF expiré, sinon un onglet ouvert depuis plus d'une heure ne peut plus
    // changer d'avatar.
    async uploadAvatar(file, isRetry = false) {
        const formData = new FormData();
        formData.append('avatar', file);

        const url = `${this.baseUrl}/avatar/upload`;
        const headers = {};

        if (this.csrfToken) {
            headers['X-CSRF-Token'] = this.csrfToken;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: formData,
            credentials: 'same-origin'
        });

        let data = null;
        try {
            data = await response.json();
        } catch (jsonError) {
            console.error(`Réponse non-JSON de /avatar/upload (${response.status})`);
        }

        if (this.isCsrfFailure(response.status, data) && !isRetry) {
            await this.refreshCSRFToken();
            return this.uploadAvatar(file, true);
        }

        if (!response.ok) {
            throw new Error((data && data.error) || `Erreur ${response.status}`);
        }

        return data;
    },

    async deleteAvatar() {
        return this.request('/avatar', { method: 'DELETE' });
    },

    // ══════════════════════════════════════════════════════════
    // GAME
    // ══════════════════════════════════════════════════════════

    async getTree() {
        return this.get('/game/tree');
    },

    async getNodeChildren(nodeId) {
        return this.get(`/game/node/${nodeId}/children`);
    },

    async startGame() {
        return this.post('/game/start', {});
    },

    async choose(gameId, nodeId, currentFilters) {
        return this.post('/game/choose', { gameId, nodeId, currentFilters });
    },

    async getRecommendations(gameId, filters) {
        return this.post('/game/recommend', { gameId, filters });
    },

    async getHistory() {
        return this.get('/game/history');
    },

    // ══════════════════════════════════════════════════════════
    // TOKENS
    // ══════════════════════════════════════════════════════════

    async getTokenBalance() {
        return this.get('/tokens/balance');
    },

    async getTransactions() {
        return this.get('/tokens/transactions');
    },

    // Même robinet quotidien que claimDaily() : 3 jetons, aucun montant à envoyer
    async claimGift() {
        return this.post('/tokens/gift', {});
    },

    async claimDaily() {
        return this.post('/auth/claim-daily', {});
    },

    // ══════════════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════════════

    async getAdminStats() {
        return this.get('/admin/stats');
    },

    async getAdminUsers(page = 1, limit = 20) {
        return this.get(`/admin/users?page=${page}&limit=${limit}`);
    },

    async getAdminUser(userId) {
        return this.get(`/admin/users/${userId}`);
    },

    async deleteAdminUser(userId) {
        return this.request(`/admin/users/${userId}`, { method: 'DELETE' });
    },

    async promoteUser(userId) {
        return this.post(`/admin/users/${userId}/promote`, {});
    },

    async demoteUser(userId) {
        return this.post(`/admin/users/${userId}/demote`, {});
    },

    async setUserTokens(userId, action, amount, reason) {
        return this.post(`/admin/users/${userId}/tokens`, { action, amount, reason });
    },

    async getAuditEntries(eventType, limit = 50) {
        const params = new URLSearchParams({ limit });
        if (eventType) params.set('event_type', eventType);
        return this.get(`/admin/audit?${params.toString()}`);
    },

    async cleanupIPs() {
        return this.get('/admin/cleanup-ips');
    },

    async getLeaderboard() {
        return this.get('/game/leaderboard');
    },

    // ══════════════════════════════════════════════════════════
    // HEALTH
    // ══════════════════════════════════════════════════════════

    async healthCheck() {
        return this.get('/health');
    }
};
