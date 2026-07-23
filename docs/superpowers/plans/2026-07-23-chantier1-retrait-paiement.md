# Chantier 1 — Retrait du paiement + attribution admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supprimer tout moyen de paiement (BTCPay + crypto manuel) ; l'attribution de crédits par un admin (avec raison obligatoire) devient l'unique voie d'entrée de jetons hors gift quotidien.

**Architecture:** Backend Express (`AkinatorWeb/backend`) + frontend vanilla JS (`AkinatorWeb/frontend`). On supprime le service BTCPay, les routes de paiement de `routes/tokens.js`, le webhook dans `server.js`, la boutique frontend et l'écran admin « transactions en attente ». On renforce `POST /api/admin/users/:id/tokens` (add/set + reason) avec trace `transactions` de type `admin_grant` (migration SQLite du CHECK), et on crée l'UI admin d'attribution.

**Tech Stack:** Node/Express 4, better-sqlite3, node --test + supertest, frontend vanilla JS.

**Spec:** `docs/superpowers/specs/2026-07-23-retrait-paiement-audit-credits-igdb-design.md`

## Global Constraints

- Tous les tests se lancent depuis `AkinatorWeb/backend` avec `npm test` (runner `node --test tests/`).
- Conserver : `GET /api/tokens/balance`, `GET /api/tokens/transactions`, `POST /api/tokens/gift`, la table `transactions`, le daily claim.
- Supprimer sans feature flag ; git garde l'historique.
- Les routes admin sont derrière `authenticateToken` + `requireAdmin` + `csrfProtection` (POST ⇒ header `X-CSRF-Token` requis, cf. `tests/avatar-upload.test.js`).
- Textes UI et messages en français, style existant (toasts, `confirm()`/`prompt()`).
- Commits : messages français façon conventional commits (`feat:`, `test:`, `chore:`, `docs:`), suffixe `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Backend — suppression des routes de paiement et du service BTCPay

**Files:**
- Test (create): `AkinatorWeb/backend/tests/payment-removal.test.js`
- Modify: `AkinatorWeb/backend/routes/tokens.js`
- Modify: `AkinatorWeb/backend/server.js:59-65, 122-125`
- Delete: `AkinatorWeb/backend/services/btcpay.js`
- Modify: `AkinatorWeb/backend/config/config.js:57-72` (blocs `btcpay` et `crypto`)
- Modify: `AkinatorWeb/backend/env.example.txt` (vars `BTCPAY_*`, `APP_URL`, `WALLET_PRIVATE_KEY`, `NETWORK_RPC`, `TOKEN_PRICE_WEI` si présentes)
- Modify: `AkinatorWeb/backend/package.json` (retirer `ethers` ; garder `uuid` et `axios` — utilisés ailleurs)

**Interfaces:**
- Consumes: rien.
- Produces: `routes/tokens.js` n'exporte plus que le router (plus de `handleBTCPayWebhook`). Routes restantes : `GET /balance`, `GET /transactions`, `POST /gift`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `AkinatorWeb/backend/tests/payment-removal.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

const USER = { username: 'paiementuser', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

// Contexte authentifié + CSRF : nécessaire car /api/tokens est derrière
// csrfProtection, qui répondrait 403 avant le 404 attendu.
async function authContext() {
    await request(app).post('/api/auth/register').send(USER);
    const login = await request(app).post('/api/auth/login').send({ username: USER.username, password: USER.password });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

test('les routes de paiement sont supprimées (404)', async () => {
    const { cookie, csrfToken } = await authContext();
    const gone = [
        ['post', '/api/tokens/purchase'],
        ['post', '/api/tokens/verify'],
        ['get', '/api/tokens/prices'],
        ['post', '/api/tokens/btcpay/create'],
        ['get', '/api/tokens/btcpay/status/inv_12345'],
        ['post', '/api/tokens/webhook/btcpay']
    ];
    for (const [method, path] of gone) {
        const res = await request(app)[method](path)
            .set('Cookie', cookie).set('X-CSRF-Token', csrfToken).send({});
        assert.strictEqual(res.status, 404, `${method.toUpperCase()} ${path} doit renvoyer 404, reçu ${res.status}`);
    }
});

test('les routes jetons conservées fonctionnent toujours', async () => {
    const { cookie, csrfToken } = await authContext();

    const balance = await request(app).get('/api/tokens/balance').set('Cookie', cookie);
    assert.strictEqual(balance.status, 200);
    assert.strictEqual(typeof balance.body.data.tokens, 'number');

    const gift = await request(app).post('/api/tokens/gift')
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken).send({ amount: 5 });
    assert.strictEqual(gift.status, 200);

    const history = await request(app).get('/api/tokens/transactions').set('Cookie', cookie);
    assert.strictEqual(history.status, 200);
    assert.ok(Array.isArray(history.body.data));
});
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `cd AkinatorWeb/backend && node --test tests/payment-removal.test.js`
Expected: FAIL — les routes de paiement répondent encore (200/400/401, pas 404).

- [ ] **Step 3: Supprimer le paiement côté backend**

Dans `routes/tokens.js`, supprimer :
- l'en-tête « Achat, vérification, transactions crypto » (reformuler : « Solde, historique, gift quotidien »)
- les imports devenus inutiles : `uuidv4`, `param`, `config`, `db`, `btcpay`, `appendAudit`, `paymentLimiter` (garder `body`, `validationResult`, `queries`, `users`, `transactions`, `authenticateToken`)
- `PACK_EUR_PRICES` (l.24-30)
- routes `GET /prices` (l.66-86), `POST /purchase` (l.88-201), `POST /verify` (l.203-293)
- tout le bloc BTCPay (l.400-636) : `POST /btcpay/create`, `GET /btcpay/status/:invoiceId`, `handleBTCPayWebhook`
- la fonction `verifyTransaction` (l.638-655)
- la ligne `module.exports.handleBTCPayWebhook = handleBTCPayWebhook;` (l.658)

Dans `server.js` :
- l.59-65 : remplacer le `express.json({ limit: '1mb', verify: ... })` par :

```js
// Parser JSON
app.use(express.json({ limit: '1mb' }));
```

- l.122-125 : supprimer le commentaire webhook, le `require` de `handleBTCPayWebhook` et la ligne `app.post('/api/tokens/webhook/btcpay', handleBTCPayWebhook);`

Supprimer le fichier `services/btcpay.js` (`git rm`).

Dans `config/config.js`, supprimer les blocs `btcpay` (l.57-64) et `crypto` (l.66-72).

Dans `env.example.txt`, supprimer les lignes `BTCPAY_SERVER_URL`, `BTCPAY_API_KEY`, `BTCPAY_STORE_ID`, `BTCPAY_WEBHOOK_SECRET`, `APP_URL` et toute variable wallet/crypto legacy, avec leurs commentaires.

Dans `package.json`, supprimer la ligne `"ethers": "^6.11.1",`. Puis lancer `npm install` pour mettre à jour `package-lock.json`.

Vérifier qu'aucune autre référence ne subsiste : `grep -rn "btcpay\|ethers\|handleBTCPayWebhook\|rawBody" AkinatorWeb/backend --include=*.js` ne doit plus rien retourner hors `node_modules` et tests.

- [ ] **Step 4: Vérifier que les tests passent**

Run: `cd AkinatorWeb/backend && node --test tests/payment-removal.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Lancer toute la suite (non-régression)**

Run: `cd AkinatorWeb/backend && npm test`
Expected: PASS. Si un test existant référence une route supprimée ou `rawBody`, l'adapter (le signaler dans le commit).

- [ ] **Step 6: Commit**

```bash
git add -A AkinatorWeb/backend
git commit -m "feat(tokens): supprime le paiement crypto (BTCPay + flux manuel)"
```

---

### Task 2: Backend — attribution admin add/set avec raison + trace `admin_grant`

**Files:**
- Test (create): `AkinatorWeb/backend/tests/admin-tokens.test.js`
- Modify: `AkinatorWeb/backend/services/database.js:91-103` (migration CHECK `transactions.type`)
- Modify: `AkinatorWeb/backend/routes/admin.js:187-235` (route `POST /users/:id/tokens`) et suppression des routes `GET /transactions/pending`, `POST /transactions/:id/approve`, `POST /transactions/:id/reject` (l.359-430)

**Interfaces:**
- Consumes: `queries.users.findById/updateTokens/setTokens`, `queries.transactions.create(id, user_id, type, amount, tx_hash, status)`, `appendAudit(eventType, { userId, ipHash, details })`.
- Produces: contrat API `POST /api/admin/users/:id/tokens` body `{ action: 'add'|'set', amount: int, reason: string }` → `200 { success, message, data: { userId, oldBalance, newBalance } }`. Type de transaction `'admin_grant'` autorisé par le CHECK. (Le chantier 2 s'appuie sur ce contrat.)

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `AkinatorWeb/backend/tests/admin-tokens.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, db } = require('./helpers/setup');

const ADMIN = { username: 'adminjetons', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };
const TARGET = { username: 'ciblejetons', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

async function login(user) {
    const res = await request(app).post('/api/auth/login').send({ username: user.username, password: user.password });
    const cookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

async function setupUsers() {
    await request(app).post('/api/auth/register').send(ADMIN);
    await request(app).post('/api/auth/register').send(TARGET);
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(ADMIN.username);
    return db.prepare('SELECT id, tokens FROM users WHERE username = ?').get(TARGET.username);
}

function grant(ctx, targetId, body) {
    return request(app).post(`/api/admin/users/${targetId}/tokens`)
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send(body);
}

test("action 'add' incrémente le solde et trace une transaction admin_grant", async () => {
    const target = await setupUsers();
    const ctx = await login(ADMIN);

    const res = await grant(ctx, target.id, { action: 'add', amount: 5, reason: 'récompense stream' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.oldBalance, target.tokens);
    assert.strictEqual(res.body.data.newBalance, target.tokens + 5);

    const inDb = db.prepare('SELECT tokens FROM users WHERE id = ?').get(target.id);
    assert.strictEqual(inDb.tokens, target.tokens + 5);

    const tx = db.prepare("SELECT * FROM transactions WHERE user_id = ? AND type = 'admin_grant' ORDER BY created_at DESC LIMIT 1").get(target.id);
    assert.ok(tx, "une transaction admin_grant doit être créée");
    assert.strictEqual(tx.amount, 5);
    assert.strictEqual(tx.status, 'completed');
});

test("action 'set' fixe le solde ; le delta est tracé", async () => {
    const target = await setupUsers();
    const ctx = await login(ADMIN);

    const res = await grant(ctx, target.id, { action: 'set', amount: 42, reason: 'correction de solde' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.newBalance, 42);
    assert.strictEqual(db.prepare('SELECT tokens FROM users WHERE id = ?').get(target.id).tokens, 42);
});

test('validations : raison obligatoire, action connue, montant entier, solde final >= 0', async () => {
    const target = await setupUsers();
    const ctx = await login(ADMIN);

    for (const body of [
        { action: 'add', amount: 5 },                                  // pas de raison
        { action: 'add', amount: 5, reason: '   ' },                   // raison vide
        { action: 'multiply', amount: 5, reason: 'x' },                // action inconnue
        { action: 'add', amount: 2.5, reason: 'x' },                   // non entier
        { action: 'set', amount: -1, reason: 'x' },                    // set négatif
        { action: 'add', amount: -9999, reason: 'x' }                  // solde final négatif
    ]) {
        const res = await grant(ctx, target.id, body);
        assert.strictEqual(res.status, 400, `body ${JSON.stringify(body)} doit être refusé`);
    }
    // le solde n'a pas bougé
    assert.strictEqual(db.prepare('SELECT tokens FROM users WHERE id = ?').get(target.id).tokens, target.tokens);
});

test('un non-admin est refusé (403)', async () => {
    const target = await setupUsers();
    const ctx = await login(TARGET);
    const res = await grant(ctx, target.id, { action: 'add', amount: 5, reason: 'tentative' });
    assert.strictEqual(res.status, 403);
});

test('utilisateur inconnu → 404', async () => {
    await setupUsers();
    const ctx = await login(ADMIN);
    const res = await grant(ctx, 'id-inexistant', { action: 'add', amount: 5, reason: 'x' });
    assert.strictEqual(res.status, 404);
});

test("les routes d'approbation de transactions sont supprimées (404)", async () => {
    await setupUsers();
    const ctx = await login(ADMIN);

    const pending = await request(app).get('/api/admin/transactions/pending').set('Cookie', ctx.cookie);
    assert.strictEqual(pending.status, 404);

    for (const path of ['/api/admin/transactions/tx-1/approve', '/api/admin/transactions/tx-1/reject']) {
        const res = await request(app).post(path)
            .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({});
        assert.strictEqual(res.status, 404, `${path} doit renvoyer 404`);
    }
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `cd AkinatorWeb/backend && node --test tests/admin-tokens.test.js`
Expected: FAIL — l'ancien contrat (`{ amount }` = set) ne renvoie ni `oldBalance`/`newBalance`, n'exige pas `reason`, et l'INSERT `admin_grant` violerait le CHECK.

- [ ] **Step 3: Migration SQLite — autoriser le type `admin_grant`**

Dans `services/database.js`, juste après le bloc `CREATE TABLE IF NOT EXISTS transactions` (l.91-103), ajouter :

```js
    // Migration : le CHECK de transactions.type n'inclut pas 'admin_grant' sur
    // les bases existantes et SQLite ne modifie pas un CHECK — rebuild de la table.
    const txTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get();
    if (txTable && !txTable.sql.includes('admin_grant')) {
        db.exec(`
            CREATE TABLE transactions_new (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('purchase', 'gift', 'daily', 'game', 'admin_grant')),
                amount INTEGER NOT NULL,
                tx_hash TEXT,
                status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            INSERT INTO transactions_new SELECT * FROM transactions;
            DROP TABLE transactions;
            ALTER TABLE transactions_new RENAME TO transactions;
        `);
    }
```

Note : le `CREATE TABLE IF NOT EXISTS` initial (l.93) doit aussi être mis à jour avec `'admin_grant'` dans son CHECK pour les nouvelles bases (sinon la migration rebuild tournerait à chaque boot d'une base neuve). L'index `idx_transactions_user` est recréé plus loin (l.218, `IF NOT EXISTS`) — pas d'action.

- [ ] **Step 4: Réécrire la route admin**

Dans `routes/admin.js`, ajouter l'import en tête (après l.14) :

```js
const { v4: uuidv4 } = require('uuid');
```

Remplacer entièrement le handler `POST /users/:id/tokens` (l.187-235) par :

```js
/**
 * POST /api/admin/users/:id/tokens
 * Attribue des jetons à un utilisateur.
 * Body : { action: 'add'|'set', amount: entier, reason: string obligatoire }
 * 'add' incrémente le solde (voie normale), 'set' fixe une valeur absolue
 * (correction exceptionnelle). Trace une transaction 'admin_grant' (delta).
 */
router.post('/users/:id/tokens', async (req, res) => {
    try {
        const user = queries.users.findById.get(req.params.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Utilisateur introuvable'
            });
        }

        const { action, amount, reason } = req.body;

        if (!['add', 'set'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: "Action invalide (attendu : 'add' ou 'set')"
            });
        }

        if (typeof amount !== 'number' || !Number.isInteger(amount)) {
            return res.status(400).json({
                success: false,
                error: 'Montant invalide (doit être un entier)'
            });
        }

        if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 200) {
            return res.status(400).json({
                success: false,
                error: 'Raison obligatoire (200 caractères max)'
            });
        }

        const oldBalance = user.tokens;
        const newBalance = action === 'add' ? oldBalance + amount : amount;

        if (newBalance < 0) {
            return res.status(400).json({
                success: false,
                error: `Solde final négatif refusé (solde actuel : ${oldBalance})`
            });
        }

        const db = require('../services/database').db;
        db.transaction(() => {
            if (action === 'add') {
                queries.users.updateTokens.run(amount, req.params.id);
            } else {
                queries.users.setTokens.run(amount, req.params.id);
            }
            queries.transactions.create.run(
                uuidv4(), req.params.id, 'admin_grant', newBalance - oldBalance, null, 'completed'
            );
        })();

        console.log(`🔧 Admin ${req.user.username} attribue des jetons à ${user.username}: ${oldBalance} -> ${newBalance} (${action}, ${reason.trim()})`);

        appendAudit('admin.user.tokens', {
            userId: req.user.id,
            details: { targetId: req.params.id, action, amount, reason: reason.trim() }
        });

        res.json({
            success: true,
            message: `Jetons de ${user.username} : ${oldBalance} → ${newBalance}`,
            data: {
                userId: req.params.id,
                oldBalance,
                newBalance
            }
        });
    } catch (error) {
        console.error('❌ Erreur attribution jetons:', error);
        res.status(500).json({
            success: false,
            error: "Erreur lors de l'attribution"
        });
    }
});
```

(L'enrichissement complet de l'audit — soldes, ipHash, username — est le chantier 2.)

Supprimer ensuite de `routes/admin.js` les routes `GET /transactions/pending` (l.359-380), `POST /transactions/:id/approve` (l.382-407) et `POST /transactions/:id/reject` (l.409-430) : plus aucun achat ne peut créer de transaction `pending`, et l'approbation créditait des jetons sans raison ni contrôle de solde — la nouvelle route d'attribution est la seule voie. Tous les imports existants d'`admin.js` restent utilisés (ne rien retirer d'autre).

- [ ] **Step 5: Vérifier que les tests passent**

Run: `cd AkinatorWeb/backend && node --test tests/admin-tokens.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Suite complète**

Run: `cd AkinatorWeb/backend && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add AkinatorWeb/backend/routes/admin.js AkinatorWeb/backend/services/database.js AkinatorWeb/backend/tests/admin-tokens.test.js
git commit -m "feat(admin): attribution de jetons add/set avec raison et trace admin_grant"
```

---

### Task 3: Frontend — retrait de la boutique et des écrans de paiement

**Files:**
- Modify: `AkinatorWeb/frontend/index.html` (nav l.35-38, section shop l.108-221, bloc admin « Transactions en attente » l.268-290, bouton l.556, script wallet l.750)
- Modify: `AkinatorWeb/frontend/js/app.js`
- Modify: `AkinatorWeb/frontend/js/api.js:303-329, 367-377`
- Delete: `AkinatorWeb/frontend/js/wallet.js`

**Interfaces:**
- Consumes: routes conservées `GET /tokens/balance`, `POST /tokens/gift`, `POST /auth/claim-daily`.
- Produces: la section `#shopSection` devient « Mes jetons » (solde + gift quotidien uniquement) ; `showShopSection`, `claimDailyTokens`, `goHome` inchangés. Plus aucune référence à `Wallet`, BTCPay, packs.

- [ ] **Step 1: index.html**

- Nav (l.36-38) : remplacer le libellé du bouton par `<i class="fa-solid fa-coins icon"></i> Mes jetons` (id `shopBtn` conservé — le JS s'y accroche).
- Section shop : conserver `#shopSection`, `#backHomeBtn`, le bloc solde (`#shopTokenBalance`) et la carte gift (`#dailySection`, `#claimDailyBtn`). Titre → `<h1><i class="fa-solid fa-coins icon-title"></i> Mes Jetons</h1>`, sous-titre → `<p>Récupérez vos jetons quotidiens gratuits. Besoin de plus ? Contactez un administrateur.</p>`. Supprimer : le titre « Packs de Jetons », la grille `.token-packs-grid` (l.138-166) et toute la `#paymentSection` (l.168-219).
- Bloc admin : supprimer entièrement `#adminTransactionsSection` (l.268-290, adresse BTC comprise).
- l.556 : remplacer le libellé « Acheter des jetons » par « Obtenir des jetons » (le bouton continue d'ouvrir la section jetons).
- l.750 : supprimer `<script src="js/wallet.js"></script>`.

- [ ] **Step 2: app.js**

Supprimer :
- `PACK_PRICES` (l.24-30) et `CRYPTO_ADDRESSES` (l.32-36)
- dans `attachEventListeners` : le listener `createBTCPayInvoiceBtn` (l.116-117) et le bloc `.shop-pack` (l.119-124) — garder `shopBtn`, `backHomeBtn`, `claimDailyBtn`
- les fonctions : `selectPack`, `selectCrypto`, `verifyBtcPayment`, `verifyEthPayment`, `verifyManualPayment`, `stopBTCPayPolling`, `createBTCPayInvoice`, `pollBTCPayStatus`, `connectWallet`, `processPayment` et la variable `btcpayPollingInterval`
- les fonctions admin : `loadPendingTransactions`, `approveTransaction`, `rejectTransaction` et leurs `window.*` ; dans `loadAdminData`, supprimer l'appel `await loadPendingTransactions();` et son commentaire
- `copyToClipboard` et `giftTokens` : supprimer si plus référencés (vérifier avec `grep -n "copyToClipboard\|giftTokens" AkinatorWeb/frontend -r`)
- dans `showShopSection` (l.679-711) : garder tel quel (il ne touche plus que solde + daily)
- variables `selectedPack` / `selectedCrypto` : supprimer leurs déclarations si plus référencées
- texte RGPD (~l.1770) : retirer la mention « adresse de wallet crypto, hash de transactions » de la liste des données collectées

- [ ] **Step 3: api.js**

Supprimer les méthodes : `getTokenPrices`, `purchaseTokens`, `verifyTransaction`, `createBTCPayInvoice`, `getBTCPayStatus` (l.303-329 — garder `getTokenBalance`, `getTransactions`, `claimGift`, `claimDaily`) et `getPendingTransactions`, `approveTransaction`, `rejectTransaction` (l.367-377).

Supprimer `AkinatorWeb/frontend/js/wallet.js` (`git rm`).

- [ ] **Step 4: Vérification**

Run: `grep -rni "btcpay\|wallet\|shop-pack\|paymentSection\|pendingTransactions\|PACK_PRICES\|CRYPTO_ADDRESSES" AkinatorWeb/frontend --include=*.js --include=*.html`
Expected: aucune occurrence restante (hors CSS mort éventuel, toléré). Puis `cd AkinatorWeb/backend && npm test` : PASS (le backend sert le frontend statique, aucun test frontend n'existe).

Lancer le serveur (`cd AkinatorWeb/backend && JWT_SECRET=devsecret0123456789devsecret0123 npm start` ou la commande du README) et vérifier à la main : accueil OK, « Mes jetons » affiche solde + gift, panneau admin sans section transactions, aucune erreur console au chargement.

- [ ] **Step 5: Commit**

```bash
git add -A AkinatorWeb/frontend
git commit -m "feat(front): retire la boutique et le paiement, section Mes jetons (gift uniquement)"
```

---

### Task 4: Frontend — UI admin d'attribution de jetons

**Files:**
- Modify: `AkinatorWeb/frontend/js/api.js` (section ADMIN, après `demoteUser`)
- Modify: `AkinatorWeb/frontend/js/app.js` (`displayUsers` + nouvelle fonction)

**Interfaces:**
- Consumes: `POST /api/admin/users/:id/tokens` `{ action, amount, reason }` (Task 2).
- Produces: bouton « pièces » par ligne du tableau utilisateurs admin → `adjustUserTokens(userId, username, currentTokens)`.

- [ ] **Step 1: api.js — nouvelle méthode**

Dans la section ADMIN de `api.js`, après `demoteUser`, ajouter :

```js
    async setUserTokens(userId, action, amount, reason) {
        return this.post(`/admin/users/${userId}/tokens`, { action, amount, reason });
    },
```

- [ ] **Step 2: app.js — bouton + flux d'attribution**

Dans `displayUsers`, dans le bloc « Actions » après le bouton « View » et avant le bouton « Promote », ajouter :

```js
        // Tokens button
        const btnTokens = document.createElement('button');
        btnTokens.className = 'btn btn-sm btn-accent';
        btnTokens.title = 'Attribuer des jetons';
        btnTokens.onclick = () => adjustUserTokens(user.id, user.username, user.tokens);
        btnTokens.innerHTML = '<i class="fa-solid fa-coins"></i>';
        tdActions.appendChild(btnTokens);
```

Après `deleteUser`, ajouter la fonction et son exposition globale (même pattern `prompt/confirm` que le reste du fichier) :

```js
async function adjustUserTokens(userId, username, currentTokens) {
    const input = prompt(
        `Jetons de ${username} (solde actuel : ${currentTokens})\n\n` +
        `Entrez un montant à AJOUTER (ex : 10, -2)\n` +
        `ou "=N" pour FIXER le solde (ex : =50) :`
    );
    if (input === null) return;

    const trimmed = input.trim();
    const isSet = trimmed.startsWith('=');
    const amount = parseInt(isSet ? trimmed.slice(1) : trimmed, 10);
    if (isNaN(amount)) {
        showToast('Montant invalide', 'error');
        return;
    }

    const reason = prompt("Raison de l'attribution (obligatoire) :");
    if (reason === null) return;
    if (!reason.trim()) {
        showToast('La raison est obligatoire', 'error');
        return;
    }

    try {
        const res = await API.setUserTokens(userId, isSet ? 'set' : 'add', amount, reason.trim());
        showToast(res.message, 'success');
        loadAdminData();
    } catch (error) {
        showToast(error.message || "Erreur lors de l'attribution", 'error');
    }
}
window.adjustUserTokens = adjustUserTokens;
```

- [ ] **Step 3: Vérification manuelle**

Serveur lancé, compte admin (`ADMIN_USERNAME`/`ADMIN_PASSWORD`) : panneau admin → bouton pièces → « 5 » + raison → toast « X → Y » et solde rafraîchi ; « =20 » fixe le solde ; raison vide refusée.

- [ ] **Step 4: Commit**

```bash
git add AkinatorWeb/frontend/js/api.js AkinatorWeb/frontend/js/app.js
git commit -m "feat(front): UI admin d'attribution de jetons (add/set + raison)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md` (l.54, 71, 83, 149, 171, 219-220, 236-239, 253 : retirer BTCPay/ethers/packs ; documenter l'attribution admin)
- Modify: `docs/architecture.md` (l.38, 53, 63, 80)
- Modify: `docs/securite.md` (l.90-91)

**Interfaces:** aucune.

- [ ] **Step 1: Mettre à jour les docs**

Retirer toute mention de BTCPay, webhook de paiement, `ethers`, packs/prix, adresses crypto. Dans le README, remplacer la section « paiement » par un court paragraphe : les jetons s'obtiennent via le gift quotidien ou par attribution d'un administrateur (`POST /api/admin/users/:id/tokens`, body `{ action: 'add'|'set', amount, reason }`, raison obligatoire, action tracée dans `transactions` et le journal d'audit). Mettre à jour le tableau des routes `/api/tokens` (balance, transactions, gift) et le tableau des variables d'environnement.

- [ ] **Step 2: Vérification**

Run: `grep -rni "btcpay\|ethers" README.md docs/ --include=*.md | grep -v superpowers`
Expected: aucune occurrence.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/architecture.md docs/securite.md
git commit -m "docs: retire le paiement crypto, documente l'attribution admin de jetons"
```
