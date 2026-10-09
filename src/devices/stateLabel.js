// -----------------------------------------------------------------------------
// Short label of a robot state code, shared by the scene triggers
// (`state_changed`) and the dashboard widget status block.
//
// The codes are the Roborock firmware ones (see constants.js): the same robot
// reports them whether it is reached through the Xiaomi cloud or the Roborock one.
// -----------------------------------------------------------------------------

// Roborock raw state code -> short French label.
const STATE_LABELS = {
  2: 'À la base',
  3: 'Au repos',
  5: 'Nettoyage',
  6: 'Retour à la base',
  8: 'À la base',
  10: 'En pause',
  11: 'Nettoyage',
  12: 'Erreur',
  15: 'Retour à la base',
  16: 'Déplacement',
  17: 'Nettoyage zone',
  18: 'Nettoyage pièce',
  22: 'Vidage du bac',
  23: 'Lavage serpillière',
  25: 'Lavage serpillière',
  26: 'Retour au lavage',
  29: 'Cartographie',
  100: 'À la base',
};

/**
 * Short French label for a Roborock state code.
 * @param {number} state the raw Roborock state
 * @returns {string} the label
 */
export function roborockStateLabel(state) {
  return STATE_LABELS[Number(state)] || 'Inconnu';
}
