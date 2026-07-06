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

            // Access token expiré → tenter un refresh silencieux puis rejouer une fois
            if (response.status === 401 && !isRetry && endpoint !== '/auth/refresh' && endpoint !== '/auth/login') {
                const refreshed = await fetch(`${this.baseUrl}/auth/refresh`, {
                    method: 'POST',
                    credentials: 'same-origin'
                });
                if (refreshed.ok) {
                    return this.request(endpoint, options, true);
                }
            }

            let data;
            try {
                data = await response.json();
            } catch (jsonError) {
                // Si la réponse n'est pas du JSON valide, créer un objet d'erreur
                const text = await response.text();
                console.error(`Réponse non-JSON de ${endpoint}:`, text.substring(0, 200));
                throw new Error(`Erreur serveur (${response.status}): Réponse invalide`);
            }

            if (!response.ok) {
                throw new Error(data.error || `Erreur ${response.status}`);
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

    async linkWallet(walletAddress) {
        return this.post('/auth/link-wallet', { walletAddress });
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

    async uploadAvatar(file) {
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

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `Erreur ${response.status}`);
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

    async getTokenPrices() {
        return this.get('/tokens/prices');
    },

    async purchaseTokens(packId, txHash = null) {
        return this.post('/tokens/purchase', { packId, txHash });
    },

    async verifyTransaction(transactionId, txHash) {
        return this.post('/tokens/verify', { transactionId, txHash });
    },

    async getTransactions() {
        return this.get('/tokens/transactions');
    },

    async claimGift() {
        return this.post('/tokens/gift', { amount: 5 });
    },

    async createBTCPayInvoice(packId) {
        return this.post('/tokens/btcpay/create', { packId });
    },

    async getBTCPayStatus(invoiceId) {
        return this.get(`/tokens/btcpay/status/${encodeURIComponent(invoiceId)}`);
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

    async cleanupIPs() {
        return this.get('/admin/cleanup-ips');
    },

    async getPendingTransactions() {
        return this.get('/admin/transactions/pending');
    },

    async approveTransaction(txId) {
        return this.post(`/admin/transactions/${txId}/approve`, {});
    },

    async rejectTransaction(txId) {
        return this.post(`/admin/transactions/${txId}/reject`, {});
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
