# Corrections de sécurité (4 problèmes) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corriger les 4 problèmes de sécurité relevés lors de l'analyse du merge PR #1 : contournement du 2FA via le token temporaire, absence d'invalidation des sessions au changement de mot de passe, altération silencieuse des mots de passe par `sanitizeInput`, et incohérence documentaire sur la durée de vie des tokens.

**Architecture:** Backend Express + SQLite (`better-sqlite3`), authentification par access token JWT court (15 min) + refresh rotatif en cookies httpOnly. Les correctifs se concentrent dans `middleware/security.js` (gardes d'authentification), `services/tokenService.js` (révocation de familles), `routes/auth.js` (câblage changement/réinitialisation de mot de passe), `services/database.js` (nouvelle colonne). Tests via `node:test` + `supertest`.

**Tech Stack:** Node.js 20, Express 4, better-sqlite3, jsonwebtoken, node:test, supertest.

## Global Constraints

- Ne jamais désactiver, skipper ni affaiblir un test existant. La suite doit rester verte (baseline : 36 tests).
- Tests lancés avec `JWT_SECRET` défini : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef npm test` depuis `AkinatorWeb/backend`.
- Environnement de test : `NODE_ENV=test` (fixé par `tests/helpers/setup.js`), base SQLite temporaire par process.
- Requêtes SQL uniquement via prepared statements (jamais de concaténation).
- `password_changed_at` est stocké en **secondes Unix (INTEGER)** pour être comparable directement à `iat` d'un JWT (lui aussi en secondes). Comparaison stricte `decoded.iat < password_changed_at`.
- Colonne ajoutée par migration idempotente `ALTER TABLE ... ADD COLUMN` dans le bloc try/catch existant ; les lignes existantes auront `password_changed_at = NULL` → aucune invalidation rétroactive (la garde ne s'applique que si la valeur est non nulle).

---

### Task 1 : Fermer le contournement du 2FA via le token temporaire (`pending2FA`)

**Contexte :** `/api/auth/login` renvoie, pour un compte 2FA, un `tempToken` JWT signé avec le secret applicatif et portant `pending2FA: true` (5 min). Ce token n'a pas de `jti`. Aujourd'hui `authenticateToken` et `optionalAuth` acceptent ce token (signature valide, `isJtiRevoked(undefined)` → false), ce qui donne un accès authentifié complet sans code 2FA. Correctif : rejeter tout token portant `pending2FA`.

**Files:**
- Modify: `AkinatorWeb/backend/middleware/security.js` (fonctions `authenticateToken` ~L129-170 et `optionalAuth` ~L175-197)
- Test: `AkinatorWeb/backend/tests/pending2fa-bypass.test.js` (créer)

**Interfaces:**
- Consumes : `jwt.verify` (déjà en place), `config.jwt.secret`.
- Produces : garde comportementale — un JWT avec `pending2FA: true` renvoie 401 sur toute route protégée par `authenticateToken`, et n'est pas honoré par `optionalAuth`.

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `AkinatorWeb/backend/tests/pending2fa-bypass.test.js` :

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('./helpers/setup');

// Reproduit le tempToken émis par /login quand la 2FA est active
function craftPendingToken() {
    return jwt.sign(
        { id: 'attacker-id', username: 'attacker', pending2FA: true },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
    );
}

test('un token pending2FA est refusé par une route protégée (via cookie)', async () => {
    const temp = craftPendingToken();
    const res = await request(app).get('/api/auth/me')
        .set('Cookie', `access_token=${temp}`);
    assert.strictEqual(res.status, 401, 'le token 2FA temporaire ne doit pas authentifier');
});

test('un token pending2FA est refusé par une route protégée (via Authorization)', async () => {
    const temp = craftPendingToken();
    const res = await request(app).get('/api/auth/me')
        .set('Authorization', `Bearer ${temp}`);
    assert.strictEqual(res.status, 401, 'le token 2FA temporaire ne doit pas authentifier');
});
```

- [ ] **Step 2 : Lancer le test et vérifier qu'il échoue**

Run : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef node --test tests/pending2fa-bypass.test.js`
Expected : FAIL — `/api/auth/me` renvoie 200 (le token est accepté) ou 404 (user introuvable) au lieu de 401.

- [ ] **Step 3 : Implémenter la garde dans `authenticateToken`**

Dans `AkinatorWeb/backend/middleware/security.js`, à l'intérieur de `authenticateToken`, juste après `const decoded = jwt.verify(...)` et avant la vérification de blacklist :

```javascript
        // Le token temporaire de pré-2FA ne doit JAMAIS authentifier une requête :
        // il ne prouve que le 1er facteur (mot de passe), pas le 2ᵉ.
        if (decoded.pending2FA) {
            return res.status(401).json({
                success: false,
                error: 'Vérification 2FA requise'
            });
        }
```

- [ ] **Step 4 : Implémenter la garde dans `optionalAuth`**

Dans la même page, dans `optionalAuth`, après `const decoded = jwt.verify(...)` et avant de positionner `req.user` :

```javascript
            // Un token pré-2FA n'est pas une session valide : ne pas l'honorer.
            if (decoded.pending2FA) {
                return next();
            }
```

(Insérer avant le bloc `isJtiRevoked` existant ; conserver ce bloc.)

- [ ] **Step 5 : Lancer le test et vérifier qu'il passe**

Run : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef node --test tests/pending2fa-bypass.test.js`
Expected : PASS (2 tests).

- [ ] **Step 6 : Lancer toute la suite (non-régression)**

Run : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef npm test`
Expected : PASS, 38 tests (36 existants + 2), 0 échec.

- [ ] **Step 7 : Commit**

```bash
git add AkinatorWeb/backend/middleware/security.js AkinatorWeb/backend/tests/pending2fa-bypass.test.js
git commit -m "fix(auth): rejette le token temporaire pré-2FA dans les gardes d'authentification"
```

---

### Task 2 : Invalidation immédiate des sessions au changement de mot de passe

**Contexte :** `/change-password` et `/forgot-password` mettent à jour le hash mais ne révoquent ni les refresh tokens (valides 7 j) ni les access tokens en cours : une session attaquante survit au changement. Correctif : colonne `password_changed_at` (secondes Unix) ; `authenticateToken`/`optionalAuth` rejettent tout access token dont `iat < password_changed_at` ; révocation de toutes les familles de refresh du compte. Le changement authentifié ré-émet une paire fraîche pour NE PAS déconnecter la session courante légitime tout en tuant les autres.

**Files:**
- Modify: `AkinatorWeb/backend/services/database.js` (bloc migration ~L71-86 : ajout colonne)
- Modify: `AkinatorWeb/backend/services/tokenService.js` (ajout `revokeAllUserFamilies`, export)
- Modify: `AkinatorWeb/backend/middleware/security.js` (`authenticateToken` + `optionalAuth` : garde `iat`)
- Modify: `AkinatorWeb/backend/routes/auth.js` (`/change-password` ~L617-707 et `/forgot-password` ~L714-792)
- Test: `AkinatorWeb/backend/tests/password-change-invalidation.test.js` (créer)

**Interfaces:**
- Consumes (de Task 1) : gardes existantes dans `authenticateToken`/`optionalAuth` (la nouvelle garde `iat` s'ajoute après la garde `pending2FA`).
- Produces :
  - `tokenService.revokeAllUserFamilies(userId: string): void` — passe `revoked = 1` sur toutes les familles de refresh de l'utilisateur.
  - Colonne `users.password_changed_at INTEGER` (secondes Unix, nullable).
  - Comportement : après changement/réinitialisation de mot de passe, tout access token émis avant l'instant du changement renvoie 401 ; toutes les familles de refresh sont révoquées.

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `AkinatorWeb/backend/tests/password-change-invalidation.test.js` :

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { app } = require('./helpers/setup');

const USER = { username: 'pwdchange', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };
const NEW_PASSWORD = 'An0ther!Str0ng#Passphrase7';

function getCookie(res, name) {
    const raw = (res.headers['set-cookie'] || []).find(c => c.startsWith(name + '='));
    return raw ? raw.split(';')[0].split('=')[1] : null;
}

test('le changement de mot de passe invalide les sessions antérieures', async () => {
    await request(app).post('/api/auth/register').send(USER);
    const login = await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    const sessionCookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const oldRefresh = getCookie(login, 'refresh_token');

    // Récupère l'id utilisateur pour forger un access token antérieur (iat dans le passé)
    const me = await request(app).get('/api/auth/me').set('Cookie', sessionCookie);
    const userId = me.body.data.id;
    const staleToken = jwt.sign(
        { id: userId, username: USER.username, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) - 30 },
        process.env.JWT_SECRET
    );

    // Le token antérieur fonctionne AVANT le changement
    const before = await request(app).get('/api/auth/me').set('Cookie', `access_token=${staleToken}`);
    assert.strictEqual(before.status, 200, 'token antérieur valide avant changement');

    // Changement de mot de passe depuis la session courante légitime
    const change = await request(app).post('/api/auth/change-password')
        .set('Cookie', sessionCookie)
        .send({ currentPassword: USER.password, newPassword: NEW_PASSWORD });
    assert.strictEqual(change.status, 200);

    // 1) Le token antérieur est désormais rejeté
    const after = await request(app).get('/api/auth/me').set('Cookie', `access_token=${staleToken}`);
    assert.strictEqual(after.status, 401, 'token émis avant le changement doit être rejeté');

    // 2) La session courante survit grâce aux cookies ré-émis par change-password
    const freshAccess = getCookie(change, 'access_token');
    assert.ok(freshAccess, 'change-password ré-émet un access token');
    const current = await request(app).get('/api/auth/me').set('Cookie', `access_token=${freshAccess}`);
    assert.strictEqual(current.status, 200, 'la session courante reste active');

    // 3) L'ancien refresh est révoqué (toutes familles)
    const refresh = await request(app).post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${oldRefresh}`);
    assert.strictEqual(refresh.status, 401, 'refresh antérieur révoqué');
});
```

- [ ] **Step 2 : Lancer le test et vérifier qu'il échoue**

Run : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef node --test tests/password-change-invalidation.test.js`
Expected : FAIL — `after.status` vaut 200 (token antérieur toujours accepté) et/ou `refresh.status` vaut 200.

- [ ] **Step 3 : Ajouter la colonne `password_changed_at` (migration)**

Dans `AkinatorWeb/backend/services/database.js`, dans le bloc de migrations (après le `ALTER TABLE users ADD COLUMN a2f_last_step ...`) :

```javascript
    try {
        db.exec('ALTER TABLE users ADD COLUMN password_changed_at INTEGER');
    } catch (e) { /* Colonne existe déjà */ }
```

- [ ] **Step 4 : Ajouter `revokeAllUserFamilies` au tokenService**

Dans `AkinatorWeb/backend/services/tokenService.js`, ajouter la fonction (près de `revokeFamily`) :

```javascript
function revokeAllUserFamilies(userId) {
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(userId);
}
```

Et l'exporter dans `module.exports` (ajouter `revokeAllUserFamilies,`).

- [ ] **Step 5 : Ajouter la garde `iat` dans `authenticateToken`**

Dans `AkinatorWeb/backend/middleware/security.js`, dans `authenticateToken`, après le bloc `isJtiRevoked` et avant `req.user = decoded; next();` :

```javascript
        // Invalidation globale au changement de mot de passe : tout access token
        // émis avant `password_changed_at` (secondes Unix) n'est plus honoré.
        // NB : granularité 1 s (iat en secondes) → un token émis dans la même
        // seconde que le changement survit (`<` strict). Compromis assumé qui
        // préserve la session courante ré-émise ; fenêtre ≤ 1 s vs TTL 15 min.
        // NB : ce findById ajoute un SELECT (PK indexée) par requête authentifiée.
        const account = queries.users.findById.get(decoded.id);
        if (!account) {
            return res.status(401).json({ success: false, error: 'Session invalide, veuillez vous reconnecter' });
        }
        if (account.password_changed_at && decoded.iat < account.password_changed_at) {
            return res.status(401).json({ success: false, error: 'Session expirée par changement de mot de passe' });
        }
```

(`queries` est déjà importé en tête de fichier.)

- [ ] **Step 6 : Ajouter la même garde dans `optionalAuth`**

Dans `optionalAuth`, dans le bloc `if (!isJtiRevoked(decoded.jti)) { req.user = decoded; }`, remplacer par une version qui vérifie aussi `password_changed_at` :

```javascript
            if (!isJtiRevoked(decoded.jti)) {
                const account = queries.users.findById.get(decoded.id);
                if (account && !(account.password_changed_at && decoded.iat < account.password_changed_at)) {
                    req.user = decoded;
                }
            }
```

(Adapter au nom local : `isJtiRevoked` est require-é dans le bloc existant — conserver ce require.)

- [ ] **Step 7 : Câbler `/change-password` (invalidation + ré-émission)**

Dans `AkinatorWeb/backend/routes/auth.js`, dans le handler `/change-password`, **remplacer intégralement** le bloc allant de `const updateStmt = require('../services/database').db.prepare(...)` (la mise à jour du hash) jusqu'au `res.json({ success: true, message: 'Mot de passe mis à jour avec succès' })` inclus — c.-à-d. l'ancien `updateStmt`/`updateStmt.run(...)`, le `console.log`, le `appendAudit`, ET l'ancien `res.json`. Ne PAS insérer en plus de l'existant (sinon double envoi → « Cannot set headers after they are sent »). Le bloc de remplacement, placé après le calcul de `newPasswordHash` :

```javascript
            const nowSec = Math.floor(Date.now() / 1000);
            require('../services/database').db.prepare(
                'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?'
            ).run(newPasswordHash, nowSec, user.id);

            // Révoquer toutes les familles de refresh (déconnecte les autres sessions)
            tokenService.revokeAllUserFamilies(user.id);

            // Ré-émettre une paire fraîche pour la session courante (elle survit ;
            // son nouvel access token a iat >= password_changed_at).
            const refreshedUser = queries.users.findById.get(user.id);
            const { accessToken, refreshToken } = tokenService.issueTokenPair(refreshedUser);
            setAuthCookies(res, accessToken, refreshToken);

            console.log(`🔐 Mot de passe changé: ${user.username}`);
            appendAudit('auth.password.changed', { userId: user.id });

            res.json({
                success: true,
                message: 'Mot de passe mis à jour avec succès'
            });
```

Supprimer l'ancien `const updateStmt = ...; updateStmt.run(...)` et l'ancien `res.json` en double pour éviter un double envoi.

- [ ] **Step 8 : Câbler `/forgot-password` (invalidation)**

Dans le handler `/forgot-password`, après le `UPDATE users SET password_hash = ? WHERE id = ?` existant, ajouter :

```javascript
            const nowSec = Math.floor(Date.now() / 1000);
            require('../services/database').db.prepare(
                'UPDATE users SET password_changed_at = ? WHERE id = ?'
            ).run(nowSec, user.id);
            tokenService.revokeAllUserFamilies(user.id);
            appendAudit('auth.password.reset', { userId: user.id });
```

(Aucune ré-émission : l'utilisateur se reconnecte ensuite.)

- [ ] **Step 9 : Lancer le nouveau test et vérifier qu'il passe**

Run : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef node --test tests/password-change-invalidation.test.js`
Expected : PASS.

- [ ] **Step 10 : Lancer toute la suite (non-régression)**

Run : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef npm test`
Expected : PASS, 39 tests, 0 échec.

- [ ] **Step 11 : Commit**

```bash
git add AkinatorWeb/backend/services/database.js AkinatorWeb/backend/services/tokenService.js AkinatorWeb/backend/middleware/security.js AkinatorWeb/backend/routes/auth.js AkinatorWeb/backend/tests/password-change-invalidation.test.js
git commit -m "fix(auth): invalide toutes les sessions au changement/réinitialisation de mot de passe"
```

---

### Task 3 : `sanitizeInput` ne doit plus altérer les champs sensibles

**Contexte :** `sanitizeInput` retire les balises HTML de **toutes** les chaînes du body, y compris les mots de passe : `Ab1<x>cd` devient `Ab1cd` avant le hash bcrypt, ce qui peut casser une connexion ultérieure. Correctif : exclure de la mutation les champs sensibles (mots de passe, codes).

**Files:**
- Modify: `AkinatorWeb/backend/middleware/security.js` (fonction `sanitizeInput` ~L235-260)
- Test: `AkinatorWeb/backend/tests/sanitize-sensitive.test.js` (créer)

**Interfaces:**
- Consumes : rien de nouveau.
- Produces : `sanitizeInput` laisse intacts les champs `password`, `currentPassword`, `newPassword`, `code`, `a2fCode` ; continue de nettoyer les autres chaînes.

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `AkinatorWeb/backend/tests/sanitize-sensitive.test.js` :

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeInput } = require('../middleware/security');

function run(body) {
    const req = { body, query: {}, params: {} };
    let called = false;
    sanitizeInput(req, {}, () => { called = true; });
    assert.ok(called, 'next() doit être appelé');
    return req.body;
}

test('sanitizeInput ne modifie pas les champs de mot de passe', () => {
    const out = run({ password: 'Ab1<x>Cd!ef', newPassword: 'Zz9<b>Yy!ww', currentPassword: 'Qq2<i>Ww!ee' });
    assert.strictEqual(out.password, 'Ab1<x>Cd!ef');
    assert.strictEqual(out.newPassword, 'Zz9<b>Yy!ww');
    assert.strictEqual(out.currentPassword, 'Qq2<i>Ww!ee');
});

test('sanitizeInput ne modifie pas les codes (code, a2fCode)', () => {
    const out = run({ code: 'a1<b>c2', a2fCode: '12<i>34' });
    assert.strictEqual(out.code, 'a1<b>c2');
    assert.strictEqual(out.a2fCode, '12<i>34');
});

test('sanitizeInput nettoie toujours les champs non sensibles', () => {
    const out = run({ username: 'bob<script>alert(1)</script>' });
    assert.ok(!out.username.includes('<'), 'les balises HTML sont retirées des champs normaux');
});
```

- [ ] **Step 2 : Lancer le test et vérifier qu'il échoue**

Run : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef node --test tests/sanitize-sensitive.test.js`
Expected : FAIL — `out.password` vaut `Ab1Cd!ef` (balise retirée) au lieu de la valeur d'origine.

- [ ] **Step 3 : Exclure les champs sensibles dans `sanitizeInput`**

Dans `AkinatorWeb/backend/middleware/security.js`, modifier `sanitizeInput`. Ajouter en tête de fonction la liste et passer la clé à `sanitize` :

```javascript
const sanitizeInput = (req, res, next) => {
    // Champs jamais mutés : leur contenu est un secret vérifié/hashé tel quel.
    const SENSITIVE_KEYS = new Set(['password', 'currentPassword', 'newPassword', 'code', 'a2fCode']);

    const sanitize = (obj) => {
        if (typeof obj === 'string') {
            return obj
                .replace(/<[^>]*>/g, '')
                .replace(/javascript:/gi, '')
                .replace(/on\w+=/gi, '')
                .trim()
                .slice(0, 1000);
        }
        if (typeof obj === 'object' && obj !== null) {
            for (const key in obj) {
                if (SENSITIVE_KEYS.has(key)) continue; // ne pas altérer les secrets
                obj[key] = sanitize(obj[key]);
            }
        }
        return obj;
    };

    req.body = sanitize(req.body);
    req.query = sanitize(req.query);
    req.params = sanitize(req.params);

    next();
};
```

- [ ] **Step 4 : Lancer le test et vérifier qu'il passe**

Run : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef node --test tests/sanitize-sensitive.test.js`
Expected : PASS (3 tests).

- [ ] **Step 5 : Lancer toute la suite (non-régression)**

Run : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef npm test`
Expected : PASS, 42 tests, 0 échec.

- [ ] **Step 6 : Commit**

```bash
git add AkinatorWeb/backend/middleware/security.js AkinatorWeb/backend/tests/sanitize-sensitive.test.js
git commit -m "fix(security): sanitizeInput n'altère plus les mots de passe et codes"
```

---

### Task 4 : Cohérence documentaire (durée de vie des tokens) — MÉCANIQUE

**Contexte :** Le README décrit encore « JWT (HS256, expiration 24 h) » dans le tableau Sécurité, alors que le modèle réel est access token 15 min + refresh rotatif 7 j. Aligner la doc. Ajouter aussi un commentaire clarifiant que `sessions.expires_at` (`+24 hours`) est un enregistrement d'audit indépendant de la durée de vie des tokens.

**Files:**
- Modify: `README.md` (tableau Sécurité, ligne « JWT »)
- Modify: `AkinatorWeb/backend/routes/auth.js` (commentaire au-dessus de l'INSERT `sessions` dans `/login`, ~L261-266)

**Interfaces:**
- Consumes : rien.
- Produces : documentation cohérente (pas de changement de comportement, pas de test).

- [ ] **Step 1 : Corriger la ligne JWT du README**

Dans `README.md`, remplacer la ligne du tableau Sécurité :

```
| **JWT** | Authentification par token signé (HS256, expiration 24 h) |
```

par :

```
| **JWT** | Access token court (HS256, 15 min) + refresh token rotatif httpOnly (7 j) avec détection de réutilisation |
```

- [ ] **Step 2 : Clarifier le commentaire sessions dans auth.js**

Dans `AkinatorWeb/backend/routes/auth.js`, au-dessus du bloc `try { const { db } = ...; db.prepare(...INSERT INTO sessions...)` dans `/login`, remplacer le commentaire `// Logger la session (audit trail)` par :

```javascript
            // Enregistrement d'audit de session (indépendant des tokens JWT :
            // sert au journal de connexions, pas à la validité de l'access token).
```

- [ ] **Step 3 : Vérifier que rien n'est cassé**

Run : `JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef npm test`
Expected : PASS, 42 tests, 0 échec (aucune régression : changements documentaires uniquement).

- [ ] **Step 4 : Commit**

```bash
git add README.md AkinatorWeb/backend/routes/auth.js
git commit -m "docs: aligne la description de la durée de vie des tokens (15 min access + refresh 7 j)"
```

---

## Notes de séquencement

Les tâches 1, 2 et 3 modifient toutes `middleware/security.js` et doivent être exécutées **séquentiellement** (chaque implémenteur voit le commit du précédent). La tâche 2 modifie aussi `routes/auth.js` que la tâche 4 touche ensuite (zones distinctes). Ordre imposé : 1 → 2 → 3 → 4.
