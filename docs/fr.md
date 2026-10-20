# Projecteurs JVC pour Gladys

Pilotez vos vidéoprojecteurs **JVC D-ILA** (séries DLA-NZ, NX, N, X, RS et
Z, modèles depuis 2012) depuis Gladys, en local, sans aucun cloud :
allumage, veille, entrée, mode d'image, touches de télécommande, signal et
heures de lampe / laser.

> **Important.** Cette intégration n'a jamais été testée avec un vrai
> projecteur : elle a été écrite d'après la bibliothèque `pyjvcprojector`
> (celle de Home Assistant) et testée avec un faux projecteur seulement. Vos
> retours sont les bienvenus. Intégration non officielle, sans lien avec
> JVCKENWOOD.

## Installation

1. Branchez le projecteur sur votre réseau (prise LAN) et donnez-lui une
   **adresse IP fixe** dans votre box (bail DHCP réservé), ou réglez-en une
   dans son menu Réseau.
2. Pour le piloter **en veille**, gardez son réseau actif en veille : réglez
   le **mode ECO** sur Arrêt (sinon il quitte le réseau en veille, et seule
   la télécommande peut l'allumer).
3. Les modèles récents (depuis 2024, et certains après une mise à jour)
   exigent un **mot de passe réseau** réglé dans le menu Réseau du
   projecteur : saisissez-le dans la configuration. Les modèles plus anciens
   n'en ont pas : laissez le champ vide.
4. Dans Gladys, installez l'intégration **JVC Projector**, ouvrez sa
   configuration et saisissez les adresses IP, séparées par des virgules
   (par exemple `192.168.1.50` ; port 20554 par défaut, un autre sous la
   forme `192.168.1.50:20555`).
5. Les projecteurs apparaissent dans l'onglet **Découverte** : créez-les.

La première fois, le projecteur doit être allumé, ou en veille avec son
réseau actif : l'intégration lit son modèle et son adresse MAC, qui
l'identifie ensuite (son adresse peut changer : saisissez la nouvelle).

## Ce que vous obtenez

| Fonction             | Type Gladys                  | Remarque                                                                    |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| Marche               | état binaire (lecture seule) | 1 allumé ou en préchauffage, 0 veille, refroidissement, erreur, injoignable |
| État de marche       | texte (lecture seule)        | en anglais : On, Warming up, Cooling down, Standby, Error, Not reachable    |
| Allumer              | bouton                       | envoyé seulement en veille                                                  |
| Veille               | bouton                       | envoyé allumé ; en préchauffage, envoyé dès que le projecteur est allumé    |
| Entrée               | liste                        | HDMI 1, HDMI 2                                                              |
| Mode d'image         | liste                        | les modes de votre modèle (Film, Cinema, Natural, HDR10, User 1…)           |
| Touche               | liste                        | Menu, flèches, OK, Retour, Info, réglage de l'objectif, Mode 1 à 10…        |
| Signal               | état binaire (lecture seule) | 1 quand l'entrée reçoit un signal                                           |
| Heures lampe / laser | durée en heures              | lues quand le projecteur est allumé                                         |

Volontairement, aucun **interrupteur** : un « éteins tout » ou « allume
tout » d'un assistant vocal ou d'une scène n'allume ni n'éteint jamais votre
projecteur. Utilisez les deux boutons dans vos scènes.

L'entrée, le mode d'image et le signal sont lus quand le projecteur est
allumé (le mode d'image seulement avec un signal, comme Home Assistant). La
liste des modes d'image suit le modèle que donne le projecteur ; un modèle
inconnu de l'intégration n'en propose aucun.

## Commandes

L'adresse MAC et l'état de marche sont relus sur le projecteur juste avant
chaque commande (un autre projecteur à l'adresse : rien n'est envoyé, et
l'adresse est oubliée) :

- **Allumer** n'est envoyé qu'en veille. Déjà allumé ou en préchauffage :
  rien à faire. En **refroidissement**, le projecteur le refuse : la commande
  est refusée, rien n'est envoyé ; réessayez une fois en veille.
- **Veille** n'est envoyé que projecteur allumé. Déjà en veille ou en
  refroidissement : rien à faire. En **préchauffage**, le projecteur
  l'ignore : Gladys reçoit la réponse « warming up: standby will be sent
  once it is on, nothing sent yet » (la veille sera envoyée dès qu'il est
  allumé, rien n'est encore envoyé), et l'intégration l'envoie dès qu'il est
  allumé (vérifié toutes les 5 secondes, dans les 3 minutes, même après une
  lecture ratée) ; un appui sur Allumer entre-temps l'annule. La veille
  n'est jamais refusée faute d'avoir pu lire l'état : elle est alors envoyée
  quand même. Elle passe avant les autres commandes en attente, et n'attend
  jamais derrière une lecture de fond ni derrière la confirmation lente d'un
  changement d'entrée ou de mode d'image (cette connexion est fermée ; le
  changement reste « envoyée, sans confirmation »).
- **Entrée**, **mode d'image** et **touche** ne sont envoyés que projecteur
  allumé.

Chaque commande reçoit une réponse en moins de 4 secondes (Gladys attend 5
secondes). Une commande partie sans confirmation du projecteur à temps est
signalée « envoyée, sans confirmation » (un changement d'entrée peut prendre
jusqu'à 10 secondes sur le projecteur) ; une commande qui n'a pas pu partir
est signalée « rien envoyé ». L'état est relu 3 secondes après chaque
commande.

## Mot de passe réseau

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, et
envoyé seulement aux projecteurs, au début de chaque connexion (complété
comme l'attendent les anciens modèles, puis sous la forme SHA-256 des
modèles récents si la première est refusée, comme le fait
`pyjvcprojector`). L'intégration ne l'écrit jamais dans son dossier de
données, ni dans ses journaux, statuts ou messages d'erreur.

Un **mot de passe refusé** arrête les essais vers ce projecteur : le statut
de l'intégration l'indique, et le mot de passe n'est réessayé qu'à
l'enregistrement de la configuration, ou 30 minutes plus tard (jamais en
boucle). Un projecteur qui ferme la connexion ou se tait après avoir refusé
un mot de passe compte aussi comme un refus. Corrigez-le dans le menu Réseau
du projecteur ou dans la
configuration, puis enregistrez.

## Bouton de la configuration

- **Vérifier les projecteurs** : lit chaque projecteur tout de suite (marche,
  heures de lampe) et rappelle l'intervalle de rafraîchissement.

## Rafraîchissement, statut et limites

- L'état de chaque projecteur est lu toutes les 15 secondes par défaut (10 à
  300), en une courte connexion (le projecteur n'accepte qu'un client à la
  fois : fermez l'application JVC ou un autre pilote s'il se dit « occupé »).
- Un projecteur qui ne répond pas affiche la marche à 0 et « Not
  reachable », et est cité dans le statut de l'intégration ; il est redemandé
  à chaque rafraîchissement, jamais plus vite.
- Si un autre projecteur répond à l'adresse d'un projecteur créé (adresse
  changée), son adresse est oubliée et il n'est jamais commandé là :
  saisissez sa nouvelle adresse.

## Données et confidentialité

L'intégration garde dans `/data/jvc-projector.json` les projecteurs connus
(adresse MAC, adresse, port, modèle, modes d'image) et les adresses dont le
mot de passe a été refusé, avec l'heure du prochain essai. Rien ne sort de
votre réseau local.

## Limites connues

- HDMI 1 et HDMI 2 seulement (les entrées que connaît `pyjvcprojector`).
- Pas encore de mémoires d'objectif, de puissance laser, de mode
  d'installation, d'anamorphose ni de réglages HDR.
- Un seul mot de passe pour tous les projecteurs.
- Jamais testé avec un vrai projecteur : les réponses réelles peuvent
  différer.
