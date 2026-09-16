# Prototype partagé local

Démarrer depuis ce dossier : `python3 server.py`.

- Console : http://127.0.0.1:8765/
- Acheteur : http://127.0.0.1:8765/acheteur

Le serveur doit rester ouvert. SQLite conserve la session dans `data/auction.sqlite3`.
L'ancienne session du navigateur n'est pas importée : la vente part avec les mêmes lots et sans prix ni ordres fictifs. L'ancien mode fichier reste disponible, indépendant de la base.

La page acheteur confirme un prénom, un lot et un plafond entier en euros, hors frais. Une clé unique empêche qu'une nouvelle tentative du même envoi crée un doublon. La console consulte les données toutes les deux secondes. Les réponses de la console ne contiennent pas les plafonds.

Le pas de défense est automatique par défaut (10 € sous 200 €, 20 € sous 300 €, 50 € sous 1 000 €, 100 € sous 2 000 €, puis 200 €) et peut être saisi manuellement. Ce barème est provisoire. La proposition est limitée au plafond : 1 950 € avec un pas de 100 € et un plafond de 2 000 € propose 2 000 €. Seuls une référence anonyme et le montant à défendre apparaissent. Le prénom, le plafond et l’indicateur de plafond atteint ne sont pas transmis dans les propositions. Avec un prix de 80 € et un ordre à 100 €, le serveur propose 90 €. La secrétaire valide après annonce. L'ordre ne peut pas surenchérir contre lui-même. Une nouvelle hausse salle/live rend une nouvelle proposition possible. Plusieurs ordres éligibles bloquent la proposition tant que leur règle d'arbitrage n'est pas définie. Ceci n'est pas encore un moteur complet de vente.

Par défaut le serveur écoute sur le Mac. Le mode `--lan` active le réseau local. La console et ses API nécessitent le code secrétaire affiché au démarrage (session de 12 heures, code renouvelé au redémarrage). La page acheteur reste accessible sans compte. HTTP est non chiffré : essais fictifs sur un Wi-Fi de confiance uniquement, pas de publication Internet. Ce code n’est pas une authentification métier complète. Le prénom n'identifie pas légalement un acheteur. Le journal local est modifiable par le propriétaire du Mac ; ce n'est pas une preuve infalsifiable. Pas de connexion Interencheres. Les photos, authentification, annulation d'ordres et accès multi-appareils restent à réaliser.

Tests : `python3 -B test_shared.py` (base temporaire indépendante des essais).


## Essai sur deux tablettes — V0.2

Connecter les deux tablettes au même Wi-Fi que le Mac. Garder le Mac éveillé et le serveur actif.
Adresse de cet essai : `192.168.1.90` (peut changer selon le réseau).

Démarrage réseau pour cette adresse : `AUCTION_LAN_IP=192.168.1.90 python3 server.py --lan`.

- Tablette accueil : http://192.168.1.90:8765/acheteur
- Tablette secrétaire : http://192.168.1.90:8765/ (code affiché dans le terminal)

La confirmation acheteur s'efface après 20 secondes ou via « Terminer · Acheteur suivant ». Aucune enchère ne part vers Interencheres. Prix et hausses saisis par la secrétaire ; enchères des ordres confirmées après annonce.
Si le serveur redémarre, le nouveau code est nécessaire, mais les données SQLite restent conservées.
Les règles de concurrence entre plusieurs ordres doivent encore être validées ; la proposition est suspendue lorsque plusieurs ordres sont éligibles.


## Partage temporaire avec un ami

Une démonstration séparée utilise `data/demo-ami.sqlite3`, avec uniquement les lots fictifs au départ. La base de travail `data/auction.sqlite3` reste indépendante.
Le serveur de démonstration utilise le port 8766, avec `AUCTION_DB`, `AUCTION_PORT` et `AUCTION_PUBLIC_ORIGIN`. Un tunnel Cloudflare fournit une adresse HTTPS temporaire et remplace l’en-tête Host par `127.0.0.1:8766`. Les formulaires n’acceptent que l’origine publique configurée. Le cookie secrétaire utilise Secure sur cette origine.
Le code secrétaire change au redémarrage et s’affiche dans le terminal. Ne pas diffuser ce code avec le lien acheteur destiné à tous.
Le Mac doit rester éveillé, connecté à Internet, avec le serveur et le tunnel actifs. Le lien n’est pas un hébergement permanent et change si le tunnel redémarre. Aucune garantie de disponibilité. Utiliser uniquement des données fictives.
Les appels réseau sont limités à 12 secondes pour afficher une erreur au lieu d’attendre indéfiniment.
