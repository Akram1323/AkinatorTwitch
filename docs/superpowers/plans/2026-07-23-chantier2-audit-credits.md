# Chantier 2 — Audit de l'attribution de crédits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Répondre à « qui a reçu des crédits, de qui, quand, pourquoi » : enrichir l'événement d'audit `admin.user.tokens` et afficher les attributions dans le panneau admin.

**Architecture:** S'appuie sur l'infra existante (`services/auditService.js`, journal chaîné HMAC, table `audit_log`) et sur la route du chantier 1 (`POST /api/admin/users/:id/tokens`). On enrichit `details`, on ajoute un filtre `event_type` à `GET /api/admin/audit`, et une table « Attributions de crédits » dans le panneau admin (il n'existe aucun écran d'audit frontend à ce jour).

**Tech Stack:** Node/Express 4, better-sqlite3, node --test + supertest, frontend vanilla JS.

**Spec:** `docs/superpowers/specs/2026-07-23-retrait-paiement-audit-credits-igdb-design.md`

## Global Constraints

- Dépend du chantier 1 mergé (contrat `{ action, amount, reason }` et `oldBalance`/`newBalance`).
- Tests : `npm test` depuis `AkinatorWeb/backend`.
- La chaîne d'audit doit rester vérifiable (`GET /api/admin/audit/verify` → `valid: true`).
- Textes UI en français ; commits français + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Backend — audit enrichi + filtre `event_type`

**Files:**
- Test (create): `AkinatorWeb/backend/tests/admin-tokens-audit.test.js`
- Modify: `AkinatorWeb/backend/routes/admin.js` (handler `POST /users/:id/tokens` et `GET /audit`)

**Interfaces:**
- Consumes: `appendAudit(eventType, { userId, ipHash, details })` (`services/auditService.js:52`), `hashIPForLogging(ip)` (`services/encryption.js:145`).
- Produces: entrée `audit_log` `admin.user.tokens` avec `user_id` = admin, `ip_hash` renseigné, `details` = `{ targetId, targetUsername, adminUsername, action, amount, oldBalance, newBalance, reason }`. `GET /api/admin/audit?event_type=X&limit=N` filtre par type exact.

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `AkinatorWeb/backend/tests/admin-tokens-audit.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, db } = require('./helpers/setup');

const ADMIN = { username: 'adminaudit', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };
const TARGET = { username: 'cibleaudit', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

async function adminContext() {
    await request(app).post('/api/auth/register').send(ADMIN);
    await request(app).post('/api/auth/register').send(TARGET);
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(ADMIN.username);
    const login = await request(app).post('/api/auth/login').send({ username: ADMIN.username, password: ADMIN.password });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    const target = db.prepare('SELECT id, tokens FROM users WHERE username = ?').get(TARGET.username);
    const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN.username);
    return { cookie, csrfToken: csrf.body.data.csrfToken, target, admin };
}

test("l'attribution de jetons produit une entrée d'audit complète", async () => {
    const { cookie, csrfToken, target, admin } = await adminContext();

    const res = await request(app).post(`/api/admin/users/${target.id}/tokens`)
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken)
        .send({ action: 'add', amount: 7, reason: 'gagnant du concours' });
    assert.strictEqual(res.status, 200);

    const entry = db.prepare("SELECT * FROM audit_log WHERE event_type = 'admin.user.tokens' ORDER BY id DESC LIMIT 1").get();
    assert.ok(entry, "entrée d'audit attendue");
    assert.strictEqual(entry.user_id, admin.id, "user_id = admin acteur");
    assert.ok(entry.ip_hash, 'ip_hash renseigné');

    const details = JSON.parse(entry.details);
    assert.strictEqual(details.targetId, target.id);
    assert.strictEqual(details.targetUsername, TARGET.username);
    assert.strictEqual(details.adminUsername, ADMIN.username);
    assert.strictEqual(details.action, 'add');
    assert.strictEqual(details.amount, 7);
    assert.strictEqual(details.oldBalance, target.tokens);
    assert.strictEqual(details.newBalance, target.tokens + 7);
    assert.strictEqual(details.reason, 'gagnant du concours');
});

test('la chaîne d\'audit reste vérifiable après attribution', async () => {
    const { cookie } = await adminContext();
    const res = await request(app).get('/api/admin/audit/verify').set('Cookie', cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.valid, true);
});

test('GET /api/admin/audit?event_type= filtre par type', async () => {
    const { cookie, csrfToken, target } = await adminContext();
    await request(app).post(`/api/admin/users/${target.id}/tokens`)
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken)
        .send({ action: 'add', amount: 1, reason: 'test filtre' });

    const res = await request(app)
        .get('/api/admin/audit?event_type=admin.user.tokens&limit=50')
        .set('Cookie', cookie);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.entries.length >= 1);
    for (const entry of res.body.data.entries) {
        assert.strictEqual(entry.event_type, 'admin.user.tokens');
    }

    // sans filtre : les autres types (auth.register, ...) sont présents
    const all = await request(app).get('/api/admin/audit?limit=100').set('Cookie', cookie);
    assert.ok(all.body.data.entries.some(e => e.event_type !== 'admin.user.tokens'));
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `cd AkinatorWeb/backend && node --test tests/admin-tokens-audit.test.js`
Expected: FAIL — `details` ne contient pas `oldBalance`/`targetUsername`/..., `ip_hash` est NULL, le filtre `event_type` est ignoré.

- [ ] **Step 3: Enrichir l'audit dans la route d'attribution**

Dans `routes/admin.js`, ajouter l'import (à côté de `decryptIP`) :

```js
const { hashIPForLogging } = require('../services/encryption');
```

Dans le handler `POST /users/:id/tokens`, remplacer l'appel `appendAudit(...)` par :

```js
        const rawIP = req.ip || req.connection.remoteAddress || 'unknown';
        appendAudit('admin.user.tokens', {
            userId: req.user.id,
            ipHash: hashIPForLogging(rawIP),
            details: {
                targetId: req.params.id,
                targetUsername: user.username,
                adminUsername: req.user.username,
                action,
                amount,
                oldBalance,
                newBalance,
                reason: reason.trim()
            }
        });
```

- [ ] **Step 4: Filtre `event_type` sur GET /audit**

Dans `routes/admin.js`, remplacer le corps du handler `GET /audit` par :

```js
router.get('/audit', async (req, res) => {
    try {
        const db = require('../services/database').db;
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
        const eventType = typeof req.query.event_type === 'string' && req.query.event_type.length <= 100
            ? req.query.event_type
            : null;

        const entries = eventType
            ? db.prepare('SELECT * FROM audit_log WHERE event_type = ? ORDER BY id DESC LIMIT ?').all(eventType, limit)
            : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);

        res.json({ success: true, data: { entries } });
    } catch (error) {
        console.error('❌ Erreur audit log:', error);
        res.status(500).json({ success: false, error: 'Erreur lors de la récupération du journal' });
    }
});
```

- [ ] **Step 5: Vérifier que les tests passent, puis la suite**

Run: `cd AkinatorWeb/backend && node --test tests/admin-tokens-audit.test.js`
Expected: PASS (3 tests).
Run: `cd AkinatorWeb/backend && npm test`
Expected: PASS (dont `admin-tokens.test.js` du chantier 1, inchangé).

- [ ] **Step 6: Commit**

```bash
git add AkinatorWeb/backend/routes/admin.js AkinatorWeb/backend/tests/admin-tokens-audit.test.js
git commit -m "feat(audit): enrichit l'audit d'attribution de jetons et filtre par type d'événement"
```

---

### Task 2: Frontend — table « Attributions de crédits » dans le panneau admin

**Files:**
- Modify: `AkinatorWeb/frontend/js/api.js` (section ADMIN)
- Modify: `AkinatorWeb/frontend/index.html` (panneau admin, sous la liste des utilisateurs)
- Modify: `AkinatorWeb/frontend/js/app.js` (`loadAdminData` + rendu)

**Interfaces:**
- Consumes: `GET /api/admin/audit?event_type=admin.user.tokens&limit=50` (Task 1) ; `details` JSON avec `adminUsername`, `targetUsername`, `action`, `oldBalance`, `newBalance`, `reason`.
- Produces: section `#adminGrantsSection` avec `#grantsTableBody`, rafraîchie par `loadAdminData`.

- [ ] **Step 1: api.js**

Dans la section ADMIN, après `setUserTokens`, ajouter :

```js
    async getAuditEntries(eventType, limit = 50) {
        const params = new URLSearchParams({ limit });
        if (eventType) params.set('event_type', eventType);
        return this.get(`/admin/audit?${params.toString()}`);
    },
```

- [ ] **Step 2: index.html**

Dans la section admin, après le bloc « Liste des utilisateurs » (`.admin-users`), ajouter :

```html
                <!-- Attributions de crédits (journal d'audit) -->
                <div class="admin-users" id="adminGrantsSection">
                    <h2><i class="fa-solid fa-coins icon"></i> Attributions de crédits</h2>
                    <div class="users-table-container">
                        <table class="users-table">
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>Admin</th>
                                    <th>Bénéficiaire</th>
                                    <th>Opération</th>
                                    <th>Solde</th>
                                    <th>Raison</th>
                                </tr>
                            </thead>
                            <tbody id="grantsTableBody">
                                <tr><td colspan="6" style="text-align:center;padding:2rem;">Chargement...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
```

- [ ] **Step 3: app.js**

Dans `loadAdminData`, après `displayUsers(users.data.users);`, ajouter :

```js
        // Charger le journal des attributions de crédits
        await loadCreditGrants();
```

Après `displayUsers`, ajouter (rendu via `createElement`/`textContent`, même pattern anti-XSS que `displayUsers`) :

```js
async function loadCreditGrants() {
    const tbody = document.getElementById('grantsTableBody');
    if (!tbody) return;
    try {
        const result = await API.getAuditEntries('admin.user.tokens', 50);
        const entries = result.data.entries;
        tbody.innerHTML = '';
        if (!entries || entries.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted);">Aucune attribution</td></tr>';
            return;
        }
        entries.forEach(entry => {
            let details = {};
            try { details = JSON.parse(entry.details) || {}; } catch (e) { /* entrée ancienne */ }

            const tr = document.createElement('tr');

            const tdDate = document.createElement('td');
            tdDate.textContent = entry.created_at ? new Date(entry.created_at).toLocaleString('fr-FR') : '-';
            tr.appendChild(tdDate);

            const tdAdmin = document.createElement('td');
            tdAdmin.textContent = details.adminUsername || entry.user_id || '-';
            tr.appendChild(tdAdmin);

            const tdTarget = document.createElement('td');
            const strong = document.createElement('strong');
            strong.textContent = details.targetUsername || details.targetId || '-';
            tdTarget.appendChild(strong);
            tr.appendChild(tdTarget);

            const tdOp = document.createElement('td');
            if (details.action === 'add') {
                tdOp.textContent = (details.amount >= 0 ? '+' : '') + details.amount + ' jetons';
            } else if (details.action === 'set') {
                tdOp.textContent = 'fixé à ' + details.amount;
            } else {
                tdOp.textContent = details.amount != null ? String(details.amount) : '-';
            }
            tr.appendChild(tdOp);

            const tdBalance = document.createElement('td');
            tdBalance.textContent = (details.oldBalance != null && details.newBalance != null)
                ? details.oldBalance + ' → ' + details.newBalance
                : '-';
            tr.appendChild(tdBalance);

            const tdReason = document.createElement('td');
            tdReason.textContent = details.reason || '-';
            tr.appendChild(tdReason);

            tbody.appendChild(tr);
        });
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">Erreur de chargement</td></tr>';
    }
}
```

- [ ] **Step 4: Vérification manuelle**

Serveur lancé, compte admin : attribuer des jetons via le bouton pièces → la table « Attributions de crédits » affiche la ligne (date, admin, bénéficiaire, +N, ancien → nouveau, raison). `npm test` : PASS.

- [ ] **Step 5: Commit + docs**

Mettre à jour `README.md` (section admin) : mentionner la table « Attributions de crédits » et le filtre `GET /api/admin/audit?event_type=`.

```bash
git add AkinatorWeb/frontend README.md
git commit -m "feat(front): journal des attributions de crédits dans le panneau admin"
```
