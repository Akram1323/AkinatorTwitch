# 2FA complète, actions admin, nettoyage `init-db` — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre atteignables depuis l'application les cinq fonctionnalités déjà implémentées côté backend mais sans façade (codes de secours 2FA, désactivation 2FA, rétrogradation et déverrouillage admin, secret TOTP manuel), et supprimer le script `init-db` mort.

**Architecture:** Aucune nouvelle couche. Trois routes backend existantes sont étendues (`/a2f/setup`, `/a2f/verify-setup`, `/a2f/disable`), le reste est du câblage frontend vanilla sur des routes déjà en place. La seule décision structurante : `verify-setup` génère et renvoie les codes de secours dans la même transaction que l'activation, pour qu'il soit impossible d'avoir une 2FA active sans codes.

**Tech Stack:** Node.js 20.11, Express 4, better-sqlite3, speakeasy (TOTP), `node --test` + supertest, frontend HTML/CSS/JS vanilla sans framework ni bundler.

**Spec de référence :** `docs/superpowers/specs/2026-07-25-implementations-2fa-admin-design.md`

## Global Constraints

- Toutes les commandes de test se lancent depuis `AkinatorWeb/backend` avec le chemin absolu du binaire : `/usr/bin/node --test tests/<fichier>` (le `node` nu est intercepté par un hook local).
- Les routes `/api/a2f/*` et `/api/admin/*` sont derrière `authenticateToken` **et** `csrfProtection` : toute requête de test mutante doit porter un cookie de session **et** un header `X-CSRF-Token` obtenu via `GET /api/csrf-token`.
- Style du dépôt : commentaires et messages utilisateur en français, indentation 4 espaces, JSDoc sur les fonctions exportées.
- Aucun framework, aucun bundler, aucune dépendance npm nouvelle. Le frontend est servi tel quel.
- La CSP interdit le JavaScript inline (`scriptSrc: ["'self'"]`) : tout gestionnaire d'événement passe par `addEventListener`, jamais par un attribut `onclick=` dans le HTML.
- Un mot de passe de test valide doit passer zxcvbn score ≥ 3 : utiliser `C0rrect!Horse#Battery9`.
- Chaque tâche se termine par un commit. Ne jamais commiter sur `main`.

## Découpage en PR

| PR | Tâches | Contenu |
|----|--------|---------|
| n°1 | 1 | Suppression de `init-db` |
| n°2 | 2, 3 | Actions admin (frontend seul) |
| n°3 | 4 à 9 | 2FA complète |

Livrer dans cet ordre : le lot touchant au parcours d'authentification passe en dernier, quand les deux autres sont mergés et ne polluent plus le diff.

## Structure des fichiers

| Fichier | Responsabilité | Tâches |
|---------|----------------|--------|
| `AkinatorWeb/backend/package.json` | Retrait du script mort | 1 |
| `README.md` | Doc installation + routes 2FA | 1, 6 |
| `AkinatorWeb/frontend/js/api.js` | Client HTTP : `unlockUser`, `generateBackupCodes` | 2, 8 |
| `AkinatorWeb/frontend/js/app.js` | UI admin + UI 2FA | 2, 3, 7, 8, 9 |
| `AkinatorWeb/frontend/index.html` | Champ de code au login, modales codes de secours et désactivation | 7, 8, 9 |
| `AkinatorWeb/backend/routes/a2f.js` | `/setup`, `/verify-setup`, `/disable` | 4, 5, 6 |
| `AkinatorWeb/backend/tests/a2f-secret-exposure.test.js` | Créé — secret renvoyé par `/setup` | 4 |
| `AkinatorWeb/backend/tests/a2f-activation-codes.test.js` | Créé — invariant « 2FA active ⇒ codes disponibles » | 5 |
| `AkinatorWeb/backend/tests/a2f-disable.test.js` | Créé — désactivation par TOTP et par code de secours | 6 |

---

## PR n°1 — Nettoyage

### Task 1: Supprimer le script `init-db` mort

`npm run init-db` pointe sur `AkinatorWeb/backend/services/initDatabase.js`, qui n'existe pas. Le README le recommande pourtant. Le démarrage du serveur (`server.js` → `initializeTables()` puis `initializeDecisionTree()`) crée déjà tables et arbre de décision : un script séparé serait un doublon à maintenir.

**Files:**
- Modify: `AkinatorWeb/backend/package.json:8`
- Modify: `README.md:131`

**Interfaces:**
- Consumes: rien
- Produces: rien

- [ ] **Step 1: Constater la casse**

```bash
cd AkinatorWeb/backend && npm run init-db
```

Attendu : `Error: Cannot find module '.../services/initDatabase.js'`.

- [ ] **Step 2: Retirer la ligne du package.json**

Dans `AkinatorWeb/backend/package.json`, supprimer la ligne :

```json
    "init-db": "node services/initDatabase.js",
```

Le bloc `scripts` devient :

```json
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "node --test tests/"
  },
```

- [ ] **Step 3: Corriger le README**

Dans `README.md`, remplacer :

```markdown
> Scripts utiles : `npm run init-db`, ainsi que les outils dans `backend/scripts/`
```

par :

```markdown
> La base et l'arbre de décision sont créés au démarrage du serveur, aucune
> commande d'initialisation n'est nécessaire. Outils d'administration dans
> `backend/scripts/`
```

- [ ] **Step 4: Vérifier qu'aucune autre référence ne subsiste**

```bash
cd /home/valentin/AkinatorTwitch && grep -rn "init-db\|initDatabase" --include="*.json" --include="*.md" --include="*.js" --include="*.yml" . | grep -v node_modules
```

Attendu : aucune sortie.

- [ ] **Step 5: Vérifier que la suite reste verte**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/
```

Attendu : `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add AkinatorWeb/backend/package.json README.md
git commit -m "chore: supprime le script init-db mort

npm run init-db pointait sur services/initDatabase.js, fichier inexistant :
la commande échouait en Cannot find module. Le README la recommandait.

Supprimé plutôt que réécrit : le démarrage du serveur appelle déjà
initializeTables() puis initializeDecisionTree(), un script séparé serait un
doublon à maintenir en parallèle."
```

---

## PR n°2 — Actions admin

### Task 2: Exposer `unlockUser` et la lecture UTC des dates dans le client

Le backend expose `POST /api/admin/users/:id/unlock` depuis toujours ; `api.js` n'a aucune méthode pour l'appeler. Par ailleurs le front va devoir afficher `locked_until`, qui arrive au format SQLite (`"YYYY-MM-DD HH:MM:SS"`, **UTC sans indicateur de fuseau**). Un `new Date(valeur)` l'interpréterait en heure locale et réintroduirait exactement le bug corrigé par la PR #17 — ici sous forme d'un badge « verrouillé » qui disparaît deux heures trop tôt.

**Files:**
- Modify: `AkinatorWeb/frontend/js/api.js` (section ADMIN, après `demoteUser`)
- Modify: `AkinatorWeb/frontend/js/app.js` (après `escapeHtml`, en haut du fichier)

**Interfaces:**
- Consumes: `API.request` (existant)
- Produces:
  - `API.unlockUser(userId: string): Promise<{success: boolean, message: string}>`
  - `parseSqliteDateUTC(value: string|null): Date|null` — global de `app.js`
  - `estVerrouille(user: {locked_until: string|null}): boolean`

- [ ] **Step 1: Ajouter la méthode API**

Dans `AkinatorWeb/frontend/js/api.js`, juste après `demoteUser` :

```javascript
    async unlockUser(userId) {
        return this.post(`/admin/users/${userId}/unlock`, {});
    },
```

- [ ] **Step 2: Ajouter les helpers de date dans app.js**

Dans `AkinatorWeb/frontend/js/app.js`, juste après la fonction `escapeHtml` :

```javascript
/**
 * Convertit un horodatage SQLite ("YYYY-MM-DD HH:MM:SS") en Date.
 * Ces valeurs sont écrites en UTC sans indicateur de fuseau : `new Date()` les
 * interpréterait en heure LOCALE et afficherait une heure fausse (2 h d'écart en
 * Europe/Paris l'été), avec un verrou qui semble expirer trop tôt.
 * Pendant du services/sqliteDate.js côté serveur.
 */
function parseSqliteDateUTC(value) {
    if (!value) return null;
    var brut = String(value);
    var aUnFuseau = /[Z]$|[+-]\d{2}:?\d{2}$/.test(brut);
    var normalise = aUnFuseau ? brut : brut.replace(' ', 'T') + 'Z';
    var date = new Date(normalise);
    return isNaN(date.getTime()) ? null : date;
}

/** Un compte est-il actuellement verrouillé ? */
function estVerrouille(user) {
    var fin = parseSqliteDateUTC(user.locked_until);
    return fin !== null && fin.getTime() > Date.now();
}
```

- [ ] **Step 3: Vérifier le helper à la main**

```bash
cd /home/valentin/AkinatorTwitch/AkinatorWeb/frontend && TZ=Europe/Paris /usr/bin/node -e "
$(sed -n '/^function parseSqliteDateUTC/,/^}/p' js/app.js)
const dans15 = new Date(Date.now() + 15*60000).toISOString().slice(0,19).replace('T',' ');
console.log('SQLite    :', dans15);
console.log('parsé UTC :', parseSqliteDateUTC(dans15).toISOString());
console.log('futur ?   :', parseSqliteDateUTC(dans15) > new Date(), '(doit être true)');
console.log('naïf      :', new Date(dans15) > new Date(), '(false = le piège)');
"
```

Attendu : `futur ? true` et `naïf false`. Si `futur ?` vaut `false`, le helper est faux.

- [ ] **Step 4: Commit**

```bash
git add AkinatorWeb/frontend/js/api.js AkinatorWeb/frontend/js/app.js
git commit -m "feat(admin): expose unlockUser et la lecture UTC des dates côté client

POST /api/admin/users/:id/unlock existait sans aucune méthode cliente.

parseSqliteDateUTC est le pendant front de services/sqliteDate.js : locked_until
arrive en UTC sans fuseau, un new Date() naïf afficherait une heure fausse et
ferait disparaître le badge de verrouillage deux heures trop tôt."
```

### Task 3: Boutons Rétrograder et Déverrouiller dans le tableau admin

`API.demoteUser` existe et n'est appelée par aucun bouton ; le déverrouillage n'a ni bouton ni méthode (ajoutée en Task 2). Le README annonce pourtant « déblocage de comptes ». L'affichage de l'état de verrouillage est possible depuis la PR #17 : `locked_until` et `failed_login_attempts` font partie de la liste blanche `projectUser`.

**Files:**
- Modify: `AkinatorWeb/frontend/js/app.js` — fonction `displayUsers`, colonne Admin et colonne Actions ; ajout de `demoteUserAction` et `unlockUserAction`

**Interfaces:**
- Consumes: `API.demoteUser`, `API.unlockUser` (Task 2), `estVerrouille` (Task 2), `parseSqliteDateUTC` (Task 2), `loadAdminData`, `showToast` (existants)
- Produces: `demoteUserAction(userId, username)`, `unlockUserAction(userId, username)`

- [ ] **Step 1: Ajouter le badge de verrouillage dans la colonne Admin**

Dans `displayUsers`, remplacer le bloc actuel :

```javascript
        // Admin status
        const tdAdmin = document.createElement('td');
        if (user.is_admin) {
            const adminSpan = document.createElement('span');
            adminSpan.style.color = 'var(--primary)';
            adminSpan.textContent = '✓ Admin';
            tdAdmin.appendChild(adminSpan);
        } else {
            tdAdmin.textContent = '-';
        }
        tr.appendChild(tdAdmin);
```

par :

```javascript
        // Admin status + état de verrouillage
        const tdAdmin = document.createElement('td');
        if (user.is_admin) {
            const adminSpan = document.createElement('span');
            adminSpan.style.color = 'var(--primary)';
            adminSpan.textContent = '✓ Admin';
            tdAdmin.appendChild(adminSpan);
        } else {
            tdAdmin.textContent = '-';
        }
        if (estVerrouille(user)) {
            const lockSpan = document.createElement('span');
            lockSpan.style.cssText = 'color:var(--danger,#e05561);display:block;font-size:0.75rem;';
            const fin = parseSqliteDateUTC(user.locked_until);
            lockSpan.textContent = '🔒 Verrouillé jusqu\'à ' +
                fin.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            lockSpan.title = user.failed_login_attempts + ' tentative(s) échouée(s)';
            tdAdmin.appendChild(lockSpan);
        }
        tr.appendChild(tdAdmin);
```

- [ ] **Step 2: Ajouter les deux boutons dans la colonne Actions**

Dans `displayUsers`, juste après le bloc du bouton « Promote » (`if (!user.is_admin) { ... }`), insérer :

```javascript
        // Rétrograder (admins seulement, jamais soi-même : le backend le refuse déjà)
        if (user.is_admin && user.id !== currentUser.id) {
            const btnDemote = document.createElement('button');
            btnDemote.className = 'btn btn-sm btn-ghost';
            btnDemote.title = 'Rétrograder en utilisateur normal';
            btnDemote.onclick = () => demoteUserAction(user.id, user.username);
            btnDemote.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
            tdActions.appendChild(btnDemote);
        }

        // Déverrouiller (uniquement si le compte est effectivement verrouillé)
        if (estVerrouille(user)) {
            const btnUnlock = document.createElement('button');
            btnUnlock.className = 'btn btn-sm btn-accent';
            btnUnlock.title = 'Déverrouiller le compte';
            btnUnlock.onclick = () => unlockUserAction(user.id, user.username);
            btnUnlock.innerHTML = '<i class="fa-solid fa-lock-open"></i>';
            tdActions.appendChild(btnUnlock);
        }
```

- [ ] **Step 3: Ajouter les deux actions**

Juste après la fonction `promoteUser` dans `app.js` :

```javascript
async function demoteUserAction(userId, username) {
    if (!confirm(`Rétrograder ${username} en utilisateur normal ?`)) {
        return;
    }

    try {
        await API.demoteUser(userId);
        showToast(`${username} rétrogradé`, 'success');
        loadAdminData();
    } catch (error) {
        showToast(error.message || 'Erreur lors de la rétrogradation', 'error');
    }
}

async function unlockUserAction(userId, username) {
    if (!confirm(`Déverrouiller le compte ${username} ?\n\nLes tentatives échouées seront remises à zéro.`)) {
        return;
    }

    try {
        await API.unlockUser(userId);
        showToast(`Compte ${username} déverrouillé`, 'success');
        loadAdminData();
    } catch (error) {
        showToast(error.message || 'Erreur lors du déverrouillage', 'error');
    }
}
```

Puis, dans le bloc d'exports globaux existant (`window.viewUserDetails = viewUserDetails;` …), ajouter :

```javascript
window.demoteUserAction = demoteUserAction;
window.unlockUserAction = unlockUserAction;
```

- [ ] **Step 4: Vérification manuelle — préparer un compte verrouillé**

Aucun harnais de test frontend n'existe dans ce dépôt : cette étape se vérifie à la main, et le rapport de fin de tâche doit le dire explicitement.

```bash
cd AkinatorWeb/backend
# Serveur en tâche de fond
JWT_SECRET=$(openssl rand -hex 64) ADMIN_USERNAME=Akinator ADMIN_PASSWORD='C0rrect!Horse#Battery9' /usr/bin/node server.js &
sleep 3
# Compte cible verrouillé et second admin, directement en base
/usr/bin/node -e "
const Database = require('better-sqlite3');
const db = new Database('./data/akinator.db');
db.prepare(\"UPDATE users SET locked_until = datetime('now','+15 minutes'), failed_login_attempts = 5 WHERE username = 'Akinator'\").run();
console.log(db.prepare('SELECT username, locked_until, failed_login_attempts, is_admin FROM users').all());
"
```

- [ ] **Step 5: Vérification manuelle — contrôler l'affichage**

Ouvrir http://localhost:3000, se connecter en `Akinator`, ouvrir le panneau Admin et vérifier, dans cet ordre :

1. La ligne du compte verrouillé porte le badge `🔒 Verrouillé jusqu'à HH:MM`.
2. **L'heure affichée correspond à « maintenant + 15 minutes » en heure locale.** Si elle est décalée de deux heures, `parseSqliteDateUTC` n'est pas utilisé au bon endroit.
3. Un bouton cadenas ouvert apparaît sur cette ligne, et sur elle seule.
4. Cliquer dessus → toast de succès, le badge et le bouton disparaissent après rechargement.
5. Le bouton « rétrograder » apparaît sur les autres comptes admin, jamais sur le sien.

Arrêter le serveur : `kill %1`.

- [ ] **Step 6: Vérifier que la suite backend reste verte**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/
```

Attendu : `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add AkinatorWeb/frontend/js/app.js
git commit -m "feat(admin): boutons Rétrograder et Déverrouiller, badge de verrouillage

POST /users/:id/demote et /users/:id/unlock existaient sans aucun bouton pour
les appeler, alors que le README annonce le déblocage de comptes.

Le bouton de déverrouillage n'apparaît que sur un compte effectivement
verrouillé, et l'échéance est lue via parseSqliteDateUTC : locked_until arrive
en UTC sans fuseau, un new Date() naïf ferait disparaître le badge deux heures
trop tôt.

Vérifié manuellement (aucun harnais de test frontend dans ce dépôt)."
```

---

## PR n°3 — 2FA complète

### Task 4: `/a2f/setup` renvoie le secret TOTP

`app.js` lit `response.data.secret` que la route ne renvoie pas : le bloc « ou entrez ce code manuellement » affiche `undefined`. Le QR code encode déjà ce secret en clair — le masquer n'apporte aucune sécurité et interdit l'appairage manuel (poste sans caméra, lecteur d'écran, application n'acceptant que la saisie).

**Files:**
- Modify: `AkinatorWeb/backend/routes/a2f.js:61-68` (réponse de `POST /setup`)
- Test: `AkinatorWeb/backend/tests/a2f-secret-exposure.test.js` (créé)

**Interfaces:**
- Consumes: rien
- Produces: `POST /api/a2f/setup` → `{ success: true, data: { qrCode: string, secret: string, otpauthUrl: string } }`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `AkinatorWeb/backend/tests/a2f-secret-exposure.test.js` :

```javascript
/**
 * /a2f/setup doit renvoyer le secret TOTP en base32.
 * Le QR code l'encode déjà en clair : ne pas le renvoyer n'apportait aucune
 * sécurité et empêchait l'appairage manuel (poste sans caméra, lecteur d'écran).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/setup');

const PASSWORD = 'C0rrect!Horse#Battery9';

async function contexteAuthentifie(username) {
    await request(app).post('/api/auth/register').send({ username, password: PASSWORD, rgpdConsent: true });
    const login = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

test('/a2f/setup renvoie un secret base32 cohérent avec le QR code', async () => {
    const ctx = await contexteAuthentifie('a2fsecret1');

    const res = await request(app).post('/api/a2f/setup')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({});

    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.data.secret, 'string', 'le secret doit être renvoyé');
    assert.match(res.body.data.secret, /^[A-Z2-7]+$/, 'base32 sans padding');
    assert.ok(res.body.data.secret.length >= 16, 'secret d\'au moins 16 caractères');

    // Le secret affiché doit être CELUI du QR : sinon l'appairage manuel produit
    // des codes qui ne valideront jamais.
    const otpauth = decodeURIComponent(res.body.data.otpauthUrl);
    assert.ok(otpauth.includes(res.body.data.secret),
        'le secret renvoyé doit être celui encodé dans l\'otpauth_url');
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/a2f-secret-exposure.test.js
```

Attendu : ÉCHEC sur `assert.strictEqual(typeof res.body.data.secret, 'string')` — reçu `undefined`.

- [ ] **Step 3: Renvoyer le secret**

Dans `AkinatorWeb/backend/routes/a2f.js`, route `POST /setup`, remplacer :

```javascript
        res.json({
            success: true,
            data: {
                qrCode: qrCodeDataUrl,
                // Secret non exposé pour sécurité (utiliser uniquement le QR code)
                otpauthUrl: secretObj.otpauth_url
            }
        });
```

par :

```javascript
        res.json({
            success: true,
            data: {
                qrCode: qrCodeDataUrl,
                // Le QR code encode déjà ce secret en clair : le renvoyer en texte
                // n'ajoute aucune exposition et permet l'appairage manuel (poste
                // sans caméra, lecteur d'écran, application sans scanner).
                secret,
                otpauthUrl: secretObj.otpauth_url
            }
        });
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/a2f-secret-exposure.test.js
```

Attendu : `# pass 1`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add AkinatorWeb/backend/routes/a2f.js AkinatorWeb/backend/tests/a2f-secret-exposure.test.js
git commit -m "feat(2fa): /a2f/setup renvoie le secret TOTP

app.js lisait response.data.secret que la route ne renvoyait pas : le bloc
« ou entrez ce code manuellement » affichait undefined.

Le QR code encode déjà ce secret en clair. Le masquer n'apportait donc aucune
sécurité et interdisait l'appairage manuel, seul recours sur un poste sans
caméra utilisable ou avec un lecteur d'écran."
```

### Task 5: `/a2f/verify-setup` génère et renvoie les codes de secours

Les codes de secours existent en base et sont consommables au login, mais aucune UI ne les génère : la fonctionnalité est inatteignable. Plutôt que d'appeler `/a2f/backup-codes` depuis le front après l'activation, `verify-setup` les génère lui-même **dans la même transaction** — sinon il existe une fenêtre où la 2FA est active sans qu'aucun code n'existe, si le second appel échoue (réseau coupé, onglet fermé).

**Files:**
- Modify: `AkinatorWeb/backend/routes/a2f.js:101-114` (activation dans `POST /verify-setup`)
- Test: `AkinatorWeb/backend/tests/a2f-activation-codes.test.js` (créé)

**Interfaces:**
- Consumes: `generateBackupCodes(userId)` de `services/twoFactor` (existant, renvoie `string[]` de 8 codes hex de 10 caractères et **supprime** les codes précédents) ; `POST /a2f/setup` renvoyant `secret` (Task 4)
- Produces: `POST /api/a2f/verify-setup` → `{ success: true, message: string, data: { codes: string[] } }`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `AkinatorWeb/backend/tests/a2f-activation-codes.test.js` :

```javascript
/**
 * Invariant : « 2FA active ⇒ codes de secours disponibles ».
 * L'activation et la génération des codes se font dans la même transaction, pour
 * qu'aucun utilisateur ne se retrouve protégé sans filet et sans le savoir.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const speakeasy = require('speakeasy');
const { app, db } = require('./helpers/setup');

const PASSWORD = 'C0rrect!Horse#Battery9';

async function contexteAuthentifie(username) {
    await request(app).post('/api/auth/register').send({ username, password: PASSWORD, rgpdConsent: true });
    const login = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    const userId = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username).id;
    return { cookie, csrfToken: csrf.body.data.csrfToken, userId };
}

/** Enchaîne /setup puis /verify-setup avec un vrai code TOTP. */
async function activerA2F(ctx) {
    const setup = await request(app).post('/api/a2f/setup')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({});
    assert.strictEqual(setup.status, 200);

    const code = speakeasy.totp({ secret: setup.body.data.secret, encoding: 'base32' });
    return request(app).post('/api/a2f/verify-setup')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({ code });
}

test('verify-setup renvoie 8 codes de secours distincts', async () => {
    const ctx = await contexteAuthentifie('a2fcodes1');

    const res = await activerA2F(ctx);

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data.codes), 'les codes doivent être renvoyés');
    assert.strictEqual(res.body.data.codes.length, 8);
    assert.strictEqual(new Set(res.body.data.codes).size, 8, 'codes tous distincts');
    for (const code of res.body.data.codes) {
        assert.match(code, /^[0-9a-f]{10}$/, 'code hexadécimal de 10 caractères');
    }
});

test('activation et codes sont atomiques : 2FA active ⇒ 8 codes utilisables en base', async () => {
    const ctx = await contexteAuthentifie('a2fcodes2');

    await activerA2F(ctx);

    const user = db.prepare('SELECT a2f_enabled FROM users WHERE id = ?').get(ctx.userId);
    assert.strictEqual(user.a2f_enabled, 1, '2FA activée');

    const dispo = db.prepare(
        'SELECT COUNT(*) AS n FROM a2f_backup_codes WHERE user_id = ? AND used_at IS NULL'
    ).get(ctx.userId).n;
    assert.strictEqual(dispo, 8, 'aucune 2FA active sans codes de secours disponibles');
});

test('les codes renvoyés fonctionnent réellement au login', async () => {
    const ctx = await contexteAuthentifie('a2fcodes3');
    const activation = await activerA2F(ctx);
    const codeSecours = activation.body.data.codes[0];

    // Login : la 2FA est active, on reçoit un token temporaire
    const login = await request(app).post('/api/auth/login')
        .send({ username: 'a2fcodes3', password: PASSWORD });
    assert.strictEqual(login.body.requiresA2F, true);

    const res = await request(app).post('/api/auth/verify-login-a2f')
        .set('Authorization', `Bearer ${login.body.data.tempToken}`)
        .send({ code: codeSecours });

    assert.strictEqual(res.status, 200, 'un code de secours doit ouvrir la session');
    assert.strictEqual(res.body.success, true);
});
```

- [ ] **Step 2: Lancer le test et vérifier qu'il échoue**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/a2f-activation-codes.test.js
```

Attendu : ÉCHEC — `res.body.data` est `undefined` (la route ne renvoie que `message`).

- [ ] **Step 3: Générer les codes dans la transaction d'activation**

L'import de la ligne 13 est déjà correct, aucune modification n'y est nécessaire :

```javascript
const { generateBackupCodes, verifyTotp } = require('../services/twoFactor');
```

Remplacer, dans `POST /verify-setup` :

```javascript
        // Activer l'A2F
        const updateStmt = db.prepare(
            'UPDATE users SET a2f_enabled = 1 WHERE id = ?'
        );
        updateStmt.run(user.id);

        console.log(`✅ A2F activé: ${user.username}`);

        appendAudit('a2f.enabled', { userId: user.id });

        res.json({
            success: true,
            message: 'A2F activé avec succès'
        });
```

par :

```javascript
        // Activation et génération des codes de secours dans la MÊME transaction.
        // Les découpler laisserait une fenêtre où la 2FA est active sans qu'aucun
        // code n'existe : si le second appel échouait (réseau, onglet fermé),
        // l'utilisateur serait protégé sans filet et l'ignorerait.
        const activer = db.transaction(() => {
            db.prepare('UPDATE users SET a2f_enabled = 1 WHERE id = ?').run(user.id);
            return generateBackupCodes(user.id);
        });
        const codes = activer();

        console.log(`✅ A2F activé: ${user.username}`);

        appendAudit('a2f.enabled', { userId: user.id });

        res.json({
            success: true,
            message: 'A2F activé avec succès',
            data: { codes }
        });
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/a2f-activation-codes.test.js
```

Attendu : `# pass 3`, `# fail 0`.

- [ ] **Step 5: Vérifier la non-régression 2FA**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/backup-codes.test.js tests/totp-replay.test.js tests/audit-events.test.js tests/pending2fa-bypass.test.js
```

Attendu : `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add AkinatorWeb/backend/routes/a2f.js AkinatorWeb/backend/tests/a2f-activation-codes.test.js
git commit -m "feat(2fa): verify-setup génère et renvoie les codes de secours

Les codes de secours existaient en base et étaient consommables au login, mais
aucune UI ne les générait : fonctionnalité inatteignable.

Générés par verify-setup lui-même, dans la même transaction que l'activation,
plutôt que par un second appel côté client. Découpler les deux laisserait une
fenêtre où la 2FA est active sans qu'aucun code n'existe : si l'appel de suivi
échouait, l'utilisateur serait protégé sans filet et l'ignorerait.

L'invariant testé est « 2FA active ⇒ 8 codes disponibles »."
```

### Task 6: `/a2f/disable` accepte un code de secours, et ne plante plus sans mot de passe

Un utilisateur qui perd son téléphone peut se connecter (le login accepte les codes de secours) mais ne peut plus jamais désactiver sa 2FA : impasse. Par ailleurs `bcrypt.compare(undefined, hash)` lève quand `password` est absent, ce qui produit un **500** au lieu d'un 400.

**Files:**
- Modify: `AkinatorWeb/backend/routes/a2f.js:158-201` (`POST /disable`)
- Modify: `README.md:214` (liste des routes 2FA — `/backup-codes` y manque)
- Test: `AkinatorWeb/backend/tests/a2f-disable.test.js` (créé)

**Interfaces:**
- Consumes: `consumeBackupCode(userId, code)` et `verifyTotp(user, code)` de `services/twoFactor` ; `activerA2F` (même motif qu'en Task 5)
- Produces: `POST /api/a2f/disable` accepte `{ password: string, code: string }` où `code` est soit 6 chiffres (TOTP) soit 10 caractères hexadécimaux (code de secours)

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `AkinatorWeb/backend/tests/a2f-disable.test.js` :

```javascript
/**
 * Désactivation de la 2FA.
 * Le code de secours doit être accepté au même titre que le TOTP : sans cela, un
 * utilisateur ayant perdu son téléphone peut se connecter (le login les accepte)
 * mais reste bloqué avec une 2FA qu'il ne peut plus désactiver.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const speakeasy = require('speakeasy');
const { app, db } = require('./helpers/setup');

const PASSWORD = 'C0rrect!Horse#Battery9';

async function contexteAuthentifie(username) {
    await request(app).post('/api/auth/register').send({ username, password: PASSWORD, rgpdConsent: true });
    const login = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    const userId = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username).id;
    return { cookie, csrfToken: csrf.body.data.csrfToken, userId };
}

/** Active (ou réactive) la 2FA pour un contexte donné. */
async function activerA2FPour(ctx) {
    const setup = await request(app).post('/api/a2f/setup')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({});
    assert.strictEqual(setup.status, 200, 'setup 2FA échoué');
    const secret = setup.body.data.secret;

    const verify = await request(app).post('/api/a2f/verify-setup')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken)
        .send({ code: speakeasy.totp({ secret, encoding: 'base32' }) });
    assert.strictEqual(verify.status, 200, 'activation 2FA échouée');

    return { secret, codes: verify.body.data.codes };
}

/** Crée un compte et active sa 2FA. Renvoie { ctx, secret, codes }. */
async function activerA2F(username) {
    const ctx = await contexteAuthentifie(username);
    const { secret, codes } = await activerA2FPour(ctx);
    return { ctx, secret, codes };
}

function disable(ctx, body) {
    return request(app).post('/api/a2f/disable')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send(body);
}

test('un code de secours désactive la 2FA', async () => {
    const { ctx, codes } = await activerA2F('a2fdis1');

    const res = await disable(ctx, { password: PASSWORD, code: codes[0] });

    assert.strictEqual(res.status, 200, `attendu 200, reçu ${res.status} (${res.body.error})`);
    const user = db.prepare('SELECT a2f_enabled, a2f_secret FROM users WHERE id = ?').get(ctx.userId);
    assert.strictEqual(user.a2f_enabled, 0);
    assert.strictEqual(user.a2f_secret, null, 'le secret doit être effacé');
});

test('un code TOTP désactive toujours la 2FA (non-régression)', async () => {
    const { ctx, secret } = await activerA2F('a2fdis2');

    // Code du pas suivant : l'activation vient de consommer le pas courant (anti-rejeu)
    const futur = speakeasy.totp({
        secret, encoding: 'base32', time: (Date.now() / 1000) + 30
    });
    const res = await disable(ctx, { password: PASSWORD, code: futur });

    assert.strictEqual(res.status, 200, `attendu 200, reçu ${res.status} (${res.body.error})`);
    assert.strictEqual(
        db.prepare('SELECT a2f_enabled FROM users WHERE id = ?').get(ctx.userId).a2f_enabled, 0);
});

test('un ancien code de secours ne repasse pas après réactivation', async () => {
    const { ctx, codes } = await activerA2F('a2fdis3');
    const ancienCode = codes[0];

    const premier = await disable(ctx, { password: PASSWORD, code: ancienCode });
    assert.strictEqual(premier.status, 200);

    // Réactivation : de NOUVEAUX codes sont émis, les anciens sont purgés.
    // Attention : sans cette réactivation, /disable serait un no-op renvoyant 200
    // (le second facteur n'est exigé que si la 2FA est active), et le test ne
    // vérifierait rien du tout.
    await activerA2FPour(ctx);

    const rejeu = await disable(ctx, { password: PASSWORD, code: ancienCode });
    assert.strictEqual(rejeu.status, 401, 'un code d\'une génération précédente doit être refusé');
    assert.strictEqual(
        db.prepare('SELECT a2f_enabled FROM users WHERE id = ?').get(ctx.userId).a2f_enabled, 1,
        'la 2FA doit rester active après un code refusé');
});

test('mot de passe incorrect refusé même avec un code valide', async () => {
    const { ctx, codes } = await activerA2F('a2fdis4');

    const res = await disable(ctx, { password: 'Mauvais!MotDePasse#42', code: codes[0] });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(
        db.prepare('SELECT a2f_enabled FROM users WHERE id = ?').get(ctx.userId).a2f_enabled, 1,
        'la 2FA doit rester active');
});

test('mot de passe absent → 400, jamais 500', async () => {
    const { ctx, codes } = await activerA2F('a2fdis5');

    const res = await disable(ctx, { code: codes[0] });

    assert.strictEqual(res.status, 400,
        'bcrypt.compare(undefined, hash) lève : ce chemin doit être gardé en amont');
});

test('désactiver purge les codes de secours restants', async () => {
    const { ctx, codes } = await activerA2F('a2fdis6');

    await disable(ctx, { password: PASSWORD, code: codes[0] });

    const restants = db.prepare(
        'SELECT COUNT(*) AS n FROM a2f_backup_codes WHERE user_id = ?'
    ).get(ctx.userId).n;
    assert.strictEqual(restants, 0, 'aucun code ne doit survivre à la désactivation');
});
```

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/a2f-disable.test.js
```

Attendu : au moins trois échecs — le code de secours refusé (401), le mot de passe absent en 500, et les codes non purgés.

- [ ] **Step 3: Réécrire la route `/disable`**

Dans `AkinatorWeb/backend/routes/a2f.js`, ligne 13, ajouter `consumeBackupCode` à l'import (il n'y figure pas aujourd'hui) :

```javascript
const { generateBackupCodes, verifyTotp, consumeBackupCode } = require('../services/twoFactor');
```

Puis remplacer tout le corps de `POST /disable` (de `const { code, password } = req.body;` jusqu'au `res.json` de succès) par :

```javascript
        const { code, password } = req.body;
        const bcrypt = require('bcrypt');

        // Garde explicite : bcrypt.compare(undefined, hash) lève, ce qui
        // produirait un 500 là où la requête est simplement incomplète.
        if (typeof password !== 'string' || password.length === 0) {
            return res.status(400).json({ success: false, error: 'Mot de passe requis' });
        }

        const user = queries.users.findById.get(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
        }

        // Facteur 1 : le mot de passe, toujours exigé
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ success: false, error: 'Mot de passe incorrect' });
        }

        // Facteur 2 : TOTP ou code de secours. Accepter le code de secours ferme
        // l'impasse de la perte du téléphone — le login les accepte déjà, sans quoi
        // l'utilisateur reste bloqué avec une 2FA qu'il ne peut plus désactiver.
        let methode = 'totp';
        if (user.a2f_enabled && user.a2f_secret) {
            const saisie = String(code || '').trim();

            if (saisie.length === 10) {
                methode = 'backup_code';
                if (!consumeBackupCode(user.id, saisie)) {
                    return res.status(401).json({ success: false, error: 'Code de secours invalide' });
                }
            } else {
                const totpResult = verifyTotp(user, saisie);
                if (!totpResult.ok) {
                    return res.status(401).json({ success: false, error: totpResult.error });
                }
            }
        }

        // Désactivation et purge des codes dans la même transaction : un code
        // survivant n'aurait plus aucun usage et resterait un secret à protéger.
        const desactiver = db.transaction(() => {
            db.prepare('UPDATE users SET a2f_enabled = 0, a2f_secret = NULL WHERE id = ?').run(user.id);
            db.prepare('DELETE FROM a2f_backup_codes WHERE user_id = ?').run(user.id);
        });
        desactiver();

        console.log(`🔓 A2F désactivé: ${user.username}`);

        appendAudit('a2f.disabled', { userId: user.id, details: { method: methode } });

        res.json({
            success: true,
            message: 'A2F désactivé'
        });
```

- [ ] **Step 4: Lancer les tests et vérifier qu'ils passent**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/a2f-disable.test.js
```

Attendu : `# pass 6`, `# fail 0`.

- [ ] **Step 5: Compléter la liste des routes 2FA dans le README**

Dans `README.md`, remplacer :

```markdown
`POST /setup` · `POST /verify-setup` · `POST /verify` · `POST /disable` · `GET /status`
```

par :

```markdown
`POST /setup` · `POST /verify-setup` · `POST /verify` · `POST /disable` ·
`POST /backup-codes` · `GET /status`

`verify-setup` renvoie les 8 codes de secours à l'activation ; `backup-codes` les
régénère (les anciens sont invalidés). `disable` exige le mot de passe **et** un
second facteur : code TOTP (6 chiffres) ou code de secours (10 caractères).
```

- [ ] **Step 6: Lancer la suite complète**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/
```

Attendu : `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add AkinatorWeb/backend/routes/a2f.js AkinatorWeb/backend/tests/a2f-disable.test.js README.md
git commit -m "feat(2fa): /a2f/disable accepte un code de secours

Un utilisateur ayant perdu son téléphone pouvait se connecter — le login accepte
les codes de secours — mais ne pouvait plus jamais désactiver sa 2FA. Impasse
fermée en réutilisant la logique déjà écrite dans verify-login-a2f.

Corrige aussi un 500 : sans champ password, bcrypt.compare(undefined, hash)
levait au lieu de renvoyer 400.

La désactivation purge désormais les codes de secours restants : ils n'auraient
plus aucun usage et resteraient un secret à protéger."
```

### Task 7: Saisie d'un code de secours au login

Le champ du modal de vérification 2FA est `maxlength="6"` et `app.js` refuse tout ce qui ne fait pas exactement 6 caractères. Un code de secours en fait 10 : il est littéralement insaisissable, alors que le backend l'accepte depuis toujours (`verify-login-a2f` traite `length === 10` comme code de secours).

**Files:**
- Modify: `AkinatorWeb/frontend/index.html:643-644` (champ `a2fLoginCode`)
- Modify: `AkinatorWeb/frontend/js/app.js` — fonction `verifyA2FLogin`

**Interfaces:**
- Consumes: `API.verifyLoginA2F(code, tempToken)` (existant)
- Produces: rien

- [ ] **Step 1: Élargir le champ de saisie**

Dans `AkinatorWeb/frontend/index.html`, modale `a2fLoginModal`, remplacer :

```html
            <div class="form-group">
                <input type="text" id="a2fLoginCode" maxlength="6" pattern="[0-9]{6}" 
                       placeholder="000000" class="a2f-code-input" autocomplete="off">
            </div>
```

par :

```html
            <div class="form-group">
                <input type="text" id="a2fLoginCode" maxlength="10" pattern="[0-9]{6}|[0-9a-fA-F]{10}"
                       placeholder="000000" class="a2f-code-input" autocomplete="off">
                <small class="form-hint">Vous pouvez aussi saisir un de vos codes de secours (10 caractères).</small>
            </div>
```

- [ ] **Step 2: Accepter les deux longueurs dans la validation**

Dans `AkinatorWeb/frontend/js/app.js`, fonction `verifyA2FLogin`, remplacer :

```javascript
    if (!code || code.length !== 6) {
        errorDiv.textContent = 'Code invalide (6 chiffres)';
        errorDiv.style.display = 'block';
        return;
    }
```

par :

```javascript
    // 6 chiffres = code TOTP, 10 caractères hexadécimaux = code de secours.
    // Le backend accepte les deux depuis toujours (verify-login-a2f) ; c'est
    // uniquement cette validation cliente qui rendait les codes de secours
    // impossibles à saisir.
    var estTotp = /^[0-9]{6}$/.test(code);
    var estCodeSecours = /^[0-9a-fA-F]{10}$/.test(code);
    if (!estTotp && !estCodeSecours) {
        errorDiv.textContent = 'Entrez un code à 6 chiffres ou un code de secours à 10 caractères';
        errorDiv.style.display = 'block';
        return;
    }
```

- [ ] **Step 3: Vérification manuelle de bout en bout**

Aucun harnais de test frontend n'existe : cette étape se vérifie à la main.

```bash
cd AkinatorWeb/backend
JWT_SECRET=$(openssl rand -hex 64) /usr/bin/node server.js &
sleep 3
```

1. Créer un compte sur http://localhost:3000, activer la 2FA, **noter un code de secours** affiché (disponible après la Task 8 ; d'ici là, le récupérer via `POST /api/a2f/backup-codes` ou en base).
2. Se déconnecter, se reconnecter → la modale 2FA s'ouvre.
3. Saisir le code de secours de 10 caractères : le champ doit **accepter les 10 caractères** et la connexion aboutir.
4. Rejouer le même code : il doit être refusé (usage unique).

Arrêter le serveur : `kill %1`.

- [ ] **Step 4: Commit**

```bash
git add AkinatorWeb/frontend/index.html AkinatorWeb/frontend/js/app.js
git commit -m "fix(2fa): rend les codes de secours saisissables au login

Le champ était maxlength=6 et app.js refusait tout ce qui ne faisait pas
exactement 6 caractères, alors qu'un code de secours en fait 10 : la
fonctionnalité était inatteignable côté client bien que le backend l'accepte
depuis toujours (verify-login-a2f traite length === 10 comme code de secours).

Vérifié manuellement (aucun harnais de test frontend dans ce dépôt)."
```

### Task 8: Modale des codes de secours et régénération

Les codes renvoyés par `verify-setup` (Task 5) doivent être montrés à l'utilisateur — c'est la seule et unique occasion, ils ne sont stockés que hashés. Un bouton de régénération doit rester accessible ensuite.

**Files:**
- Modify: `AkinatorWeb/frontend/index.html` (nouvelle modale après `a2fSetupModal` ; bouton dans l'onglet Sécurité)
- Modify: `AkinatorWeb/frontend/js/api.js` (section A2F)
- Modify: `AkinatorWeb/frontend/js/app.js` (`verifyA2FSetup`, `setupA2F`, nouvelles fonctions, `attachEventListeners`)

**Interfaces:**
- Consumes: `POST /api/a2f/verify-setup` → `data.codes` (Task 5), `POST /api/a2f/backup-codes` → `data.codes` (existant), `POST /api/a2f/setup` → `data.secret` (Task 4)
- Produces:
  - `API.generateBackupCodes(): Promise<{data: {codes: string[]}}>`
  - `afficherCodesSecours(codes: string[]): void`

- [ ] **Step 1: Ajouter la méthode API**

Dans `AkinatorWeb/frontend/js/api.js`, section A2F, après `disableA2F` :

```javascript
    async generateBackupCodes() {
        return this.post('/a2f/backup-codes', {});
    },
```

- [ ] **Step 2: Ajouter la modale au HTML**

Dans `AkinatorWeb/frontend/index.html`, juste après la fermeture de la modale `a2fSetupModal`, insérer :

```html
    <!-- Backup Codes Modal -->
    <div class="modal" id="backupCodesModal">
        <div class="modal-backdrop" data-close="backupCodesModal"></div>
        <div class="modal-content">
            <button class="modal-close" data-close="backupCodesModal">×</button>
            <h2><i class="fa-solid fa-key icon-title"></i> Vos codes de secours</h2>
            <div class="info-box" style="background:rgba(224,85,97,0.1);border:1px solid rgba(224,85,97,0.3);border-radius:var(--radius-sm);padding:var(--spacing-sm);margin-bottom:var(--spacing-md);font-size:0.85rem;color:var(--text-secondary);">
                <i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>
                Conservez-les hors de votre téléphone. Chaque code ne sert
                <strong>qu'une fois</strong> et ils ne seront <strong>plus jamais affichés</strong>.
                Ils vous permettent de vous connecter si vous perdez votre application
                d'authentification.
            </div>
            <ul id="backupCodesList" class="backup-codes-list"></ul>
            <div class="results-actions">
                <button class="btn btn-primary" id="copyBackupCodes">
                    <i class="fa-solid fa-copy icon"></i> Copier
                </button>
                <button class="btn btn-ghost" id="downloadBackupCodes">
                    <i class="fa-solid fa-download icon"></i> Télécharger
                </button>
            </div>
        </div>
    </div>
```

- [ ] **Step 3: Ajouter le bouton de régénération dans l'onglet Sécurité**

Dans `index.html`, section `settings-section` de l'A2F, juste après la ligne `<p class="settings-note">L'A2F utilise une application comme Google Authenticator ou Authy.</p>`, insérer :

```html
                    <button class="btn btn-ghost" id="regenerateBackupCodes" style="display:none;margin-top:var(--spacing-sm);">
                        <i class="fa-solid fa-key icon"></i> Régénérer mes codes de secours
                    </button>
```

- [ ] **Step 4: Ajouter le style de la liste**

Dans `AkinatorWeb/frontend/css/style.css`, à la fin du fichier :

```css
/* Codes de secours 2FA */
.backup-codes-list {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.5rem;
    margin: 0 0 var(--spacing-md);
    padding: 0;
}

.backup-codes-list li {
    font-family: monospace;
    font-size: 1rem;
    letter-spacing: 0.08em;
    text-align: center;
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: var(--radius-sm);
}
```

- [ ] **Step 5: Afficher les codes après activation**

Dans `AkinatorWeb/frontend/js/app.js`, dans `verifyA2FSetup`, remplacer :

```javascript
        if (response.success) {
            currentUser.a2fEnabled = true;
            closeModal('a2fSetupModal');
            updateA2FStatus();
            showToast('A2F activé avec succès !', 'success');
        }
```

par :

```javascript
        if (response.success) {
            currentUser.a2fEnabled = true;
            closeModal('a2fSetupModal');
            updateA2FStatus();
            showToast('A2F activé avec succès !', 'success');
            // Unique occasion de les montrer : ils ne sont stockés que hashés.
            afficherCodesSecours(response.data.codes);
        }
```

- [ ] **Step 6: Écrire les fonctions d'affichage**

Dans `app.js`, juste après `verifyA2FSetup` :

```javascript
/** Codes actuellement affichés, pour les boutons Copier / Télécharger. */
var codesSecoursAffiches = [];

function afficherCodesSecours(codes) {
    codesSecoursAffiches = codes || [];

    var liste = document.getElementById('backupCodesList');
    liste.innerHTML = '';
    codesSecoursAffiches.forEach(function(code) {
        var li = document.createElement('li');
        li.textContent = code;
        liste.appendChild(li);
    });

    showModal('backupCodesModal');
}

async function regenererCodesSecours() {
    if (!confirm('Générer de nouveaux codes de secours ?\n\nVos codes actuels seront définitivement invalidés.')) {
        return;
    }

    try {
        showLoading('Génération des codes...');
        var response = await API.generateBackupCodes();
        hideLoading();

        if (response.success) {
            afficherCodesSecours(response.data.codes);
            showToast('Nouveaux codes générés, les anciens sont invalidés', 'success');
        }
    } catch (error) {
        hideLoading();
        showToast(error.message || 'Erreur lors de la génération', 'error');
    }
}

async function copierCodesSecours() {
    var texte = codesSecoursAffiches.join('\n');

    // navigator.clipboard exige un contexte sécurisé (HTTPS ou localhost) :
    // sur un déploiement HTTP il est absent, on dégrade au lieu d'échouer en silence.
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(texte);
            showToast('Codes copiés dans le presse-papiers', 'success');
            return;
        } catch (error) { /* on retombe sur la sélection manuelle */ }
    }

    var liste = document.getElementById('backupCodesList');
    var selection = window.getSelection();
    var plage = document.createRange();
    plage.selectNodeContents(liste);
    selection.removeAllRanges();
    selection.addRange(plage);
    showToast('Copie automatique indisponible : les codes sont sélectionnés, copiez-les', 'warning');
}

function telechargerCodesSecours() {
    var contenu = 'Codes de secours AkinatorTwitch\n'
        + 'Compte : ' + (currentUser ? currentUser.username : '') + '\n'
        + 'Chaque code ne peut servir qu\'une seule fois.\n\n'
        + codesSecoursAffiches.join('\n') + '\n';

    var blob = new Blob([contenu], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var lien = document.createElement('a');
    lien.href = url;
    lien.download = 'akinator-codes-de-secours.txt';
    document.body.appendChild(lien);
    lien.click();
    document.body.removeChild(lien);
    URL.revokeObjectURL(url);
}
```

- [ ] **Step 7: Câbler les boutons**

Dans `attachEventListeners`, juste après la ligne `document.getElementById('verifyA2FSetup').addEventListener('click', verifyA2FSetup);` :

```javascript
    // Codes de secours 2FA
    document.getElementById('copyBackupCodes').addEventListener('click', copierCodesSecours);
    document.getElementById('downloadBackupCodes').addEventListener('click', telechargerCodesSecours);
    document.getElementById('regenerateBackupCodes').addEventListener('click', regenererCodesSecours);
```

- [ ] **Step 8: Afficher le bouton de régénération quand la 2FA est active**

Dans `updateA2FStatus`, ajouter en fin de fonction, avant la dernière accolade :

```javascript
    var btnRegen = document.getElementById('regenerateBackupCodes');
    if (btnRegen) {
        btnRegen.style.display = (currentUser && currentUser.a2fEnabled) ? 'inline-flex' : 'none';
    }
```

- [ ] **Step 9: Afficher le secret sous le QR**

Toujours dans `app.js`, fonction `setupA2F`, le code lit déjà `response.data.secret` — désormais fourni par la Task 4. Vérifier que ces deux lignes sont bien présentes et inchangées :

```javascript
            document.getElementById('a2fSecretCode').textContent = response.data.secret;
            document.getElementById('a2fSecretDisplay').style.display = 'block';
```

- [ ] **Step 10: Vérification manuelle**

```bash
cd AkinatorWeb/backend
JWT_SECRET=$(openssl rand -hex 64) /usr/bin/node server.js &
sleep 3
```

Sur http://localhost:3000, créer un compte puis, dans Profil → Sécurité :

1. « Activer l'A2F » → le QR s'affiche **et** le secret en clair dessous (plus de `undefined`).
2. Appairer, saisir le code → la modale « Vos codes de secours » s'ouvre avec **8 codes**.
3. « Copier » → toast de succès (en `localhost`, le presse-papiers est disponible).
4. « Télécharger » → fichier `akinator-codes-de-secours.txt` contenant les 8 codes.
5. Fermer, rouvrir Profil → Sécurité : le bouton « Régénérer mes codes de secours » est visible.
6. Régénérer → confirmation, puis 8 **nouveaux** codes.
7. Vérifier qu'un ancien code ne fonctionne plus au login.

Arrêter le serveur : `kill %1`.

- [ ] **Step 11: Commit**

```bash
git add AkinatorWeb/frontend/index.html AkinatorWeb/frontend/js/api.js AkinatorWeb/frontend/js/app.js AkinatorWeb/frontend/css/style.css
git commit -m "feat(2fa): affiche les codes de secours et permet leur régénération

Les codes sont montrés à l'activation — unique occasion, ils ne sont stockés que
hashés — avec copie et téléchargement, plus un bouton de régénération dans
l'onglet Sécurité qui prévient que les anciens seront invalidés.

Le bouton Copier dégrade en sélection manuelle hors contexte sécurisé :
navigator.clipboard est absent en HTTP et échouerait sinon en silence.

Affiche aussi le secret TOTP sous le QR, qui valait undefined jusqu'ici.

Vérifié manuellement (aucun harnais de test frontend dans ce dépôt)."
```

### Task 9: Modale de désactivation de la 2FA

`updateA2FStatus` affiche « Pour désactiver l'A2F, contactez le support » alors que la route existe et que `API.disableA2F` est écrite depuis toujours.

**Files:**
- Modify: `AkinatorWeb/frontend/index.html` (nouvelle modale après `backupCodesModal`)
- Modify: `AkinatorWeb/frontend/js/app.js` (`updateA2FStatus`, nouvelle fonction, `attachEventListeners`)

**Interfaces:**
- Consumes: `API.disableA2F(code, password)` (existant), `POST /api/a2f/disable` acceptant TOTP ou code de secours (Task 6)
- Produces: `desactiverA2F()`

- [ ] **Step 1: Ajouter la modale**

Dans `index.html`, après la modale `backupCodesModal` :

```html
    <!-- A2F Disable Modal -->
    <div class="modal" id="a2fDisableModal">
        <div class="modal-backdrop" data-close="a2fDisableModal"></div>
        <div class="modal-content">
            <button class="modal-close" data-close="a2fDisableModal">×</button>
            <h2><i class="fa-solid fa-lock-open icon-title"></i> Désactiver l'A2F</h2>
            <p class="modal-subtitle">
                Votre compte ne sera plus protégé par un second facteur.
            </p>
            <div class="form-group">
                <label for="a2fDisablePassword">Mot de passe</label>
                <div class="password-wrapper">
                    <input type="password" id="a2fDisablePassword" placeholder="••••••••" autocomplete="current-password">
                    <button type="button" class="password-toggle" data-target="a2fDisablePassword">
                        <i class="fa-solid fa-eye icon-sm"></i>
                    </button>
                </div>
            </div>
            <div class="form-group">
                <label for="a2fDisableCode">Code A2F</label>
                <input type="text" id="a2fDisableCode" maxlength="10" pattern="[0-9]{6}|[0-9a-fA-F]{10}"
                       placeholder="000000" class="a2f-code-input" autocomplete="off">
                <small class="form-hint">6 chiffres, ou un code de secours de 10 caractères.</small>
            </div>
            <div class="form-error" id="a2fDisableError"></div>
            <button class="btn btn-danger btn-full" id="confirmDisableA2F">
                Désactiver l'A2F
            </button>
        </div>
    </div>
```

- [ ] **Step 2: Ouvrir la modale au lieu du toast**

Dans `app.js`, fonction `updateA2FStatus`, remplacer :

```javascript
        toggleBtn.onclick = function() {
            showToast('Pour désactiver l\'A2F, contactez le support.', 'info');
        };
```

par :

```javascript
        toggleBtn.onclick = function() {
            document.getElementById('a2fDisablePassword').value = '';
            document.getElementById('a2fDisableCode').value = '';
            document.getElementById('a2fDisableError').style.display = 'none';
            showModal('a2fDisableModal');
        };
```

- [ ] **Step 3: Écrire la fonction de désactivation**

Dans `app.js`, juste après `regenererCodesSecours` :

```javascript
async function desactiverA2F() {
    var password = document.getElementById('a2fDisablePassword').value;
    var code = document.getElementById('a2fDisableCode').value.trim();
    var errorDiv = document.getElementById('a2fDisableError');

    errorDiv.textContent = '';
    errorDiv.style.display = 'none';

    if (!password) {
        errorDiv.textContent = 'Mot de passe requis';
        errorDiv.style.display = 'block';
        return;
    }

    // 6 chiffres = TOTP, 10 caractères hexadécimaux = code de secours
    if (!/^[0-9]{6}$/.test(code) && !/^[0-9a-fA-F]{10}$/.test(code)) {
        errorDiv.textContent = 'Entrez un code à 6 chiffres ou un code de secours à 10 caractères';
        errorDiv.style.display = 'block';
        return;
    }

    try {
        showLoading('Désactivation...');
        var response = await API.disableA2F(code, password);
        hideLoading();

        if (response.success) {
            currentUser.a2fEnabled = false;
            closeModal('a2fDisableModal');
            updateA2FStatus();
            showToast('A2F désactivé', 'success');
        }
    } catch (error) {
        hideLoading();
        errorDiv.textContent = error.message || 'Erreur lors de la désactivation';
        errorDiv.style.display = 'block';
    }
}
```

- [ ] **Step 4: Câbler le bouton**

Dans `attachEventListeners`, après les listeners des codes de secours :

```javascript
    document.getElementById('confirmDisableA2F').addEventListener('click', desactiverA2F);
```

- [ ] **Step 5: Vérification manuelle**

```bash
cd AkinatorWeb/backend
JWT_SECRET=$(openssl rand -hex 64) /usr/bin/node server.js &
sleep 3
```

Sur http://localhost:3000, avec un compte dont la 2FA est active :

1. Profil → Sécurité → « Désactiver l'A2F » → la modale s'ouvre (plus de toast « contactez le support »).
2. Mot de passe correct + code TOTP → succès, le badge repasse à « Désactivé ».
3. Réactiver, puis recommencer avec un **code de secours** → succès également.
4. Mot de passe erroné → message d'erreur dans la modale, 2FA toujours active.
5. Champ mot de passe vide → message de validation, aucune requête envoyée.

Arrêter le serveur : `kill %1`.

- [ ] **Step 6: Lancer la suite complète**

```bash
cd AkinatorWeb/backend && /usr/bin/node --test tests/
```

Attendu : `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add AkinatorWeb/frontend/index.html AkinatorWeb/frontend/js/app.js
git commit -m "feat(2fa): modale de désactivation de l'A2F

POST /api/a2f/disable et API.disableA2F existaient depuis toujours ; le front
affichait « Pour désactiver l'A2F, contactez le support ».

La modale accepte un code TOTP ou un code de secours, en cohérence avec le
backend, pour que la perte du téléphone ne soit pas une impasse.

Vérifié manuellement (aucun harnais de test frontend dans ce dépôt)."
```

---

## Auto-revue du plan

**Couverture de la spec :**

| Exigence de la spec | Tâche |
|---------------------|-------|
| `verify-setup` atomique + renvoi des codes | 5 |
| `/setup` renvoie `secret` | 4 |
| `/disable` accepte un code de secours | 6 |
| `/disable` sans mot de passe → 400 | 6 |
| Audit `a2f.disabled` avec la méthode | 6 |
| Champ de login 6 ou 10 caractères | 7 |
| Modale codes de secours (copier / télécharger) | 8 |
| Bouton de régénération avec avertissement | 8 |
| Modale de désactivation | 9 |
| `api.js` : `generateBackupCodes` | 8 |
| Affichage du secret sous le QR | 8 (step 9) |
| `api.js` : `unlockUser` | 2 |
| Boutons Rétrograder / Déverrouiller | 3 |
| Badge de verrouillage | 3 |
| Lecture UTC de `locked_until` côté front | 2, 3 |
| Suppression `init-db` (package.json + README) | 1 |
| Vérification manuelle du front annoncée explicitement | 3, 7, 8, 9 |

Aucune exigence sans tâche.

**Cohérence des interfaces :** `afficherCodesSecours` est définie en Task 8 step 6 et appelée en Task 8 step 5 et Task 8 step 6 (`regenererCodesSecours`) uniquement. `estVerrouille` et `parseSqliteDateUTC` sont définies en Task 2 et consommées en Task 3. `API.unlockUser` est définie en Task 2, consommée en Task 3. `API.generateBackupCodes` est définie en Task 8 step 1, consommée en Task 8 step 6. `consumeBackupCode` et `generateBackupCodes` proviennent de `services/twoFactor` et existent déjà.

**Erreur corrigée en auto-revue :** le test « un code de secours déjà consommé est refusé » de la Task 6 était faux dans sa première rédaction. Après une désactivation réussie, `a2f_enabled` vaut 0 : le second facteur n'est plus exigé, un nouvel appel à `/disable` renvoie 200 sans rien vérifier, et l'assertion aurait échoué en accusant à tort l'implémentation. Le test réactive donc explicitement la 2FA avant de rejouer l'ancien code.

**Point de vigilance pour l'exécutant :** la Task 7 (saisie du code de secours au login) est vérifiable manuellement de bout en bout **seulement après** la Task 8, qui affiche les codes. Avant cela, récupérer un code via `POST /api/a2f/backup-codes` ou directement en base. L'ordre des tâches reste correct — Task 7 est indépendante à l'implémentation — mais la vérification manuelle complète se fait après la Task 8.
