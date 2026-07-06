# Améliorations de sécurité — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implémenter les 10 améliorations de sécurité de `ameliorations-secu.md` : auth moderne (access court + refresh rotatif en cookies httpOnly), journal d'audit inviolable, durcissement 2FA/mots de passe/anti-énumération, pipeline CI sécurité, gestion des secrets, et robustesse applicative.

**Architecture:** Backend Express + better-sqlite3 existant (`AkinatorWeb/backend`). On persiste tout ce qui était en mémoire (blacklist, refresh tokens, CSRF) dans SQLite ; Redis reste optionnel via `REDIS_URL`. Chaque lot est livrable indépendamment. Le Lot 0 pose le harnais de test (node:test + supertest), prérequis au TDD de tous les autres lots.

**Tech Stack:** Node 20.11 (CommonJS), Express 4, better-sqlite3, jsonwebtoken, speakeasy, sharp/multer, helmet, express-rate-limit. Nouveaux : supertest (dev), cookie-parser, zxcvbn. CI : GitHub Actions (gitleaks, CodeQL, npm audit, ZAP baseline).

## Global Constraints

- Node **20.11.0** (`AkinatorWeb/.node-version`), CommonJS (`require`), pas de TypeScript.
- Racine git : `/home/valentin/AkinatorTwitch` ; application : `AkinatorWeb/backend` ; frontend statique : `AkinatorWeb/frontend`. Les workflows CI vont dans `.github/` **à la racine du dépôt**.
- Toutes les réponses API gardent le format existant `{ success: boolean, data?|error? }`, messages d'erreur **en français**.
- Style de code existant : commentaires français, logs avec emoji (`✅`, `❌`, `⚠️`).
- Tests : `node --test` + supertest, commande `npm test` exécutée depuis `AkinatorWeb/backend`.
- JWT : algorithme HS256 conservé (`config.jwt.algorithm`).
- Aucune nouvelle infrastructure obligatoire : Redis uniquement si `REDIS_URL` est défini.
- Ne jamais committer `backend/.env` ni `backend/data/*.db*` (vérifier `.gitignore` avant chaque commit).

## Structure des fichiers (vue d'ensemble)

| Fichier | Rôle | Lot |
|---|---|---|
| `AkinatorWeb/backend/tests/helpers/setup.js` | Bootstrap env de test + app + DB temporaire | 0 |
| `AkinatorWeb/backend/services/tokenService.js` | Access/refresh tokens, rotation, reuse detection, révocation persistée | 1 |
| `AkinatorWeb/backend/services/auditService.js` | Journal d'audit append-only à chaînage de hash | 2 |
| `AkinatorWeb/backend/services/passwordService.js` | zxcvbn + HaveIBeenPwned (k-anonymity) | 3 |
| `AkinatorWeb/backend/services/twoFactor.js` | TOTP anti-rejeu + codes de secours | 3 |
| `.github/workflows/security.yml`, `codeql.yml`, `zap.yml`, `.github/dependabot.yml`, `.gitleaks.toml`, `.githooks/pre-commit` | Pipeline CI sécurité | 4 |
| `AkinatorWeb/backend/scripts/generate-keys.js`, `scripts/rotate-encryption-key.js`, `SECURITY.md` | Gestion/rotation des secrets | 4 |
| `AkinatorWeb/backend/middleware/csrf.js` (réécriture SQLite) | Stores persistants | 5 |

---

# Lot 0 — Fondations de test (prérequis à tout le reste)

### Task 1: Harnais de test (node:test + supertest)

**Files:**
- Modify: `AkinatorWeb/backend/package.json` (script `test`, devDependency `supertest`)
- Modify: `AkinatorWeb/backend/server.js:325` (exporter `app`, ne démarrer que si module principal)
- Modify: `AkinatorWeb/backend/config/config.js:34` (ajouter `isTest`)
- Modify: `AkinatorWeb/backend/middleware/security.js:56-87` (limiteurs très permissifs en test)
- Create: `AkinatorWeb/backend/tests/helpers/setup.js`
- Test: `AkinatorWeb/backend/tests/health.test.js`

**Interfaces:**
- Produces: `require('./helpers/setup')` → `{ app, db }` — utilisé par TOUS les tests des lots suivants. `app` est l'app Express non démarrée (supertest), `db` la connexion better-sqlite3 vers une base temporaire jetable.
- Produces: `config.isTest` (booléen, `NODE_ENV === 'test'`).

- [ ] **Step 1: Installer supertest**

```bash
cd /home/valentin/AkinatorTwitch/AkinatorWeb/backend && npm install --save-dev supertest
```

- [ ] **Step 2: Écrire le helper et le test (échec attendu)**

`tests/helpers/setup.js` :

```js
/**
 * Bootstrap des tests : environnement isolé + base temporaire.
 * À require AVANT tout module applicatif (fige les variables d'env).
 */
const path = require('path');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secret-de-test-0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `akinator-test-${process.pid}-${Date.now()}.db`);

const { app } = require('../../server');
const { db, initializeTables } = require('../../services/database');

initializeTables();

module.exports = { app, db };
```

`tests/health.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

test('GET /api/health répond 200 avec success:true', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
});
```

- [ ] **Step 3: Vérifier l'échec**

Run: `cd /home/valentin/AkinatorTwitch/AkinatorWeb/backend && node --test tests/`
Expected: FAIL — `app` est `undefined` (server.js n'exporte rien) et le serveur tente de démarrer à l'import.

- [ ] **Step 4: Refactorer server.js, config.js, security.js**

Dans `server.js`, remplacer la dernière ligne `startServer();` par :

```js
// Démarrer uniquement si lancé directement (pas en test)
if (require.main === module) {
    startServer();
}

module.exports = { app };
```

Dans `config/config.js`, sous `isDev` (ligne 34) ajouter :

```js
    isTest: process.env.NODE_ENV === 'test',
```

Dans `middleware/security.js`, rendre les limiteurs inoffensifs en test (le comportement prod ne change pas) :

```js
// authLimiter
    max: config.isTest ? 10000 : 10,
// registerLimiter
    max: config.isTest ? 10000 : (config.isDev ? 50 : 10),
// paymentLimiter
    max: config.isTest ? 10000 : 3,
// globalLimiter
    max: config.isTest ? 10000 : config.security.rateLimitMaxRequests,
```

Dans `package.json`, section scripts :

```json
"test": "node --test tests/"
```

- [ ] **Step 5: Vérifier le succès**

Run: `cd /home/valentin/AkinatorTwitch/AkinatorWeb/backend && npm test`
Expected: PASS (1 test). Vérifier aussi que le serveur démarre toujours : `node server.js` affiche la bannière puis Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add AkinatorWeb/backend/package.json AkinatorWeb/backend/server.js AkinatorWeb/backend/config/config.js AkinatorWeb/backend/middleware/security.js AkinatorWeb/backend/tests/
git commit -m "test: harnais node:test + supertest, app exportée"
```

---

# Lot 1 — Auth moderne : access 15 min + refresh rotatif en cookies httpOnly (spec #1)

### Task 2: Service de tokens (rotation + reuse detection + révocation persistée)

**Files:**
- Modify: `AkinatorWeb/backend/services/database.js:145-156` (tables `refresh_tokens` et `revoked_tokens` dans `initializeTables`)
- Create: `AkinatorWeb/backend/services/tokenService.js`
- Test: `AkinatorWeb/backend/tests/token-service.test.js`

**Interfaces:**
- Consumes: `{ db }` de `services/database.js`, `config.jwt` de `config/config.js`.
- Produces (utilisé par Task 3) :
  - `signAccessToken(user)` → JWT string 15 min avec claims `{ id, username, is_admin, jti }`
  - `issueTokenPair(user)` → `{ accessToken: string, refreshToken: string, familyId: string }`
  - `rotateRefreshToken(presentedToken)` → `{ ok: true, userId, newToken }` ou `{ ok: false, reason: 'unknown'|'reuse'|'expired' }`
  - `revokeFamily(familyId)`, `revokeFamilyByToken(presentedToken)`
  - `revokeAccessToken(decodedPayload)` (insère le `jti` en base jusqu'à expiration)
  - `isJtiRevoked(jti)` → boolean
  - `purgeExpiredTokens()` → nombre de lignes supprimées

- [ ] **Step 1: Écrire les tests (échec attendu)**

`tests/token-service.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const tokenService = require('../services/tokenService');
const { v4: uuidv4 } = require('uuid');

function createUser() {
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(id, `user_${id.slice(0, 8)}`, 'x');
    return { id, username: `user_${id.slice(0, 8)}`, is_admin: 0 };
}

test('issueTokenPair retourne un couple access/refresh', () => {
    const pair = tokenService.issueTokenPair(createUser());
    assert.ok(pair.accessToken.split('.').length === 3, 'access = JWT');
    assert.ok(pair.refreshToken.length >= 64, 'refresh = jeton opaque');
    assert.ok(pair.familyId);
});

test('rotateRefreshToken émet un nouveau jeton et invalide l\'ancien', () => {
    const pair = tokenService.issueTokenPair(createUser());
    const r1 = tokenService.rotateRefreshToken(pair.refreshToken);
    assert.strictEqual(r1.ok, true);
    assert.notStrictEqual(r1.newToken, pair.refreshToken);
    // Réutilisation de l'ancien jeton → reuse détecté
    const r2 = tokenService.rotateRefreshToken(pair.refreshToken);
    assert.deepStrictEqual({ ok: r2.ok, reason: r2.reason }, { ok: false, reason: 'reuse' });
    // ... et toute la famille est révoquée, y compris le jeton frais
    const r3 = tokenService.rotateRefreshToken(r1.newToken);
    assert.strictEqual(r3.ok, false);
});

test('jti révoqué est détecté', () => {
    const user = createUser();
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(tokenService.signAccessToken(user));
    assert.strictEqual(tokenService.isJtiRevoked(decoded.jti), false);
    tokenService.revokeAccessToken(decoded);
    assert.strictEqual(tokenService.isJtiRevoked(decoded.jti), true);
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm test`
Expected: FAIL — `Cannot find module '../services/tokenService'`.

- [ ] **Step 3: Créer les tables et le service**

Dans `services/database.js`, après la table `sessions` (ligne ~145), ajouter :

```js
    // Jetons de rafraîchissement (rotation + détection de réutilisation)
    db.exec(`
        CREATE TABLE IF NOT EXISTS refresh_tokens (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            family_id TEXT NOT NULL,
            token_hash TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            used_at DATETIME,
            revoked INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // Blacklist persistante des access tokens révoqués (par jti)
    db.exec(`
        CREATE TABLE IF NOT EXISTS revoked_tokens (
            jti TEXT PRIMARY KEY,
            expires_at DATETIME NOT NULL
        )
    `);
```

Et dans le bloc d'index existant (ligne ~148) :

```sql
        CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
```

`services/tokenService.js` (complet) :

```js
/**
 * Service de jetons : access court (15 min) + refresh rotatif.
 * - Refresh opaque (96 hex), stocké hashé (SHA-256) en base.
 * - Rotation : chaque refresh n'est utilisable qu'une fois.
 * - Reuse detection : un refresh déjà utilisé/révoqué qui resurgit
 *   → toute la famille est révoquée (vol probable).
 * - Blacklist access persistante par jti.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/config');
const { db } = require('./database');

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TTL_DAYS = 7;

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            is_admin: user.is_admin === 1,
            jti: uuidv4()
        },
        config.jwt.secret,
        { expiresIn: ACCESS_TOKEN_TTL, algorithm: config.jwt.algorithm }
    );
}

function issueRefreshToken(userId, familyId = null) {
    const token = crypto.randomBytes(48).toString('hex');
    const family = familyId || uuidv4();
    db.prepare(`
        INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
        VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' days'))
    `).run(uuidv4(), userId, family, hashToken(token), REFRESH_TTL_DAYS);
    return { token, familyId: family };
}

function issueTokenPair(user) {
    const { token: refreshToken, familyId } = issueRefreshToken(user.id);
    return { accessToken: signAccessToken(user), refreshToken, familyId };
}

function revokeFamily(familyId) {
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE family_id = ?').run(familyId);
}

function revokeFamilyByToken(presentedToken) {
    const row = db.prepare('SELECT family_id FROM refresh_tokens WHERE token_hash = ?')
        .get(hashToken(presentedToken));
    if (row) revokeFamily(row.family_id);
}

function rotateRefreshToken(presentedToken) {
    const row = db.prepare(`
        SELECT *, (expires_at < datetime('now')) AS expired
        FROM refresh_tokens WHERE token_hash = ?
    `).get(hashToken(presentedToken));

    if (!row) return { ok: false, reason: 'unknown' };

    if (row.revoked || row.used_at) {
        // Réutilisation détectée → vol probable → révocation de toute la famille
        revokeFamily(row.family_id);
        return { ok: false, reason: 'reuse' };
    }
    if (row.expired) return { ok: false, reason: 'expired' };

    db.prepare(`UPDATE refresh_tokens SET used_at = datetime('now') WHERE id = ?`).run(row.id);
    const { token } = issueRefreshToken(row.user_id, row.family_id);
    return { ok: true, userId: row.user_id, newToken: token };
}

function revokeAccessToken(decodedPayload) {
    if (!decodedPayload || !decodedPayload.jti) return;
    const expiresAt = new Date((decodedPayload.exp || 0) * 1000).toISOString();
    db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)')
        .run(decodedPayload.jti, expiresAt);
}

function isJtiRevoked(jti) {
    if (!jti) return false;
    return !!db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(jti);
}

function purgeExpiredTokens() {
    const a = db.prepare(`DELETE FROM refresh_tokens WHERE expires_at < datetime('now')`).run();
    const b = db.prepare(`DELETE FROM revoked_tokens WHERE expires_at < datetime('now')`).run();
    return a.changes + b.changes;
}

module.exports = {
    signAccessToken,
    issueTokenPair,
    rotateRefreshToken,
    revokeFamily,
    revokeFamilyByToken,
    revokeAccessToken,
    isJtiRevoked,
    purgeExpiredTokens,
    ACCESS_TOKEN_TTL,
    REFRESH_TTL_DAYS
};
```

- [ ] **Step 4: Vérifier le succès**

Run: `npm test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/services/database.js AkinatorWeb/backend/services/tokenService.js AkinatorWeb/backend/tests/token-service.test.js
git commit -m "feat(auth): service de tokens avec rotation, reuse detection et révocation persistée"
```

### Task 3: Cookies httpOnly + endpoints /refresh, /logout + middleware

**Files:**
- Modify: `AkinatorWeb/backend/server.js` (cookie-parser)
- Modify: `AkinatorWeb/backend/routes/auth.js` (login, register, verify-login-a2f, logout, nouveau /refresh)
- Modify: `AkinatorWeb/backend/middleware/security.js:92-132` (`authenticateToken` lit le cookie, blacklist persistante)
- Modify: `AkinatorWeb/backend/config/config.js:39` (`expiresIn: '15m'`)
- Test: `AkinatorWeb/backend/tests/auth-cookies.test.js`

**Interfaces:**
- Consumes: `tokenService` (Task 2).
- Produces: cookies `access_token` (path `/`, 15 min) et `refresh_token` (path `/api/auth`, 7 j), tous deux `httpOnly; Secure (hors dev/test); SameSite=Strict`. Endpoints `POST /api/auth/refresh` et `POST /api/auth/logout`. Le corps de `login`/`register` contient encore `token` (compat transitoire, retiré en Task 4).

- [ ] **Step 1: Installer cookie-parser**

```bash
cd /home/valentin/AkinatorTwitch/AkinatorWeb/backend && npm install cookie-parser
```

- [ ] **Step 2: Écrire les tests (échec attendu)**

`tests/auth-cookies.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

const USER = { username: 'cookieuser', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

function getCookie(res, name) {
    const raw = (res.headers['set-cookie'] || []).find(c => c.startsWith(name + '='));
    return raw ? raw.split(';')[0].split('=')[1] : null;
}

test('register pose les cookies access_token et refresh_token httpOnly', async () => {
    const res = await request(app).post('/api/auth/register').send(USER);
    assert.strictEqual(res.status, 201);
    const cookies = res.headers['set-cookie'].join(' ');
    assert.match(cookies, /access_token=/);
    assert.match(cookies, /refresh_token=/);
    assert.match(cookies, /HttpOnly/i);
    assert.match(cookies, /SameSite=Strict/i);
});

test('une route protégée accepte le cookie access_token', async () => {
    const login = await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    const access = getCookie(login, 'access_token');
    const me = await request(app).get('/api/auth/me').set('Cookie', `access_token=${access}`);
    assert.strictEqual(me.status, 200);
});

test('POST /api/auth/refresh fait tourner le refresh token', async () => {
    const login = await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    const refresh = getCookie(login, 'refresh_token');

    const r1 = await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${refresh}`);
    assert.strictEqual(r1.status, 200);
    assert.ok(getCookie(r1, 'access_token'), 'nouveau access token posé');

    // Rejouer l'ancien refresh → 401 (reuse) et famille révoquée
    const r2 = await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${refresh}`);
    assert.strictEqual(r2.status, 401);
    const r3 = await request(app).post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${getCookie(r1, 'refresh_token')}`);
    assert.strictEqual(r3.status, 401, 'toute la famille est révoquée');
});

test('logout révoque l\'access token (blacklist persistante)', async () => {
    const login = await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    const access = getCookie(login, 'access_token');
    const cookieHeader = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookieHeader);
    assert.strictEqual(out.status, 200);
    const me = await request(app).get('/api/auth/me').set('Cookie', `access_token=${access}`);
    assert.strictEqual(me.status, 401, 'jeton révoqué même avant expiration');
});
```

- [ ] **Step 3: Vérifier l'échec**

Run: `npm test`
Expected: FAIL — pas de cookies posés, `/api/auth/refresh` renvoie 404.

- [ ] **Step 4: Implémenter**

`server.js` — après le bloc `express.json` (ligne ~61) :

```js
// Cookies httpOnly (access/refresh tokens)
const cookieParser = require('cookie-parser');
app.use(cookieParser());
```

`config/config.js` — durée de l'access token :

```js
    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: '15m',
        algorithm: 'HS256'
    },
```

`routes/auth.js` — en tête de fichier, importer le service et définir les helpers :

```js
const tokenService = require('../services/tokenService');

/** Pose les cookies d'authentification httpOnly */
function setAuthCookies(res, accessToken, refreshToken) {
    const secure = process.env.NODE_ENV === 'production';
    res.cookie('access_token', accessToken, {
        httpOnly: true, secure, sameSite: 'strict',
        maxAge: 15 * 60 * 1000, path: '/'
    });
    res.cookie('refresh_token', refreshToken, {
        httpOnly: true, secure, sameSite: 'strict',
        maxAge: tokenService.REFRESH_TTL_DAYS * 24 * 3600 * 1000,
        path: '/api/auth' // envoyé uniquement à /api/auth/refresh et /api/auth/logout
    });
}

function clearAuthCookies(res) {
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/api/auth' });
}
```

Dans **register** (ligne ~119) et **login** (ligne ~253) et **verify-login-a2f** (ligne ~477), remplacer la génération `jwt.sign(...)` par :

```js
        const { accessToken, refreshToken } = tokenService.issueTokenPair(user); // register: ({ id: userId, username, is_admin: 0 })
        setAuthCookies(res, accessToken, refreshToken);
        const token = accessToken; // compat transitoire : encore renvoyé dans le body, retiré en Task 4
```

(la variable `token` renvoyée dans le body existant reste inchangée).

Supprimer l'ancien `tokenBlacklist` (Set en mémoire, en tête de `routes/auth.js`) et réécrire **logout** (ligne ~769) :

```js
router.post('/logout', authenticateToken, (req, res) => {
    // Révoquer l'access token courant (blacklist persistante par jti)
    tokenService.revokeAccessToken(req.user);
    // Révoquer la famille de refresh tokens si le cookie est présent
    if (req.cookies && req.cookies.refresh_token) {
        tokenService.revokeFamilyByToken(req.cookies.refresh_token);
    }
    clearAuthCookies(res);
    res.json({ success: true, message: 'Déconnexion réussie' });
});
```

Nouveau endpoint **refresh** (avant `module.exports`) :

```js
/**
 * POST /api/auth/refresh
 * Rotation du refresh token (cookie httpOnly). Pas d'access token requis.
 */
router.post('/refresh', (req, res) => {
    const presented = req.cookies && req.cookies.refresh_token;
    if (!presented) {
        return res.status(401).json({ success: false, error: 'Session absente, veuillez vous reconnecter' });
    }

    const result = tokenService.rotateRefreshToken(presented);
    if (!result.ok) {
        clearAuthCookies(res);
        const error = result.reason === 'reuse'
            ? 'Réutilisation de jeton détectée, session révoquée par sécurité'
            : 'Session expirée, veuillez vous reconnecter';
        if (result.reason === 'reuse') {
            console.warn('⚠️ SECURITY: réutilisation de refresh token détectée');
        }
        return res.status(401).json({ success: false, error });
    }

    const user = queries.users.findById.get(result.userId);
    if (!user) {
        clearAuthCookies(res);
        return res.status(401).json({ success: false, error: 'Utilisateur introuvable' });
    }

    setAuthCookies(res, tokenService.signAccessToken(user), result.newToken);
    res.json({ success: true });
});
```

`middleware/security.js` — réécrire `authenticateToken` :

```js
const authenticateToken = (req, res, next) => {
    // Priorité au cookie httpOnly ; header Authorization conservé en compat
    const authHeader = req.headers['authorization'];
    const token = (req.cookies && req.cookies.access_token)
        || (authHeader && authHeader.split(' ')[1]);

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Token d\'authentification requis'
        });
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret, {
            algorithms: [config.jwt.algorithm]
        });

        // Blacklist persistante (révocation au logout)
        const { isJtiRevoked } = require('../services/tokenService');
        if (isJtiRevoked(decoded.jti)) {
            return res.status(401).json({
                success: false,
                error: 'Token révoqué, veuillez vous reconnecter'
            });
        }

        req.user = decoded;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                error: 'Token expiré, veuillez vous reconnecter'
            });
        }
        return res.status(403).json({
            success: false,
            error: 'Token invalide'
        });
    }
};
```

(supprimer le bloc `require('../routes/auth').tokenBlacklist` des lignes 103-112, et adapter `optionalAuth` pour lire aussi `req.cookies.access_token`).

Ajouter la purge dans `services/cleanup.js` → dans `runFullCleanup()`, appeler `require('./tokenService').purgeExpiredTokens()` et l'ajouter au total.

- [ ] **Step 5: Vérifier le succès**

Run: `npm test`
Expected: PASS (tous les tests, y compris ceux des tâches précédentes).

- [ ] **Step 6: Commit**

```bash
git add AkinatorWeb/backend/server.js AkinatorWeb/backend/routes/auth.js AkinatorWeb/backend/middleware/security.js AkinatorWeb/backend/config/config.js AkinatorWeb/backend/services/cleanup.js AkinatorWeb/backend/package.json AkinatorWeb/backend/tests/auth-cookies.test.js
git commit -m "feat(auth): access 15 min + refresh rotatif en cookies httpOnly, logout persistant"
```

### Task 4: Frontend en mode cookies (fin du localStorage)

**Files:**
- Modify: `AkinatorWeb/frontend/js/api.js` (supprimer localStorage, `credentials`, auto-refresh sur 401)
- Modify: `AkinatorWeb/frontend/js/app.js` (bootstrap de session via `/auth/me`, appels `setToken` remplacés)
- Modify: `AkinatorWeb/backend/routes/auth.js` (retirer `token` du body des réponses login/register/verify-login-a2f)
- Test: `AkinatorWeb/backend/tests/auth-cookies.test.js` (assertion : plus de token dans le body)

**Interfaces:**
- Consumes: cookies + `POST /api/auth/refresh` (Task 3).
- Produces: `API.bootstrapSession()` → `user|null` (appelé au chargement par `app.js`) ; `API.onLogin()` (remplace `setToken(token)` : rafraîchit juste le token CSRF) ; `API.logout()`.

- [ ] **Step 1: Ajouter l'assertion de non-régression côté backend**

Dans `tests/auth-cookies.test.js`, ajouter :

```js
test('le body de login ne contient plus de token (cookies uniquement)', async () => {
    const res = await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.token, undefined);
});
```

Run: `npm test` → FAIL (le token est encore dans le body).

- [ ] **Step 2: Retirer le token du body côté backend**

Dans `routes/auth.js`, supprimer la ligne de compat `const token = accessToken;` et la clé `token` des objets `data` renvoyés par register/login/verify-login-a2f (le `tempToken` du flux 2FA en attente, lui, reste dans le body : il est court et mono-usage).

Run: `npm test` → PASS.

- [ ] **Step 3: Adapter `frontend/js/api.js`**

Remplacer `setToken`/`loadToken` et la gestion du header Authorization :

```js
const API = {
    baseUrl: '/api',
    csrfToken: null,

    /** Appelé après login/register réussi : récupère un token CSRF */
    async onLogin() {
        await this.refreshCSRFToken();
    },

    /** Au chargement de la page : la session vit dans les cookies httpOnly */
    async bootstrapSession() {
        try {
            const response = await this.get('/auth/me');
            if (response.success) {
                await this.refreshCSRFToken();
                return response.data.user;
            }
        } catch (error) { /* pas de session active */ }
        return null;
    },

    async refreshCSRFToken() {
        try {
            const response = await this.get('/csrf-token');
            if (response.success) this.csrfToken = response.data.csrfToken;
        } catch (error) {
            console.warn('⚠️ Impossible de récupérer le token CSRF:', error);
        }
    },

    async request(endpoint, options = {}, isRetry = false) {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = { 'Content-Type': 'application/json', ...options.headers };

        if (this.csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method || 'GET')) {
            headers['X-CSRF-Token'] = this.csrfToken;
        }

        const response = await fetch(url, {
            ...options,
            headers,
            credentials: 'same-origin' // cookies httpOnly
        });

        // Access token expiré → tenter un refresh silencieux puis rejouer une fois
        if (response.status === 401 && !isRetry && endpoint !== '/auth/refresh' && endpoint !== '/auth/login') {
            const refreshed = await fetch(`${this.baseUrl}/auth/refresh`, {
                method: 'POST', credentials: 'same-origin'
            });
            if (refreshed.ok) {
                return this.request(endpoint, options, true);
            }
        }

        let data;
        try {
            data = await response.json();
        } catch (jsonError) {
            throw new Error(`Erreur serveur (${response.status}): Réponse invalide`);
        }
        if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
        return data;
    },
    // ... conserver get/post et les méthodes métier existantes,
    // en remplaçant chaque `this.setToken(x)` par `await this.onLogin()`
    // et `this.setToken(null)` par un POST /auth/logout + this.csrfToken = null.
};
```

- [ ] **Step 4: Adapter `frontend/js/app.js`**

Le code existant possède déjà `currentUser` (global, `app.js:10`) et `updateUIForLoggedInUser()` (`app.js:358`), et vérifie la session au chargement via un appel `/auth/me` (`app.js:~342-347`, motif `currentUser = response.data; updateUIForLoggedInUser();`). Réutiliser ces éléments plutôt que d'introduire une nouvelle UI. Remplacer l'initialisation basée sur `API.loadToken()` (`api.js:353`) par :

```js
const user = await API.bootstrapSession();
if (user) {
    currentUser = user;
    updateUIForLoggedInUser();
} else {
    updateUIForLoggedOutUser();
}
```

Chercher tous les usages restants et les convertir : `grep -rn "setToken\|loadToken\|auth_token\|localStorage" AkinatorWeb/frontend/js/`. Correspondances actuelles à traiter — `api.js:17` (`setToken`), `:48` (`loadToken`), `:124`/`:132`/`:166` (`this.setToken(response.data.token)` → `await this.onLogin()`), `:145` (`this.setToken(null)` sur logout → `await this.post('/auth/logout', {}); this.csrfToken = null;`), `:353` (`API.loadToken()` → `API.bootstrapSession()`). Supprimer `setToken`/`loadToken` et la propriété `this.token`.

**Attention (snippets illustratifs)** : les extraits `api.js`/`app.js` de cette tâche sont indicatifs — l'implémenteur DOIT lire les fichiers réels, conserver les méthodes métier existantes (`get`/`post`, appels IGDB, boutique, etc.) et n'y appliquer que les conversions ci-dessus. Aucun test automatisé ne couvre le frontend : la vérification est manuelle (Step 5). Ne pas copier-coller à l'aveugle.

- [ ] **Step 5: Vérification manuelle**

Run: `cd AkinatorWeb/backend && node server.js` puis dans le navigateur `http://localhost:3000` : inscription, connexion, F5 (session conservée), DevTools → Application → Cookies (`access_token` httpOnly présent, rien dans localStorage), déconnexion.

- [ ] **Step 6: Commit**

```bash
git add AkinatorWeb/frontend/js/api.js AkinatorWeb/frontend/js/app.js AkinatorWeb/backend/routes/auth.js AkinatorWeb/backend/tests/auth-cookies.test.js
git commit -m "feat(auth): frontend en cookies httpOnly, suppression du token en localStorage"
```

---

# Lot 2 — Journal d'audit inviolable (spec #2)

### Task 5: Service d'audit à chaînage de hash

**Files:**
- Modify: `AkinatorWeb/backend/services/database.js` (table `audit_log`)
- Create: `AkinatorWeb/backend/services/auditService.js`
- Test: `AkinatorWeb/backend/tests/audit-service.test.js`

**Interfaces:**
- Produces (utilisé par Task 6) :
  - `appendAudit(eventType, { userId, ipHash, details })` → ligne insérée avec `hash_n = SHA256(payload_n || hash_n-1)`
  - `verifyAuditChain()` → `{ valid: true, count }` ou `{ valid: false, brokenAt: id }`
- Le payload hashé est la chaîne `[event_type, user_id||'', ip_hash||'', details_json, created_at].join('|')` — déterministe, indépendant de JSON.stringify sur relecture.

- [ ] **Step 1: Écrire les tests (échec attendu)**

`tests/audit-service.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const { appendAudit, verifyAuditChain } = require('../services/auditService');

test('appendAudit chaîne les hashs et verifyAuditChain valide', () => {
    appendAudit('auth.login.success', { userId: 'u1', ipHash: 'abcd', details: { username: 'alice' } });
    appendAudit('admin.user.promote', { userId: 'admin1', details: { target: 'u2' } });
    appendAudit('payment.webhook.settled', { details: { invoiceId: 'inv_1' } });

    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
    assert.strictEqual(rows[0].prev_hash, 'GENESIS');
    assert.strictEqual(rows[1].prev_hash, rows[0].hash);
    assert.deepStrictEqual(verifyAuditChain(), { valid: true, count: 3 });
});

test('toute altération casse la chaîne', () => {
    db.prepare(`UPDATE audit_log SET details = '{"username":"eve"}' WHERE id = 1`).run();
    const result = verifyAuditChain();
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.brokenAt, 1);
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm test`
Expected: FAIL — `Cannot find module '../services/auditService'`.

- [ ] **Step 3: Implémenter**

Dans `services/database.js`, ajouter après `revoked_tokens` :

```js
    // Journal d'audit inviolable (append-only, chaînage de hash)
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            user_id TEXT,
            ip_hash TEXT,
            details TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            prev_hash TEXT NOT NULL,
            hash TEXT NOT NULL
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_type)`);
```

`services/auditService.js` (complet) :

```js
/**
 * Journal d'audit inviolable (tamper-evident).
 * Chaque entrée embarque hash_n = SHA256(payload_n || hash_n-1).
 * Toute modification/suppression a posteriori casse la chaîne,
 * détectable par verifyAuditChain() → non-répudiation / forensics.
 */
const crypto = require('crypto');
const { db } = require('./database');

function computeHash(eventType, userId, ipHash, detailsJson, createdAt, prevHash) {
    const payload = [eventType, userId || '', ipHash || '', detailsJson, createdAt].join('|');
    return crypto.createHash('sha256').update(payload + prevHash).digest('hex');
}

/**
 * Ajoute une entrée d'audit. Transaction : lecture du dernier hash
 * + insertion atomiques (pas de course sur prev_hash).
 */
const appendAudit = db.transaction((eventType, { userId = null, ipHash = null, details = {} } = {}) => {
    const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
    const prevHash = last ? last.hash : 'GENESIS';
    const createdAt = new Date().toISOString();
    const detailsJson = JSON.stringify(details);
    const hash = computeHash(eventType, userId, ipHash, detailsJson, createdAt, prevHash);

    db.prepare(`
        INSERT INTO audit_log (event_type, user_id, ip_hash, details, created_at, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventType, userId, ipHash, detailsJson, createdAt, prevHash, hash);
});

/** Revalide toute la chaîne. */
function verifyAuditChain() {
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
    let prevHash = 'GENESIS';
    for (const row of rows) {
        const expected = computeHash(
            row.event_type, row.user_id, row.ip_hash, row.details, row.created_at, prevHash
        );
        if (row.prev_hash !== prevHash || row.hash !== expected) {
            return { valid: false, brokenAt: row.id };
        }
        prevHash = row.hash;
    }
    return { valid: true, count: rows.length };
}

module.exports = { appendAudit, verifyAuditChain };
```

- [ ] **Step 4: Vérifier le succès**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/services/database.js AkinatorWeb/backend/services/auditService.js AkinatorWeb/backend/tests/audit-service.test.js
git commit -m "feat(audit): journal append-only avec chaînage de hash SHA-256"
```

### Task 6: Instrumentation des événements + endpoints admin

**Files:**
- Modify: `AkinatorWeb/backend/routes/auth.js` (login, register, logout, refresh, change-password, verify-login-a2f)
- Modify: `AkinatorWeb/backend/routes/admin.js` (promote, demote, delete, tokens, unlock, approve, reject)
- Modify: `AkinatorWeb/backend/routes/tokens.js` (`handleBTCPayWebhook`)
- Modify: `AkinatorWeb/backend/routes/a2f.js` (verify-setup → enabled, disable)
- Test: `AkinatorWeb/backend/tests/audit-events.test.js`

**Interfaces:**
- Consumes: `appendAudit`, `verifyAuditChain` (Task 5), `hashIPForLogging` de `services/encryption.js`.
- Produces: `GET /api/admin/audit?limit=100` → `{ success, data: { entries } }` ; `GET /api/admin/audit/verify` → `{ success, data: { valid, count | brokenAt } }`.
- Événements normalisés : `auth.register`, `auth.login.success`, `auth.login.failed`, `auth.login.locked`, `auth.logout`, `auth.refresh.reuse_detected`, `auth.password.changed`, `auth.2fa.success`, `auth.2fa.failed`, `a2f.enabled`, `a2f.disabled`, `admin.user.promote`, `admin.user.demote`, `admin.user.delete`, `admin.user.tokens`, `admin.user.unlock`, `admin.tx.approve`, `admin.tx.reject`, `payment.webhook.settled`.

- [ ] **Step 1: Écrire les tests (échec attendu)**

`tests/audit-events.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, db } = require('./helpers/setup');

const USER = { username: 'audituser', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

function lastEvent(type) {
    return db.prepare('SELECT * FROM audit_log WHERE event_type = ? ORDER BY id DESC LIMIT 1').get(type);
}

test('register et login (succès/échec) sont audités', async () => {
    await request(app).post('/api/auth/register').send(USER);
    assert.ok(lastEvent('auth.register'), 'auth.register journalisé');

    await request(app).post('/api/auth/login').send({ username: USER.username, password: 'mauvais-mdp-123!' });
    assert.ok(lastEvent('auth.login.failed'));

    await request(app).post('/api/auth/login').send({ username: USER.username, password: USER.password });
    assert.ok(lastEvent('auth.login.success'));
});

test('GET /api/admin/audit/verify répond avec l\'état de la chaîne', async () => {
    // Promouvoir l'utilisateur admin directement en base pour le test
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(USER.username);
    const login = await request(app).post('/api/auth/login').send({ username: USER.username, password: USER.password });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const res = await request(app).get('/api/admin/audit/verify').set('Cookie', cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.valid, true);
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm test`
Expected: FAIL — table `audit_log` vide (aucun événement), `/api/admin/audit/verify` → 404.

- [ ] **Step 3: Instrumenter**

En tête de `routes/auth.js` :

```js
const { appendAudit } = require('../services/auditService');
const { hashIPForLogging } = require('../services/encryption');
```

Variable IP : dans **register** (`auth.js:92`), **login** (`:173`) et **verify-login-a2f** (`:445`), la variable locale `rawIP` existe déjà et doit être réutilisée. Dans **logout**, **refresh** et **change-password**, elle n'est pas en portée → utiliser `req.ip` directement.

Points d'insertion (le motif est identique partout : une ligne après l'action réussie/échouée) :

```js
// register, après la création de l'utilisateur :
appendAudit('auth.register', { userId, ipHash: hashIPForLogging(rawIP), details: { username } });

// login, mot de passe invalide (avant le return 401) :
appendAudit('auth.login.failed', { userId: user.id, ipHash: hashIPForLogging(rawIP), details: { username } });

// login, compte verrouillé (return 423) :
appendAudit('auth.login.locked', { userId: user.id, ipHash: hashIPForLogging(rawIP) });

// login, succès (juste avant res.json) :
appendAudit('auth.login.success', { userId: user.id, ipHash: hashIPForLogging(rawIP) });

// verify-login-a2f : succès → 'auth.2fa.success', échec → 'auth.2fa.failed' (userId: decoded.id)

// logout :
appendAudit('auth.logout', { userId: req.user.id });

// refresh, branche reason === 'reuse' :
appendAudit('auth.refresh.reuse_detected', { ipHash: hashIPForLogging(req.ip) });

// change-password, succès :
appendAudit('auth.password.changed', { userId: user.id });
```

Dans `routes/admin.js` (même import), après chaque action réussie :

```js
appendAudit('admin.user.promote', { userId: req.user.id, details: { targetId: req.params.id } });
// idem pour demote / delete / tokens (details: { targetId, amount }) / unlock
// approve / reject : appendAudit('admin.tx.approve', { userId: req.user.id, details: { txId: req.params.id } })
```

Dans `routes/tokens.js`, dans `handleBTCPayWebhook` quand la facture est réglée et les jetons crédités :

```js
appendAudit('payment.webhook.settled', { userId, details: { invoiceId, tokens: tokensAmount } });
```

Dans `routes/a2f.js` : `a2f.enabled` après verify-setup réussi, `a2f.disabled` après disable.

Nouveaux endpoints dans `routes/admin.js` (les routes admin passent déjà par `authenticateToken` + `requireAdmin` — vérifier le montage en tête de fichier) :

```js
const { verifyAuditChain } = require('../services/auditService');

/** GET /api/admin/audit — dernières entrées du journal */
router.get('/audit', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const entries = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    res.json({ success: true, data: { entries } });
});

/** GET /api/admin/audit/verify — vérifie l'intégrité de la chaîne */
router.get('/audit/verify', async (req, res) => {
    res.json({ success: true, data: verifyAuditChain() });
});
```

Remarque : si `admin.js` applique `authenticateToken`/`requireAdmin` route par route plutôt que via `router.use`, ajouter les deux middlewares sur ces deux routes.

- [ ] **Step 4: Vérifier le succès**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/routes/ AkinatorWeb/backend/tests/audit-events.test.js
git commit -m "feat(audit): instrumentation login/admin/paiements + endpoints de vérification"
```

---

# Lot 3 — Durcissement de l'authentification (spec #3, #4, #5)

### Task 7: Détection de mots de passe compromis (HIBP + zxcvbn)

**Files:**
- Create: `AkinatorWeb/backend/services/passwordService.js`
- Modify: `AkinatorWeb/backend/routes/auth.js` (register, change-password, forgot-password)
- Test: `AkinatorWeb/backend/tests/password-service.test.js`

**Interfaces:**
- Produces: `validateNewPassword(password, username)` → `Promise<{ ok: true } | { ok: false, error: string }>` — appelé APRÈS la validation express-validator existante, AVANT le hash bcrypt.
- HIBP en **k-anonymity** : seuls les 5 premiers caractères du SHA-1 partent sur le réseau. **Fail-open** : si l'API est injoignable (timeout 3 s), on ne bloque pas l'inscription.
- `isPwnedPassword(password, fetchImpl)` accepte un `fetch` injectable pour les tests.

- [ ] **Step 1: Installer zxcvbn**

```bash
cd /home/valentin/AkinatorTwitch/AkinatorWeb/backend && npm install zxcvbn
```

- [ ] **Step 2: Écrire les tests (échec attendu)**

`tests/password-service.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers/setup');
const { validateNewPassword, isPwnedPassword } = require('../services/passwordService');
const crypto = require('crypto');

test('refuse un mot de passe faible (zxcvbn < 3)', async () => {
    const result = await validateNewPassword('Azerty123!', 'alice');
    assert.strictEqual(result.ok, false);
});

test('accepte un mot de passe fort non compromis', async () => {
    const fetchStub = async () => ({ ok: true, text: async () => 'AAAAA:1\r\nBBBBB:2' });
    const pwned = await isPwnedPassword('C0rrect!Horse#Battery9', fetchStub);
    assert.strictEqual(pwned, false);
});

test('détecte un mot de passe présent dans une fuite (k-anonymity)', async () => {
    const password = 'password123';
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const fetchStub = async (url) => {
        assert.ok(url.endsWith(sha1.slice(0, 5)), 'seuls 5 caractères du hash sont envoyés');
        return { ok: true, text: async () => `${sha1.slice(5)}:52579` };
    };
    assert.strictEqual(await isPwnedPassword(password, fetchStub), true);
});

test('fail-open si l\'API HIBP est injoignable', async () => {
    const fetchStub = async () => { throw new Error('network down'); };
    assert.strictEqual(await isPwnedPassword('whatever-Pass-99!', fetchStub), false);
});
```

- [ ] **Step 3: Vérifier l'échec**

Run: `npm test`
Expected: FAIL — `Cannot find module '../services/passwordService'`.

- [ ] **Step 4: Implémenter**

`services/passwordService.js` (complet) :

```js
/**
 * Validation avancée des mots de passe :
 * - Force : score zxcvbn >= 3 (échelle 0-4)
 * - Compromission : HaveIBeenPwned via k-anonymity
 *   (seuls les 5 premiers caractères du SHA-1 sont transmis)
 */
const crypto = require('crypto');
const zxcvbn = require('zxcvbn');

const MIN_ZXCVBN_SCORE = 3;
const HIBP_TIMEOUT_MS = 3000;

async function isPwnedPassword(password, fetchImpl = fetch) {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
        const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
            signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
            headers: { 'Add-Padding': 'true' }
        });
        if (!response.ok) return false; // fail-open
        const body = await response.text();
        return body.split(/\r?\n/).some(line => line.split(':')[0] === suffix);
    } catch (error) {
        // Fail-open : ne pas bloquer l'inscription si HIBP est injoignable
        console.warn('⚠️ HIBP injoignable, vérification ignorée:', error.message);
        return false;
    }
}

async function validateNewPassword(password, username = '') {
    const strength = zxcvbn(password, [username, 'akinator', 'twitch']);
    if (strength.score < MIN_ZXCVBN_SCORE) {
        return {
            ok: false,
            error: 'Mot de passe trop prévisible. Utilisez une phrase de passe longue et originale.'
        };
    }
    if (await isPwnedPassword(password)) {
        return {
            ok: false,
            error: 'Ce mot de passe apparaît dans des fuites de données connues. Choisissez-en un autre.'
        };
    }
    return { ok: true };
}

module.exports = { validateNewPassword, isPwnedPassword, MIN_ZXCVBN_SCORE };
```

Dans `routes/auth.js`, brancher dans **register** (après `validationResult`, avant le hash bcrypt), **change-password** et **forgot-password** (sur `newPassword`) :

```js
        const passwordCheck = await validateNewPassword(password, username);
        if (!passwordCheck.ok) {
            return res.status(400).json({ success: false, error: passwordCheck.error });
        }
```

(import en tête : `const { validateNewPassword } = require('../services/passwordService');`)

Attention : le mot de passe des utilisateurs de test (`C0rrect!Horse#Battery9`) doit passer zxcvbn — vérifier que les tests des lots 1-2 restent verts.

- [ ] **Step 5: Vérifier le succès**

Run: `npm test`
Expected: PASS (toute la suite).

- [ ] **Step 6: Commit**

```bash
git add AkinatorWeb/backend/services/passwordService.js AkinatorWeb/backend/routes/auth.js AkinatorWeb/backend/package.json AkinatorWeb/backend/tests/password-service.test.js
git commit -m "feat(auth): refus des mots de passe faibles (zxcvbn) ou compromis (HIBP k-anonymity)"
```

### Task 8: 2FA — codes de secours à usage unique

**Files:**
- Modify: `AkinatorWeb/backend/services/database.js` (table `a2f_backup_codes`)
- Create: `AkinatorWeb/backend/services/twoFactor.js` (partie codes de secours ; l'anti-rejeu arrive en Task 9)
- Modify: `AkinatorWeb/backend/routes/a2f.js` (endpoint de génération)
- Modify: `AkinatorWeb/backend/routes/auth.js` (verify-login-a2f accepte un code de secours)
- Test: `AkinatorWeb/backend/tests/backup-codes.test.js`

**Interfaces:**
- Produces:
  - `generateBackupCodes(userId)` → `string[]` (8 codes hex de 10 caractères, retournés en clair UNE seule fois ; en base : SHA-256 uniquement)
  - `consumeBackupCode(userId, code)` → `boolean` (marque `used_at`, un code ne sert qu'une fois)
  - `POST /api/a2f/backup-codes` (authentifié, 2FA active requise) → `{ success, data: { codes } }`
- Consumes: `appendAudit` (Task 5) pour `a2f.backup_codes.generated` et `auth.2fa.backup_code_used`.

- [ ] **Step 1: Écrire les tests (échec attendu)**

`tests/backup-codes.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const { generateBackupCodes, consumeBackupCode } = require('../services/twoFactor');
const { v4: uuidv4 } = require('uuid');

const userId = uuidv4();
db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
  .run(userId, 'backupuser', 'x');

test('generateBackupCodes crée 8 codes, stockés hashés', () => {
    const codes = generateBackupCodes(userId);
    assert.strictEqual(codes.length, 8);
    const rows = db.prepare('SELECT code_hash FROM a2f_backup_codes WHERE user_id = ?').all(userId);
    assert.strictEqual(rows.length, 8);
    assert.ok(!rows.some(r => codes.includes(r.code_hash)), 'jamais de code en clair en base');
});

test('un code de secours est à usage unique', () => {
    const codes = generateBackupCodes(userId);
    assert.strictEqual(consumeBackupCode(userId, codes[0]), true);
    assert.strictEqual(consumeBackupCode(userId, codes[0]), false, 'déjà consommé');
    assert.strictEqual(consumeBackupCode(userId, 'code-invalide'), false);
});

test('regénérer invalide les anciens codes', () => {
    const first = generateBackupCodes(userId);
    generateBackupCodes(userId);
    assert.strictEqual(consumeBackupCode(userId, first[1]), false);
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm test`
Expected: FAIL — `Cannot find module '../services/twoFactor'`.

- [ ] **Step 3: Implémenter**

`services/database.js` — ajouter la table :

```js
    // Codes de secours 2FA (hashés, usage unique)
    db.exec(`
        CREATE TABLE IF NOT EXISTS a2f_backup_codes (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            used_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_user ON a2f_backup_codes(user_id)`);
```

`services/twoFactor.js` (première version — complétée en Task 9) :

```js
/**
 * 2FA renforcée : codes de secours à usage unique.
 * Les codes sont des jetons aléatoires haute entropie → SHA-256 suffit
 * (pas besoin de bcrypt, aucun risque de brute-force hors ligne réaliste).
 */
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./database');

const BACKUP_CODES_COUNT = 8;

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function generateBackupCodes(userId) {
    db.prepare('DELETE FROM a2f_backup_codes WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO a2f_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)');
    const codes = [];
    for (let i = 0; i < BACKUP_CODES_COUNT; i++) {
        const code = crypto.randomBytes(5).toString('hex'); // 10 caractères
        codes.push(code);
        insert.run(uuidv4(), userId, sha256(code));
    }
    return codes;
}

function consumeBackupCode(userId, code) {
    const normalized = String(code || '').trim().toLowerCase();
    const row = db.prepare(`
        SELECT id FROM a2f_backup_codes
        WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
    `).get(userId, sha256(normalized));
    if (!row) return false;
    db.prepare(`UPDATE a2f_backup_codes SET used_at = datetime('now') WHERE id = ?`).run(row.id);
    return true;
}

module.exports = { generateBackupCodes, consumeBackupCode, BACKUP_CODES_COUNT };
```

`routes/a2f.js` — nouvel endpoint (après `/disable`) :

```js
const { generateBackupCodes } = require('../services/twoFactor');
const { appendAudit } = require('../services/auditService');

/**
 * POST /api/a2f/backup-codes
 * Regénère les codes de secours (affichés une seule fois).
 */
router.post('/backup-codes', authenticateToken, async (req, res) => {
    const user = queries.users.findById.get(req.user.id);
    if (!user || !user.a2f_enabled) {
        return res.status(400).json({ success: false, error: 'La 2FA doit être activée' });
    }
    const codes = generateBackupCodes(user.id);
    appendAudit('a2f.backup_codes.generated', { userId: user.id });
    res.json({
        success: true,
        data: { codes },
        message: 'Conservez ces codes en lieu sûr : ils ne seront plus jamais affichés.'
    });
});
```

`routes/auth.js` — dans **verify-login-a2f**, avant la vérification TOTP, accepter un code de secours (champ `code` de longueur 10) :

```js
        // Code de secours (10 caractères hex) accepté à la place du TOTP
        if (String(code).trim().length === 10) {
            const { consumeBackupCode } = require('../services/twoFactor');
            if (!consumeBackupCode(user.id, code)) {
                appendAudit('auth.2fa.failed', { userId: user.id, details: { method: 'backup_code' } });
                return res.status(401).json({ success: false, error: 'Code de secours invalide' });
            }
            appendAudit('auth.2fa.success', { userId: user.id, details: { method: 'backup_code' } });
            // → continuer vers l'émission des tokens (même code que TOTP valide)
        } else {
            // Conserver la vérification TOTP existante (bloc `speakeasy.totp.verify`
            // actuellement à auth.js:~459). En cas d'échec, garder son `return 401`.
            // En cas de succès, laisser le flux continuer vers l'émission des tokens.
        }
```

**Implémentation concrète** : envelopper le bloc TOTP existant de `verify-login-a2f` dans le `else`. Ne pas dupliquer la logique d'émission de tokens : les deux branches (code de secours consommé OU TOTP valide) convergent vers le même `issueTokenPair` / `setAuthCookies` déjà en place plus bas dans le handler. Task 9 remplacera ensuite le `speakeasy.totp.verify` de ce `else` par `verifyTotp`.

- [ ] **Step 4: Vérifier le succès**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/services/database.js AkinatorWeb/backend/services/twoFactor.js AkinatorWeb/backend/routes/a2f.js AkinatorWeb/backend/routes/auth.js AkinatorWeb/backend/tests/backup-codes.test.js
git commit -m "feat(2fa): codes de secours hashés à usage unique"
```

### Task 9: 2FA — anti-rejeu TOTP + rate-limit dédié

**Files:**
- Modify: `AkinatorWeb/backend/services/database.js` (colonne `a2f_last_step` sur `users`)
- Modify: `AkinatorWeb/backend/services/twoFactor.js` (ajout `verifyTotp` avec garde anti-rejeu)
- Modify: `AkinatorWeb/backend/middleware/security.js` (nouveau `a2fLimiter`)
- Modify: `AkinatorWeb/backend/routes/auth.js` + `AkinatorWeb/backend/routes/a2f.js` (remplacer les **6** appels directs `speakeasy.totp.verify` par `verifyTotp`, appliquer `a2fLimiter`)
- Test: `AkinatorWeb/backend/tests/totp-replay.test.js`

**Interfaces:**
- Produces: `verifyTotp(user, code)` → `{ ok: true } | { ok: false, error: string }` — `user` doit contenir `id`, `a2f_secret`, `a2f_last_step`. En cas de succès, mémorise le `step` TOTP consommé (`UPDATE users SET a2f_last_step`), et refuse tout code d'un step ≤ au dernier utilisé (anti-rejeu, fenêtre ±1 conservée).
- Produces: `a2fLimiter` (5 tentatives / 15 min / IP) exporté de `middleware/security.js`, appliqué à `POST /api/auth/verify-login-a2f`, `POST /api/a2f/verify`, `POST /api/a2f/verify-setup`.

- [ ] **Step 1: Écrire les tests (échec attendu)**

`tests/totp-replay.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const speakeasy = require('speakeasy');
const { verifyTotp } = require('../services/twoFactor');
const { v4: uuidv4 } = require('uuid');

function createA2FUser() {
    const id = uuidv4();
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    db.prepare('INSERT INTO users (id, username, password_hash, a2f_enabled, a2f_secret) VALUES (?, ?, ?, 1, ?)')
      .run(id, `totp_${id.slice(0, 8)}`, 'x', secret);
    return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(id), secret };
}

test('un code TOTP valide passe, le même code rejoué est refusé', () => {
    const { user, secret } = createA2FUser();
    const code = speakeasy.totp({ secret, encoding: 'base32' });

    assert.strictEqual(verifyTotp(user, code).ok, true);

    const replayed = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const second = verifyTotp(replayed, code);
    assert.strictEqual(second.ok, false, 'anti-rejeu : code déjà consommé');
});

test('un code invalide est refusé', () => {
    const { user } = createA2FUser();
    assert.strictEqual(verifyTotp(user, '000000').ok, false);
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm test`
Expected: FAIL — `verifyTotp is not a function`.

- [ ] **Step 3: Implémenter**

`services/database.js` — migration colonne (dans le bloc des `ALTER TABLE` existants, ligne ~72) :

```js
    try {
        db.exec('ALTER TABLE users ADD COLUMN a2f_last_step INTEGER');
    } catch (e) { /* Colonne existe déjà */ }
```

`services/twoFactor.js` — ajouter :

```js
const speakeasy = require('speakeasy');

const TOTP_WINDOW = 1; // ±30 s de tolérance

function currentStep() {
    return Math.floor(Date.now() / 1000 / 30);
}

/**
 * Vérifie un code TOTP avec garde anti-rejeu :
 * le step consommé est mémorisé, tout code d'un step <= dernier utilisé est refusé.
 */
function verifyTotp(user, code) {
    const delta = speakeasy.totp.verifyDelta({
        secret: user.a2f_secret,
        encoding: 'base32',
        token: String(code || '').trim(),
        window: TOTP_WINDOW
    });
    if (!delta) return { ok: false, error: 'Code A2F incorrect' };

    const step = currentStep() + delta.delta;
    if (user.a2f_last_step !== null && user.a2f_last_step !== undefined
        && step <= user.a2f_last_step) {
        return { ok: false, error: 'Code A2F déjà utilisé, attendez le prochain code' };
    }
    db.prepare('UPDATE users SET a2f_last_step = ? WHERE id = ?').run(step, user.id);
    return { ok: true };
}

// ... ajouter verifyTotp aux exports
```

`middleware/security.js` — nouveau limiteur (exporté) :

```js
/**
 * Rate Limiter dédié à la vérification 2FA (anti brute-force sur 6 chiffres)
 */
const a2fLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.isTest ? 10000 : 5,
    message: {
        success: false,
        error: 'Trop de tentatives de vérification 2FA, réessayez dans 15 minutes'
    }
});
```

Remplacements : dans `routes/auth.js` (verify-login-a2f ligne ~459, change-password ligne ~640, forgot-password ligne ~728) et `routes/a2f.js` (verify-setup ligne ~92, verify ligne ~141, disable ligne ~182), remplacer chaque bloc :

```js
        const isValid = speakeasy.totp.verify({ secret: user.a2f_secret, encoding: 'base32', token: code, window: 1 });
        if (!isValid) { return res.status(401).json({ success: false, error: 'Code A2F incorrect' }); }
```

par :

```js
        const totpResult = verifyTotp(user, code);
        if (!totpResult.ok) {
            return res.status(401).json({ success: false, error: totpResult.error });
        }
```

et ajouter `a2fLimiter` sur les trois routes de vérification :

```js
router.post('/verify-login-a2f', a2fLimiter, /* ...middlewares existants */);
router.post('/verify', a2fLimiter, authenticateToken, ...);
router.post('/verify-setup', a2fLimiter, authenticateToken, ...);
```

- [ ] **Step 4: Vérifier le succès**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/services/ AkinatorWeb/backend/middleware/security.js AkinatorWeb/backend/routes/ AkinatorWeb/backend/tests/totp-replay.test.js
git commit -m "feat(2fa): anti-rejeu TOTP (step mémorisé) et rate-limit dédié"
```

### Task 10: Anti-énumération de comptes sur /register

**Files:**
- Modify: `AkinatorWeb/backend/routes/auth.js:97-108` (register)
- Test: `AkinatorWeb/backend/tests/anti-enumeration.test.js`

**Interfaces:**
- Produces: `/register` avec un identifiant déjà pris renvoie **400** avec le message générique `'Inscription impossible. Vérifiez vos informations et réessayez.'` (plus jamais 409 « déjà utilisé »). Le hash bcrypt est calculé **avant** le test d'existence → temps de réponse identique que le compte existe ou non.

- [ ] **Step 1: Écrire le test (échec attendu)**

`tests/anti-enumeration.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

const USER = { username: 'enumuser', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

test('register sur un identifiant pris ne révèle pas l\'existence du compte', async () => {
    await request(app).post('/api/auth/register').send(USER);
    const res = await request(app).post('/api/auth/register').send(USER);
    assert.strictEqual(res.status, 400, 'plus de 409 révélateur');
    assert.ok(!/déjà utilisé/i.test(res.body.error), 'message générique');
    assert.strictEqual(res.body.error, 'Inscription impossible. Vérifiez vos informations et réessayez.');
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm test`
Expected: FAIL — statut 409 et message « Cet identifiant est déjà utilisé ».

- [ ] **Step 3: Implémenter**

Dans `routes/auth.js` (register), réordonner : hash d'abord (coût constant), test d'existence ensuite, message générique :

```js
        // Hash calculé AVANT le test d'existence : temps de réponse constant
        // que l'identifiant soit pris ou non (anti-énumération par timing)
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const existingUser = queries.users.findByUsername.get(username);
        if (existingUser) {
            // Message volontairement générique : ne pas confirmer l'existence du compte
            return res.status(400).json({
                success: false,
                error: 'Inscription impossible. Vérifiez vos informations et réessayez.'
            });
        }
```

(supprimer l'ancien `const passwordHash = await bcrypt.hash(...)` plus bas ; le login garde son `bcrypt.hash('dummy', ...)` existant, déjà timing-safe).

- [ ] **Step 4: Vérifier le succès**

Run: `npm test`
Expected: PASS. Vérifier aussi que le frontend affiche correctement ce message (aucun traitement spécial du 409 : `grep -n "409" AkinatorWeb/frontend/js/*.js`).

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/routes/auth.js AkinatorWeb/backend/tests/anti-enumeration.test.js
git commit -m "feat(auth): anti-énumération de comptes sur /register (message générique + timing constant)"
```

---

# Lot 4 — DevSecOps : CI sécurité + gestion des secrets (spec #6, #7)

> Rappel du contexte : un token GitHub a déjà fuité dans ce projet. Ce lot transforme l'incident en démonstration de maturité.

### Task 11: Secret scanning — gitleaks en pre-commit + lockfile

**Files:**
- Create: `.gitleaks.toml` (racine du dépôt)
- Create: `.githooks/pre-commit`
- Create: `AkinatorWeb/backend/package-lock.json` (généré — prérequis à `npm ci` en CI)
- Modify: `README.md` (section « Développement : hooks git »)

**Interfaces:**
- Produces: hook local bloquant si `gitleaks` est installé (fail-open sinon : la CI de Task 12 reste le filet), lockfile committé pour `npm ci`.

- [ ] **Step 1: Générer le lockfile**

```bash
cd /home/valentin/AkinatorTwitch/AkinatorWeb/backend && npm install --package-lock-only
```

Expected: `package-lock.json` créé. Vérifier que `backend/.gitignore` ou le `.gitignore` racine ne l'exclut pas.

- [ ] **Step 2: Créer la configuration gitleaks**

`.gitleaks.toml` (racine) :

```toml
# Secret scanning — configuration gitleaks
# Règles par défaut + exclusions locales
[extend]
useDefault = true

[allowlist]
description = "Fichiers de test et exemples"
paths = [
    '''AkinatorWeb/backend/tests/''',
    '''AkinatorWeb/backend/env\.example\.txt''',
]
```

- [ ] **Step 3: Créer le hook pre-commit**

`.githooks/pre-commit` :

```sh
#!/bin/sh
# Secret scanning avant chaque commit (gitleaks)
if command -v gitleaks >/dev/null 2>&1; then
    if ! gitleaks protect --staged --redact --config .gitleaks.toml; then
        echo "❌ gitleaks : secret potentiel détecté, commit bloqué."
        echo "   Si faux positif : ajouter une exception dans .gitleaks.toml"
        exit 1
    fi
else
    echo "⚠️ gitleaks non installé — scan local ignoré (la CI scanne quand même)."
    echo "   Installation : https://github.com/gitleaks/gitleaks#installing"
fi
```

Puis :

```bash
chmod +x /home/valentin/AkinatorTwitch/.githooks/pre-commit
cd /home/valentin/AkinatorTwitch && git config core.hooksPath .githooks
```

- [ ] **Step 4: Vérifier**

Run (si gitleaks installé, sinon vérifier le message d'avertissement) :

```bash
cd /home/valentin/AkinatorTwitch && echo 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' > /tmp/fake-secret.txt && git add -N . 2>/dev/null; sh .githooks/pre-commit; echo "exit=$?"; rm /tmp/fake-secret.txt
```

Expected: soit un scan qui s'exécute (exit 0 car le faux secret est hors dépôt), soit le message `⚠️ gitleaks non installé`.

Documenter dans `README.md` :

```markdown
## Développement — hooks git
Après clonage : `git config core.hooksPath .githooks` puis installer
[gitleaks](https://github.com/gitleaks/gitleaks#installing) pour le
scan de secrets en pre-commit (la CI le rejoue systématiquement).
```

- [ ] **Step 5: Commit**

```bash
git add .gitleaks.toml .githooks/pre-commit AkinatorWeb/backend/package-lock.json README.md
git commit -m "ci: secret scanning gitleaks (pre-commit) + lockfile npm"
```

### Task 12: Pipeline GitHub Actions (gitleaks + npm audit + tests + CodeQL + Dependabot)

**Files:**
- Create: `.github/workflows/security.yml`
- Create: `.github/workflows/codeql.yml`
- Create: `.github/dependabot.yml`

**Interfaces:**
- Consumes: `npm test` (Task 1), `package-lock.json` (Task 11).
- Produces: 3 jobs sur chaque push/PR vers `main` : `secret-scan`, `dependances`, `tests` ; analyse CodeQL hebdomadaire + sur PR ; PRs Dependabot hebdomadaires.

- [ ] **Step 1: Créer `.github/workflows/security.yml`**

```yaml
name: Sécurité

on:
  push:
    branches: [main]
  pull_request:

jobs:
  secret-scan:
    name: Secret scanning (gitleaks)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # historique complet : détecte aussi les secrets déjà commités
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  dependances:
    name: Audit des dépendances
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: AkinatorWeb/backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: AkinatorWeb/.node-version
          cache: npm
          cache-dependency-path: AkinatorWeb/backend/package-lock.json
      - run: npm ci
      - run: npm audit --audit-level=high

  tests:
    name: Tests backend
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: AkinatorWeb/backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: AkinatorWeb/.node-version
          cache: npm
          cache-dependency-path: AkinatorWeb/backend/package-lock.json
      - run: npm ci
      - run: npm test
        env:
          JWT_SECRET: ci-secret-0123456789abcdef0123456789abcdef
```

- [ ] **Step 2: Créer `.github/workflows/codeql.yml`**

```yaml
name: SAST (CodeQL)

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '30 5 * * 1'   # lundi 5h30 UTC

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript
      - uses: github/codeql-action/analyze@v3
```

- [ ] **Step 3: Créer `.github/dependabot.yml`**

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /AkinatorWeb/backend
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

- [ ] **Step 4: Valider la syntaxe YAML**

Run:

```bash
node -e "const fs=require('fs');['.github/workflows/security.yml','.github/workflows/codeql.yml','.github/dependabot.yml'].forEach(f=>{require('/home/valentin/AkinatorTwitch/AkinatorWeb/backend/node_modules/js-yaml/index.js');});" 2>/dev/null \
  || python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/workflows/security.yml','.github/workflows/codeql.yml','.github/dependabot.yml']]; print('YAML OK')"
```

Expected: `YAML OK` (les workflows ne s'exécuteront réellement qu'après push sur GitHub — vérifier l'onglet Actions au premier push).

- [ ] **Step 5: Commit**

```bash
git add .github/
git commit -m "ci: pipeline sécurité (gitleaks, npm audit, tests, CodeQL, Dependabot)"
```

### Task 13: DAST — OWASP ZAP baseline sur l'app déployée

**Files:**
- Create: `.github/workflows/zap.yml`

**Interfaces:**
- Produces: workflow manuel (`workflow_dispatch`) avec l'URL cible en entrée — l'app Render n'a pas d'URL stable connue du dépôt.

- [ ] **Step 1: Créer `.github/workflows/zap.yml`**

```yaml
name: DAST (OWASP ZAP baseline)

on:
  workflow_dispatch:
    inputs:
      target_url:
        description: "URL de l'application déployée (ex: https://akinator-xxx.onrender.com)"
        required: true
        type: string

jobs:
  zap-baseline:
    runs-on: ubuntu-latest
    steps:
      - uses: zaproxy/action-baseline@v0.14.0
        with:
          target: ${{ inputs.target_url }}
          allow_issue_writing: false
          cmd_options: '-a'   # inclut les règles alpha (scan passif étendu)
```

- [ ] **Step 2: Valider la syntaxe**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/zap.yml')); print('YAML OK')"`
Expected: `YAML OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/zap.yml
git commit -m "ci: scan DAST OWASP ZAP baseline (déclenchement manuel)"
```

### Task 14: Gestion des secrets — ENCRYPTION_KEY séparée + rotation + admin sans mot de passe en dur

**Files:**
- Modify: `AkinatorWeb/backend/services/encryption.js:17-30`
- Modify: `AkinatorWeb/backend/server.js:196-225` (`ensureAdminAccount`)
- Modify: `AkinatorWeb/backend/env.example.txt`
- Create: `AkinatorWeb/backend/scripts/generate-keys.js`
- Create: `AkinatorWeb/backend/scripts/rotate-encryption-key.js`
- Create: `SECURITY.md` (racine)
- Test: `AkinatorWeb/backend/tests/encryption-key.test.js`

**Interfaces:**
- Produces: `ENCRYPTION_KEY` = **64 caractères hex** (32 octets), indépendante de `JWT_SECRET`. En production, absence ou format invalide → arrêt au démarrage. En dev/test, fallback dérivé conservé avec avertissement explicite.
- Produces: `node scripts/generate-keys.js` → affiche `JWT_SECRET` et `ENCRYPTION_KEY` frais ; `OLD_ENCRYPTION_KEY=<hex> ENCRYPTION_KEY=<hex> node scripts/rotate-encryption-key.js` → re-chiffre `users.ip_address` et `sessions.ip_address`.

- [ ] **Step 1: Écrire le test (échec attendu)**

`tests/encryption-key.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
require('./helpers/setup');
const { encryptIP, decryptIP } = require('../services/encryption');

test('chiffrement/déchiffrement avec une ENCRYPTION_KEY hex de 64 caractères', () => {
    const encrypted = encryptIP('192.168.1.42');
    assert.ok(encrypted, 'le chiffrement doit réussir avec une clé hex');
    assert.strictEqual(decryptIP(encrypted), '192.168.1.42');
});
```

Run: `npm test` → FAIL : le code actuel utilise `process.env.ENCRYPTION_KEY` comme **chaîne brute** (64 caractères = mauvaise longueur pour AES-256 qui attend 32 octets) → `encryptIP` renvoie `null`.

- [ ] **Step 2: Corriger `services/encryption.js`**

Remplacer les lignes 17-30 par :

```js
// Clé de chiffrement AES-256 (32 octets), attendue en hex (64 caractères)
const ENCRYPTION_KEY = loadEncryptionKey();
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Charge ENCRYPTION_KEY depuis l'environnement.
 * - Production : obligatoire, 64 caractères hex, indépendante de JWT_SECRET → sinon arrêt.
 * - Dev/test : fallback dérivé de JWT_SECRET (avec avertissement), pour ne pas bloquer.
 */
function loadEncryptionKey() {
    const raw = process.env.ENCRYPTION_KEY;
    const isProd = process.env.NODE_ENV === 'production';

    if (raw) {
        if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
            console.error('❌ ENCRYPTION_KEY invalide : 64 caractères hexadécimaux attendus (32 octets).');
            console.error('   Générer une clé : node scripts/generate-keys.js');
            process.exit(1);
        }
        return Buffer.from(raw, 'hex');
    }

    if (isProd) {
        console.error('❌ ENCRYPTION_KEY manquante en production.');
        console.error('   Une clé dérivée de JWT_SECRET ferait qu\'une seule fuite compromet tout.');
        console.error('   Générer une clé : node scripts/generate-keys.js');
        process.exit(1);
    }

    console.warn('⚠️ ENCRYPTION_KEY absente : clé dérivée de JWT_SECRET (dev uniquement).');
    return crypto.createHash('sha256').update(config.jwt.secret + 'encryption_salt').digest();
}
```

(supprimer l'ancienne `deriveKeyFromJWTSecret`).

Run: `npm test` → PASS.

- [ ] **Step 3: Scripts de génération et de rotation**

`scripts/generate-keys.js` :

```js
/**
 * Génère des secrets frais pour .env / variables Render.
 * Usage : node scripts/generate-keys.js
 */
const crypto = require('crypto');

console.log('# À copier dans .env (ou variables d\'environnement Render) :');
console.log(`JWT_SECRET=${crypto.randomBytes(48).toString('hex')}`);
console.log(`ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
console.log(`IP_HASH_SALT=${crypto.randomBytes(16).toString('hex')}`);
```

`scripts/rotate-encryption-key.js` :

```js
/**
 * Rotation de la clé de chiffrement des IP (RGPD).
 * Re-chiffre users.ip_address et sessions.ip_address avec la nouvelle clé.
 *
 * Usage :
 *   OLD_ENCRYPTION_KEY=<ancienne hex64> ENCRYPTION_KEY=<nouvelle hex64> node scripts/rotate-encryption-key.js
 */
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const oldHex = process.env.OLD_ENCRYPTION_KEY;
const newHex = process.env.ENCRYPTION_KEY;
if (!/^[0-9a-fA-F]{64}$/.test(oldHex || '') || !/^[0-9a-fA-F]{64}$/.test(newHex || '')) {
    console.error('❌ OLD_ENCRYPTION_KEY et ENCRYPTION_KEY (64 hex) sont requises.');
    process.exit(1);
}
const oldKey = Buffer.from(oldHex, 'hex');
const newKey = Buffer.from(newHex, 'hex');

const Database = require('better-sqlite3');
const db = new Database(process.env.DATABASE_PATH || path.join(__dirname, '../data/akinator.db'));

function decrypt(payload, key) {
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(decoded.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(decoded.tag, 'base64'));
    return decipher.update(decoded.encrypted, 'base64', 'utf8') + decipher.final('utf8');
}

function encrypt(text, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = cipher.update(text, 'utf8', 'base64') + cipher.final('base64');
    return Buffer.from(JSON.stringify({
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        encrypted
    })).toString('base64');
}

let rotated = 0, skipped = 0;
for (const { table, column } of [
    { table: 'users', column: 'ip_address' },
    { table: 'sessions', column: 'ip_address' }
]) {
    const rows = db.prepare(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all();
    for (const row of rows) {
        try {
            const clear = decrypt(row.value, oldKey);
            db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(encrypt(clear, newKey), row.id);
            rotated++;
        } catch (e) {
            skipped++; // donnée illisible avec l'ancienne clé (ancien format) : laissée telle quelle
        }
    }
}
console.log(`✅ Rotation terminée : ${rotated} valeur(s) re-chiffrée(s), ${skipped} ignorée(s).`);
```

- [ ] **Step 4: Supprimer le mot de passe admin en dur**

Dans `server.js`, `ensureAdminAccount()` — remplacer les lignes 201-202 :

```js
    const adminUsername = process.env.ADMIN_USERNAME || 'Akinator';
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
        console.warn('⚠️ ADMIN_PASSWORD non défini : création du compte admin ignorée.');
        console.warn('   Définissez ADMIN_USERNAME / ADMIN_PASSWORD dans l\'environnement.');
        return;
    }
```

- [ ] **Step 5: Documentation**

Compléter `env.example.txt` avec `ENCRYPTION_KEY=`, `IP_HASH_SALT=`, `ADMIN_USERNAME=`, `ADMIN_PASSWORD=` (valeurs vides + commentaire `# node scripts/generate-keys.js`).

Créer `SECURITY.md` (racine) :

```markdown
# Politique de sécurité

## Signalement de vulnérabilité
Contact : sirejambon@gmail.com — réponse sous 72 h. Merci de ne pas
divulguer publiquement avant correction.

## Secrets et rotation
- `JWT_SECRET` (sessions), `ENCRYPTION_KEY` (chiffrement AES-256-GCM des IP)
  et `IP_HASH_SALT` (logs) sont trois secrets **indépendants** :
  la compromission de l'un n'affecte pas les autres.
- Génération : `node AkinatorWeb/backend/scripts/generate-keys.js`
- Rotation de la clé de chiffrement (re-chiffre les données) :
  `OLD_ENCRYPTION_KEY=... ENCRYPTION_KEY=... node AkinatorWeb/backend/scripts/rotate-encryption-key.js`
- Rotation de `JWT_SECRET` : invalide toutes les sessions (les refresh
  tokens persistés forcent une reconnexion propre).
- Aucun secret dans le dépôt : gitleaks bloque en pre-commit et en CI.

## Incident connu (leçon apprise)
Un token GitHub a fuité dans l'historique du projet. Mesures prises :
révocation du token, secret scanning gitleaks (pre-commit + CI),
séparation des secrets applicatifs.
```

- [ ] **Step 6: Vérifier et committer**

Run: `npm test` (PASS) puis `node scripts/generate-keys.js` (affiche 3 clés).

```bash
git add AkinatorWeb/backend/services/encryption.js AkinatorWeb/backend/server.js AkinatorWeb/backend/scripts/generate-keys.js AkinatorWeb/backend/scripts/rotate-encryption-key.js AkinatorWeb/backend/env.example.txt AkinatorWeb/backend/tests/encryption-key.test.js SECURITY.md
git commit -m "feat(secrets): ENCRYPTION_KEY dédiée + rotation documentée, admin sans mot de passe en dur"
```

⚠️ **Post-déploiement** : définir `ENCRYPTION_KEY` sur Render **avant** de déployer ce commit (sinon arrêt au démarrage, c'est voulu). Les IP déjà chiffrées avec la clé dérivée ne seront plus lisibles → lancer `rotate-encryption-key.js` avec `OLD_ENCRYPTION_KEY` = SHA-256 hex de `JWT_SECRET + 'encryption_salt'`.

---

# Lot 5 — Robustesse applicative (spec #8, #9, #10)

### Task 15: Upload d'avatar — anti compression-bomb

> L'existant est déjà solide (validation par décodage sharp, re-encodage WebP 256×256 qui supprime l'EXIF, nom aléatoire, 5 Mo max). Reste le risque « compression bomb » : un fichier de quelques Ko qui se décompresse en centaines de mégapixels.

**Files:**
- Modify: `AkinatorWeb/backend/routes/avatar.js` (limite de pixels à l'ouverture sharp)
- Test: `AkinatorWeb/backend/tests/avatar-upload.test.js`

**Interfaces:**
- Produces: toute image dont `width * height > 4096 * 4096` (≈ 16,7 MP) est refusée en 400 avant tout traitement.

- [ ] **Step 1: Écrire les tests (échec attendu)**

`tests/avatar-upload.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const sharp = require('sharp');
const { app } = require('./helpers/setup');

const USER = { username: 'avataruser', password: 'C0rrect!Horse#Battery9', rgpdConsent: true };

/**
 * /api/avatar est monté derrière `csrfProtection` (server.js:100) : il faut le
 * cookie de session ET un token CSRF valide, sinon 403. On renvoie les deux.
 */
async function authContext() {
    const reg = await request(app).post('/api/auth/register').send(USER);
    const res = reg.status === 201 ? reg : await request(app).post('/api/auth/login')
        .send({ username: USER.username, password: USER.password });
    const cookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

test('un faux fichier image (contenu non décodable) est refusé', async () => {
    const { cookie, csrfToken } = await authContext();
    const res = await request(app).post('/api/avatar/upload')
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken)
        .attach('avatar', Buffer.from('<?php system($_GET["c"]); ?>'), 'evil.jpg');
    assert.strictEqual(res.status, 400);
});

test('une image aux dimensions démesurées est refusée (anti compression-bomb)', async () => {
    const { cookie, csrfToken } = await authContext();
    const bomb = await sharp({
        create: { width: 8000, height: 4000, channels: 3, background: { r: 0, g: 0, b: 0 } }
    }).jpeg({ quality: 10 }).toBuffer();
    const res = await request(app).post('/api/avatar/upload')
        .set('Cookie', cookie).set('X-CSRF-Token', csrfToken)
        .attach('avatar', bomb, 'bomb.jpg');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /trop grande|dimensions/i);
});
```

Note : `/api/avatar` est **certainement** derrière `csrfProtection` (server.js:100) — le token CSRF est donc **obligatoire** (pas conditionnel) dans les deux tests, d'où le helper `authContext`.

- [ ] **Step 2: Vérifier l'état de départ (RED partiel)**

Run: `npm test`

État réel du code (à ne pas ignorer) : `validateImageBuffer` (`routes/avatar.js:64`) rejette **déjà** `metadata.width > 4096 || metadata.height > 4096` avec le message `'Image trop grande (max 4096x4096)'`. L'image de test 8000×4000 est donc déjà refusée par ce contrôle d'en-tête. Le RED attendu ici vient de **l'absence de token CSRF** dans un test naïf (403 ≠ 400) — d'où le helper `authContext` obligatoire.

Conséquence honnête : la protection **par dimensions** préexiste ; les deux tests sont surtout des **garde-fous de non-régression**. La plus-value de code de cette tâche est `limitInputPixels`, qui durcit le **décodage/re-encodage** sharp contre les bombes de décompression (allocation mémoire au rastérisage), là où `metadata()` ne lit que l'en-tête. Aucune image acceptée par l'ancien contrôle (deux côtés ≤ 4096, donc ≤ 16,7 MP) ne peut dépasser `MAX_PIXELS` : il n'y a pas de red→green « pur » pour le seuil de pixels — c'est un durcissement défense-en-profondeur assumé, verrouillé par les tests de non-régression.

- [ ] **Step 3: Implémenter**

Dans `routes/avatar.js`, définir la limite et l'appliquer à **toutes** les ouvertures sharp (validation ET re-encodage) — le contrôle de dimensions existant est conservé :

```js
// Limite anti « compression bomb » : 16,7 MP max (4096×4096)
const MAX_PIXELS = 4096 * 4096;
```

Dans `validateImageBuffer`, ouvrir le buffer avec la borne de pixels (sharp lève alors une erreur au décodage d'une bombe, interceptée par le `catch` existant → 400 `'Fichier corrompu ou non-image'`) ; le contrôle par en-tête ligne 64 reste le premier rempart pour les images bien formées :

```js
        const metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
        // ... contrôles de format et de dimensions existants inchangés (dont le rejet > 4096×4096) ...
```

et passer la **même** option à l'appel de re-encodage WebP (`sharp(req.file.buffer, ...)`, plus bas dans le handler `/upload`) : `sharp(req.file.buffer, { limitInputPixels: MAX_PIXELS })`.

Ne PAS remplacer le message `'Image trop grande (max 4096x4096)'` existant : le test l'accepte (`/trop grande|dimensions/i`).

- [ ] **Step 4: Vérifier le succès**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/routes/avatar.js AkinatorWeb/backend/tests/avatar-upload.test.js
git commit -m "feat(avatar): limite de pixels anti compression-bomb"
```

### Task 16: Stores persistants — CSRF en SQLite, rate-limit Redis optionnel

**Files:**
- Modify: `AkinatorWeb/backend/services/database.js` (table `csrf_tokens`)
- Modify: `AkinatorWeb/backend/middleware/csrf.js` (réécriture : SQLite au lieu de `global.Map`)
- Modify: `AkinatorWeb/backend/middleware/security.js` (store Redis optionnel pour les limiteurs)
- Modify: `AkinatorWeb/backend/services/cleanup.js` (purge des tokens CSRF expirés)
- Test: `AkinatorWeb/backend/tests/csrf-persistent.test.js`

**Interfaces:**
- Produces: mêmes signatures qu'avant (`generateCSRFToken(userId)`, `verifyCSRFToken(userId, token)`, `csrfProtection`, `getCSRFToken`) — le stockage passe en SQLite (`csrf_tokens(user_id, token_hash, expires_at)`, token hashé SHA-256). Survit au redémarrage.
- Produces: si `REDIS_URL` est défini, les rate-limiters utilisent `rate-limit-redis` (multi-instance) ; sinon comportement mémoire inchangé. Les refresh tokens (Lot 1) et la blacklist sont déjà en SQLite.

- [ ] **Step 1: Écrire les tests (échec attendu)**

`tests/csrf-persistent.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { db } = require('./helpers/setup');
const { generateCSRFToken, verifyCSRFToken } = require('../middleware/csrf');

test('le token CSRF est persisté en base (hashé) et vérifiable', () => {
    const token = generateCSRFToken('user-1');
    assert.strictEqual(verifyCSRFToken('user-1', token), true);
    const row = db.prepare('SELECT * FROM csrf_tokens WHERE user_id = ?').get('user-1');
    assert.ok(row, 'présent en base → survit à un redémarrage');
    assert.notStrictEqual(row.token_hash, token, 'stocké hashé');
});

test('un token expiré est refusé', () => {
    const token = generateCSRFToken('user-2');
    db.prepare(`UPDATE csrf_tokens SET expires_at = datetime('now', '-1 hour') WHERE user_id = 'user-2'`).run();
    assert.strictEqual(verifyCSRFToken('user-2', token), false);
});

test('un token d\'un autre utilisateur est refusé', () => {
    const token = generateCSRFToken('user-3');
    assert.strictEqual(verifyCSRFToken('user-4', token), false);
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm test`
Expected: FAIL — `no such table: csrf_tokens`.

- [ ] **Step 3: Implémenter**

`services/database.js` :

```js
    // Tokens CSRF persistants (survivent au redémarrage)
    db.exec(`
        CREATE TABLE IF NOT EXISTS csrf_tokens (
            user_id TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            PRIMARY KEY (user_id, token_hash)
        )
    `);
```

`middleware/csrf.js` — remplacer la gestion `global.csrfTokens` (le middleware `csrfProtection` et `getCSRFToken` ne changent pas) :

```js
const crypto = require('crypto');
const { db } = require('../services/database');

// Durée de vie d'un token CSRF (1 heure)
const CSRF_TOKEN_EXPIRY_MINUTES = 60;

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/** Génère un token CSRF persisté en base (hashé) */
function generateCSRFToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare(`
        INSERT INTO csrf_tokens (user_id, token_hash, expires_at)
        VALUES (?, ?, datetime('now', '+' || ? || ' minutes'))
    `).run(userId, sha256(token), CSRF_TOKEN_EXPIRY_MINUTES);
    cleanupExpiredTokens();
    return token;
}

/** Vérifie un token CSRF */
function verifyCSRFToken(userId, token) {
    if (!token || !userId) return false;
    const row = db.prepare(`
        SELECT 1 FROM csrf_tokens
        WHERE user_id = ? AND token_hash = ? AND expires_at > datetime('now')
    `).get(userId, sha256(token));
    return !!row;
}

/** Purge les tokens expirés */
function cleanupExpiredTokens() {
    db.prepare(`DELETE FROM csrf_tokens WHERE expires_at <= datetime('now')`).run();
}
```

`services/cleanup.js` — ajouter `cleanupExpiredTokens()` (import depuis `../middleware/csrf`) dans `runFullCleanup()`.

`middleware/security.js` — store Redis optionnel, factorisé pour les 5 limiteurs :

```js
/**
 * Store optionnel Redis pour le rate-limiting multi-instance.
 * Sans REDIS_URL : store mémoire par défaut (mono-instance).
 */
function buildLimiterStore(prefix) {
    if (!process.env.REDIS_URL) return undefined;
    const { RedisStore } = require('rate-limit-redis');
    const Redis = require('ioredis');
    if (!global.__redisClient) {
        global.__redisClient = new Redis(process.env.REDIS_URL);
        console.log('✅ Rate-limiting adossé à Redis');
    }
    return new RedisStore({
        prefix: `rl:${prefix}:`,
        sendCommand: (...args) => global.__redisClient.call(...args)
    });
}
```

et dans chaque limiteur, ajouter `store: buildLimiterStore('global')` (resp. `'auth'`, `'register'`, `'payment'`, `'a2f'`).

Dépendances (uniquement maintenant) :

```bash
cd /home/valentin/AkinatorTwitch/AkinatorWeb/backend && npm install rate-limit-redis ioredis
```

- [ ] **Step 4: Vérifier le succès**

Run: `npm test`
Expected: PASS (sans `REDIS_URL`, aucun changement de comportement des limiteurs).

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/services/ AkinatorWeb/backend/middleware/ AkinatorWeb/backend/package.json AkinatorWeb/backend/package-lock.json AkinatorWeb/backend/tests/csrf-persistent.test.js
git commit -m "feat(stores): tokens CSRF persistés en SQLite, rate-limit Redis optionnel"
```

### Task 17: En-têtes Permissions-Policy, CSP report-to et security.txt

**Files:**
- Modify: `AkinatorWeb/backend/middleware/security.js` (CSP report + middleware Permissions-Policy)
- Modify: `AkinatorWeb/backend/server.js` (routes `/.well-known/security.txt` et `/api/csp-report`)
- Test: `AkinatorWeb/backend/tests/headers.test.js`

**Interfaces:**
- Produces: en-têtes `Permissions-Policy` et `Reporting-Endpoints` sur toutes les réponses ; directives CSP `report-uri`/`report-to` ; `GET /.well-known/security.txt` (RFC 9116) ; `POST /api/csp-report` qui journalise les violations CSP (`appendAudit('csp.violation', ...)`).

- [ ] **Step 1: Écrire les tests (échec attendu)**

`tests/headers.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

test('Permissions-Policy et CSP report sont présents', async () => {
    const res = await request(app).get('/api/health');
    assert.match(res.headers['permissions-policy'] || '', /camera=\(\)/);
    assert.match(res.headers['content-security-policy'] || '', /report-uri \/api\/csp-report/);
    assert.match(res.headers['reporting-endpoints'] || '', /csp-endpoint/);
});

test('GET /.well-known/security.txt répond en texte brut (RFC 9116)', async () => {
    const res = await request(app).get('/.well-known/security.txt');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
    assert.match(res.text, /Contact: mailto:/);
    assert.match(res.text, /Expires: /);
});

test('POST /api/csp-report accepte un rapport de violation', async () => {
    const res = await request(app).post('/api/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }));
    assert.strictEqual(res.status, 204);
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm test`
Expected: FAIL — en-têtes absents, routes 404/400.

- [ ] **Step 3: Implémenter**

`middleware/security.js` — dans `helmetConfig`, ajouter aux directives CSP :

```js
            'report-uri': ['/api/csp-report'],
            'report-to': ['csp-endpoint']
```

et exporter un nouveau middleware :

```js
/**
 * En-têtes non couverts par Helmet : Permissions-Policy + Reporting-Endpoints
 */
const extraHeaders = (req, res, next) => {
    res.setHeader('Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Reporting-Endpoints', 'csp-endpoint="/api/csp-report"');
    next();
};
```

`server.js` — monter `extraHeaders` juste après `helmetConfig`, puis avant le fallback SPA :

```js
// Réception des rapports de violation CSP
app.post('/api/csp-report',
    express.json({ type: ['application/json', 'application/csp-report', 'application/reports+json'] }),
    (req, res) => {
        const { appendAudit } = require('./services/auditService');
        appendAudit('csp.violation', { details: req.body || {} });
        console.warn('⚠️ SECURITY: violation CSP signalée', JSON.stringify(req.body).slice(0, 300));
        res.status(204).end();
    });

// security.txt (RFC 9116) — point de contact sécurité
app.get('/.well-known/security.txt', (req, res) => {
    res.type('text/plain').send([
        'Contact: mailto:sirejambon@gmail.com',
        'Expires: 2027-07-06T00:00:00.000Z',
        'Preferred-Languages: fr, en',
        'Canonical: https://akinator-twitch.onrender.com/.well-known/security.txt'
    ].join('\n') + '\n');
});
```

Note : `/api/csp-report` doit être **exclu** du `csrfProtection` (le navigateur l'appelle sans token) — c'est le cas s'il est monté directement sur `app` avant les routeurs protégés. Vérifier aussi que `sanitizeInput`/`securityLogger` ne bloquent pas les rapports (le mot `script-src` déclenche le motif `<script` ? Non — le motif exige `<script`, `script-src` passe).

- [ ] **Step 4: Vérifier le succès**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/middleware/security.js AkinatorWeb/backend/server.js AkinatorWeb/backend/tests/headers.test.js
git commit -m "feat(headers): Permissions-Policy, CSP report-to et security.txt (RFC 9116)"
```

---

## Récapitulatif spec → tâches

| Spec | Amélioration | Tâches |
|---|---|---|
| — | Fondations de test (prérequis TDD) | 1 |
| #1 | Access court + refresh rotatif, cookies httpOnly, blacklist persistée | 2, 3, 4 |
| #2 | Journal d'audit inviolable (hash chaîné) | 5, 6 |
| #3 | Mots de passe compromis (HIBP + zxcvbn) | 7 |
| #4 | 2FA renforcée (codes de secours, anti-rejeu, rate-limit dédié) | 8, 9 |
| #5 | Anti-énumération de comptes | 10 |
| #6 | Pipeline CI sécurité (secrets, SAST, dépendances, DAST) | 11, 12, 13 |
| #7 | Séparation / rotation des secrets | 14 |
| #8 | Upload avatar durci | 15 |
| #9 | Stores persistants | 16 |
| #10 | En-têtes + security.txt | 17 |

## Ordre d'exécution et dépendances

- **Lot 0 (Task 1) d'abord, obligatoirement** — tous les tests en dépendent.
- Lot 1 avant les Lots 2-3-5 est **recommandé** (les tests des lots suivants utilisent les cookies d'auth). Si un lot est exécuté avant le Lot 1, remplacer dans ses tests l'en-tête `Cookie` par `Authorization: Bearer <token du body>`.
- Le Lot 4 est indépendant (sauf le job `tests` de la CI qui a besoin de la Task 1).
- À l'intérieur d'un lot, exécuter les tâches dans l'ordre.
- Déploiement : le Lot 1 (Tasks 2-3-4) se déploie d'un bloc ; la Task 14 exige `ENCRYPTION_KEY` définie sur Render avant déploiement.

