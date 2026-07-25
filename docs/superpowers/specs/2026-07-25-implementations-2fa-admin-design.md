# Spec — 2FA complète, actions admin manquantes, nettoyage `init-db`

**Date** : 2026-07-25
**Statut** : validé par le chef de projet
**Périmètre** : `AkinatorWeb/backend` + `AkinatorWeb/frontend` + `README.md`

## Contexte

La revue complète du dépôt (2026-07-25, ayant donné la PR #17) a identifié, en plus
des six failles corrigées, **cinq fonctionnalités présentes côté backend mais sans
façade utilisable**. Elles ne sont pas des bugs isolés : ce sont des chemins de code
morts qui donnent l'illusion d'une fonctionnalité livrée.

| Constat | État réel |
|---------|-----------|
| Codes de secours 2FA | `POST /api/a2f/backup-codes` et `consumeBackupCode` fonctionnent, mais aucune UI ne les génère et le champ de saisie au login est `maxlength="6"` alors qu'un code fait 10 caractères — **insaisissable** |
| Désactivation 2FA | `POST /api/a2f/disable` implémentée, `API.disableA2F` écrite, mais `app.js` affiche « Pour désactiver l'A2F, contactez le support » |
| Rétrogradation admin | `POST /api/admin/users/:id/demote` et `API.demoteUser` existent, **aucun bouton** ne les appelle |
| Déverrouillage de compte | `POST /api/admin/users/:id/unlock` existe, aucune méthode dans `api.js`, aucun bouton — alors que le README annonce « déblocage de comptes » |
| Secret TOTP manuel | `app.js` lit `response.data.secret` que `/a2f/setup` ne renvoie volontairement pas → le bloc « ou entrez ce code manuellement » affiche `undefined` |

S'y ajoute `npm run init-db`, qui pointe sur `services/initDatabase.js` — fichier
inexistant. Le README le recommande.

## Décisions validées

1. **Les codes de secours sont affichés à l'activation**, pas à la demande. Un bouton
   de régénération reste disponible ensuite. Sans cela, la quasi-totalité des
   utilisateurs n'aura jamais de code, et la perte du téléphone devient une perte de
   compte définitive.
2. **`/a2f/disable` accepte un code de secours** en plus du TOTP. Aujourd'hui, un
   utilisateur ayant perdu son téléphone peut se connecter (le login accepte les codes
   de secours) mais ne peut plus jamais désactiver sa 2FA : impasse connue.
3. **Le secret TOTP est renvoyé et affiché.** Le QR code le contient déjà en clair ;
   le masquer n'apporte aucune sécurité et interdit l'appairage manuel (poste sans
   caméra, lecteur d'écran, application n'acceptant que la saisie).
4. **`npm run init-db` est supprimé**, pas réécrit. Le démarrage du serveur crée déjà
   les tables et sème l'arbre de décision : un script séparé serait un doublon à
   maintenir.

## Lot 1 — 2FA complète

### Décision de conception : activation et codes sont atomiques

Le chemin naïf serait d'appeler `POST /a2f/backup-codes` depuis le front après un
`POST /a2f/verify-setup` réussi. Il ouvre une fenêtre où la 2FA est **active sans
qu'aucun code de secours n'existe** : si le second appel échoue (réseau coupé, onglet
fermé), l'utilisateur est protégé sans filet et l'ignore.

`verify-setup` génère donc les codes et les renvoie lui-même, dans la **même
transaction** que l'activation. `POST /a2f/backup-codes` est conservé pour la seule
régénération.

### Backend

- `routes/a2f.js` — `POST /verify-setup` : envelopper l'activation (`a2f_enabled = 1`)
  et `generateBackupCodes(user.id)` dans un `db.transaction`, et renvoyer
  `data: { codes: [...] }`. La 2FA ne peut plus être active sans codes.
- `routes/a2f.js` — `POST /setup` : ajouter `secret: secretObj.base32` à la réponse,
  et corriger le commentaire « Secret non exposé pour sécurité » devenu faux.
- `routes/a2f.js` — `POST /disable` : accepter un code de **10 caractères** traité
  comme code de secours (`consumeBackupCode`), sinon TOTP, en reprenant la logique
  déjà écrite dans `routes/auth.js` (`verify-login-a2f`). Facteur mot de passe
  inchangé et toujours obligatoire.
- `routes/a2f.js` — `POST /disable` : corriger le **500** actuel quand `password` est
  absent (`bcrypt.compare(undefined, hash)` lève). Doit répondre 400.
- Journal d'audit : `a2f.disabled` doit porter la méthode employée
  (`details: { method: 'totp' | 'backup_code' }`), comme le fait déjà
  `auth.2fa.success`.

### Frontend

- `index.html` — champ `a2fLoginCode` : `maxlength` 6 → 10 et `pattern` passant de
  `[0-9]{6}` à `[0-9]{6}|[0-9a-fA-F]{10}` (6 chiffres pour le TOTP, 10 caractères
  hexadécimaux pour un code de secours — format produit par
  `crypto.randomBytes(5).toString('hex')`).
- `app.js` — `verifyA2FLogin` : la validation `code.length !== 6` accepte 6 ou 10.
- `app.js` — `setupA2F` : afficher `response.data.secret` sous le QR (le bloc
  `a2fSecretDisplay` existe déjà dans le HTML).
- Nouvelle modale « Vos codes de secours » : les 8 codes, boutons **Copier** et
  **Télécharger** (`.txt` via `Blob`), avertissement « ils ne seront plus jamais
  affichés ». Ouverte automatiquement après une activation réussie.
  Contrainte : `navigator.clipboard` exige un contexte sécurisé (HTTPS ou
  `localhost`). Le bouton Copier doit donc dégrader proprement — sélection du texte
  et message « copiez manuellement » — plutôt que d'échouer en silence sur un
  déploiement HTTP.
- Onglet Sécurité : bouton **Régénérer mes codes**, avec confirmation explicite que
  les anciens codes seront invalidés — `generateBackupCodes` fait un `DELETE` avant
  l'`INSERT`, la régénération est destructive.
- Onglet Sécurité : `updateA2FStatus` câble le bouton « Désactiver l'A2F » sur une
  modale demandant mot de passe + code (TOTP ou secours), au lieu du toast
  « contactez le support ».
- `api.js` : ajouter `generateBackupCodes()`. `disableA2F(code, password)` existe déjà
  et n'a pas à changer.

### Tests (backend)

- `verify-setup` renvoie 8 codes distincts ET, dans le même appel, laisse la base dans
  un état où `a2f_enabled = 1` **et** 8 lignes `a2f_backup_codes` non consommées
  existent. C'est l'invariant à figer : « 2FA active ⇒ codes disponibles ». On teste
  l'invariant, pas l'injection de panne.
- Un code de secours désactive la 2FA ; le même code rejoué est refusé.
- Un code TOTP valide désactive toujours la 2FA (non-régression).
- `/disable` sans `password` → 400, jamais 500.
- La régénération invalide les codes précédents.
- `/setup` renvoie un `secret` en base32 cohérent avec l'`otpauth_url` du QR.

## Lot 2 — Actions admin manquantes

### Frontend uniquement

- `api.js` : ajouter `unlockUser(userId)` (`POST /admin/users/:id/unlock`).
- `app.js` — `displayUsers` : bouton **Rétrograder** sur les comptes admin (sauf
  soi-même, le backend refuse déjà l'auto-rétrogradation), câblé sur `API.demoteUser`.
- `app.js` — `displayUsers` : bouton **Déverrouiller**, affiché **uniquement** si le
  compte est verrouillé, câblé sur `API.unlockUser`.
- `app.js` — colonne Admin : badge « Verrouillé jusqu'à HH:MM » quand applicable.

Ces deux affichages sont possibles depuis la PR #17 : `locked_until` et
`failed_login_attempts` font partie de la liste blanche `projectUser`.

### Piège à ne pas répéter

`locked_until` arrive du serveur au format SQLite (`"YYYY-MM-DD HH:MM:SS"`, **UTC sans
fuseau**). Un `new Date(valeur)` côté navigateur l'interprète en heure locale et
réintroduit exactement le bug corrigé par la PR #17 — ici sous forme d'un affichage
faux de deux heures, et d'un badge « verrouillé » qui disparaît trop tôt.

Le front doit donc normaliser en UTC avant tout affichage ou comparaison, comme le
fait `services/sqliteDate.js` côté serveur.

## Lot 3 — Nettoyage `init-db`

- `package.json` : supprimer la ligne `"init-db": "node services/initDatabase.js"`.
- `README.md` : retirer la mention du script dans la section Installation.

## Ordre et livraison

Trois PR, dans cet ordre — le lot le plus risqué en dernier, quand les autres sont
mergés et ne polluent plus le diff :

1. **PR n°1 : lot 3** (2 minutes, aucun risque).
2. **PR n°2 : lot 2** (front seul, backend et API inchangés).
3. **PR n°3 : lot 1** (touche au parcours d'authentification).

Chaque PR : branche dédiée, `npm test` vert dans `AkinatorWeb/backend`, CI existante
(`security.yml`, CodeQL) verte.

## Vérification du front

Le dépôt n'a **aucun harnais de test frontend** — constat de la revue de la PR #17.
Créer ce harnais est hors périmètre. Chaque point front de cette spec sera donc
vérifié **manuellement dans l'application lancée**, et le rapport de fin de lot dira
explicitement ce qui a été vérifié à la main plutôt que de le laisser sous-entendre.

## Hors périmètre

- Harnais de test frontend.
- Les quatre scripts de `backend/scripts/` qui refont le `new Date(locked_until)` naïf,
  et `simulate-login.js` qui reproduit l'ancien ordre du login (dette tracée en PR #17).
- Le type de transaction `gift` émis à l'inscription alors que `/gift` produit du
  `daily` (dette tracée en PR #17).
- La suppression de `POST /api/tokens/gift`, qui n'a plus aucun appelant applicatif :
  décision produit, la spec du 2026-07-23 demande explicitement de le conserver.
- Toute refonte de l'arbre de décision ou de l'intégration IGDB.
