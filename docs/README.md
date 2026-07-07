# Documentation — AkinatorTwitch

Documentation technique du projet, pensée pour comprendre vite le code lors
d'une reprise (nouvelle session, nouveau contributeur).

## Par où commencer

| Document | À lire quand… |
|----------|---------------|
| [`architecture.md`](./architecture.md) | vous voulez la carte du code : modules, pipeline de middleware, schéma SQLite, cycle de vie d'une requête |
| [`authentification.md`](./authentification.md) | vous touchez à l'auth, aux sessions, au 2FA ou aux tokens (partie la plus subtile et la plus sensible) |
| [`securite.md`](./securite.md) | vous voulez la posture de sécurité complète (défense en profondeur), les 10 mesures et leur raison d'être |

## Autres sources dans le dépôt

- [`../README.md`](../README.md) — présentation produit, installation, configuration `.env`, table des routes API.
- [`../SECURITY.md`](../SECURITY.md) — **politique** de sécurité (signalement de vulnérabilité, rotation des secrets, incident connu). À ne pas confondre avec `securite.md` qui décrit la **posture** technique.
- [`superpowers/plans/`](./superpowers/plans/) — plans d'implémentation historiques (générés par `/dev-cycle`), utiles pour retracer *pourquoi* une décision a été prise.

## Convention

Ces documents décrivent le comportement **réel** du code. Quand vous modifiez
un flux décrit ici (auth, pipeline, schéma), mettez le document à jour dans le
même commit. Les références `fichier:ligne` sont des points d'entrée, pas des
ancres figées — vérifiez-les si le code a bougé.
