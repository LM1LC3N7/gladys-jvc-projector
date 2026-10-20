// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration button, connection status),
// in English and French. None of them ever holds the password.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');

const POWER_FR = {
  on: 'allumé',
  warming: 'en préchauffage',
  cooling: 'en refroidissement',
  standby: 'en veille',
  error: 'en erreur',
};
const POWER_EN = {
  on: 'on',
  warming: 'warming up',
  cooling: 'cooling down',
  standby: 'standby',
  error: 'in error',
};

export const T = {
  noProjector: both(
    'No projector known yet: type their IP addresses in the configuration (the projector must be on, or in standby with its network kept on).',
    'Aucun projecteur connu : saisissez leurs adresses IP dans la configuration (le projecteur doit être allumé, ou en veille avec son réseau actif).',
  ),
  check: (lines, interval) => ({
    en: [...lines.map((l) => l.en), `Refresh every ${interval} s`].join(' · '),
    fr: [...lines.map((l) => l.fr), `Rafraîchissement toutes les ${interval} s`].join(' · '),
  }),
  checkLine: (label, outcome) => {
    if (outcome.error === 'auth') {
      return both(
        `${label}: password refused by the projector`,
        `${label} : mot de passe refusé par le projecteur`,
      );
    }
    if (outcome.error === 'busy') {
      return both(
        `${label}: busy (another client connected?)`,
        `${label} : occupé (un autre client connecté ?)`,
      );
    }
    if (outcome.error) {
      return both(
        `${label}: not reachable (off, eco standby or wrong address)`,
        `${label} : injoignable (éteint, veille éco ou mauvaise adresse)`,
      );
    }
    const en = [POWER_EN[outcome.power] ?? 'power unknown'];
    const fr = [POWER_FR[outcome.power] ?? 'marche inconnue'];
    if (Number.isSafeInteger(outcome.lightTime)) {
      en.push(`${outcome.lightTime} h of light`);
      fr.push(`${outcome.lightTime} h d'éclairage`);
    }
    return both(`${label}: ${en.join(', ')}`, `${label} : ${fr.join(', ')}`);
  },
  authRefused: (labels) =>
    both(
      `Password refused by: ${list(labels)}. Check the network password set on the projector, then save the configuration (otherwise tried again every 30 minutes).`,
      `Mot de passe refusé par : ${list(labels)}. Vérifiez le mot de passe réseau réglé sur le projecteur, puis enregistrez la configuration (sinon nouvel essai toutes les 30 minutes).`,
    ),
  unreachable: (names) =>
    both(
      `Not reachable (off, eco standby or wrong address), asked again at every refresh: ${list(names)}.`,
      `Injoignables (éteints, veille éco ou mauvaise adresse), redemandés à chaque rafraîchissement : ${list(names)}.`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No JVC projector answers yet at: ${list(addresses)} (tried again every minute).`,
      `Aucun projecteur JVC ne répond encore à : ${list(addresses)} (nouvel essai chaque minute).`,
    ),
  addressUnknown: (names) =>
    both(
      `Address unknown (another projector answers at the old one): ${list(names)}. Type the new address in the configuration.`,
      `Adresse inconnue (un autre projecteur répond à l'ancienne) : ${list(names)}. Saisissez la nouvelle adresse dans la configuration.`,
    ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid): ${list(entries)}.`,
      `Ignorés dans la configuration (invalides) : ${list(entries)}.`,
    ),
  invalidPassword: both(
    'The password of the configuration is not usable (more than 64 characters, or control characters): no password is sent.',
    "Le mot de passe de la configuration n'est pas utilisable (plus de 64 caractères, ou caractères de contrôle) : aucun mot de passe n'est envoyé.",
  ),
  dataReset: both(
    'The saved projector list was unreadable and was reset; the projectors are found again from their addresses.',
    'La liste enregistrée des projecteurs était illisible et a été réinitialisée ; les projecteurs sont retrouvés par leurs adresses.',
  ),
};
