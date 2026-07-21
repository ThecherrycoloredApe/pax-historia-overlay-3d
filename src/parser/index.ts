/**
 * Parser d'événements — v1 minimale (étape 5 pour la version complète).
 * Les événements sont générés en ANGLAIS (même avec l'UI française), en
 * markdown où le gras `**…**` marque souvent les éléments notables.
 */

export type StructureType =
  // détectés dans le texte des événements (KEYWORDS)
  | 'nuclear_plant'
  | 'port'
  | 'military_base'
  | 'airport'
  | 'dam'
  | 'factory'
  // bâtiments génériques issus des mapChanges createMapFeature (familles de tags)
  | 'hq'
  | 'infrastructure'
  | 'research'
  | 'hospital'
  | 'depot'
  | 'monument'
  | 'finance'
  | 'policy'
  // unités mobiles du jeu (bataillons, convois…) : icône ⚔️ + campement
  | 'unit'
  // repli : toute feature sans famille reconnue
  | 'generic';

export interface GameEventTag {
  text: string;
  color?: string;
}

export interface GameEvent {
  date: string;
  title: string;
  description: string;
  /** Types connus : transferRegionOwnership, create/dissolve/updatePolity, create/update/removeMapFeature. */
  mapChanges?: Array<{ type?: string; [key: string]: unknown }>;
  tags?: GameEventTag[];
}

export interface DetectedStructure {
  type: StructureType;
  /** Extrait de texte ayant déclenché la détection (diagnostic). */
  matchedText: string;
}

const KEYWORDS: Array<{ type: StructureType; pattern: RegExp }> = [
  { type: 'nuclear_plant', pattern: /nuclear\s+(power\s+)?(plant|reactor|station)|centrale\s+nucléaire/i },
  // ⚠️ « port of » DANS le groupe \b(…)\b, sinon « support of » matche.
  { type: 'port', pattern: /\b(naval\s+(base|hub|port)|seaport|harbou?r|port\s+(militaire|maritime)|port\s+of\s+\w+)\b/i },
  { type: 'military_base', pattern: /military\s+base|army\s+base|base\s+militaire/i },
  { type: 'airport', pattern: /\bairport\b|air\s+base|aéroport|base\s+aérienne/i },
  // ⚠️ jamais « barrage » nu : en anglais c'est un tir de barrage (faux positif
  // vérifié sur partie réelle). On n'accepte que les formes françaises sûres.
  { type: 'dam', pattern: /\bdam\b|barrage\s+hydro\w*|barrage\s+de\s+\p{Lu}/iu },
  { type: 'factory', pattern: /\bfactory\b|manufacturing\s+plant|\busine\b/i },
];

export function detectStructures(event: GameEvent): DetectedStructure[] {
  const text = `${event.title}\n${event.description}`;
  const found: DetectedStructure[] = [];
  for (const { type, pattern } of KEYWORDS) {
    const match = text.match(pattern);
    if (match) found.push({ type, matchedText: match[0] });
  }
  return found;
}

/** L'événement parle-t-il d'une destruction ? (⚠️ « destroyer » le navire ne matche pas) */
export const DESTRUCTION_PATTERN =
  /\b(destroy(ed|s)?|demolish\w*|bomb(ed|ing|ard\w*)|raz(ed|ing)|levell?ed|sabotag\w*|blown\s+up|in\s+ruins|obliterat\w*|détruit\w*|bombard\w*|rasée?s?\b|saboté\w*)\b/i;

/** L'événement parle-t-il d'un achèvement (fin de chantier) ? */
export const COMPLETION_PATTERN =
  /\b(complet(ed|es|ion)|inaugurat\w*|operational|commissioned|finish(ed|es)|comes?\s+online|now\s+open(s|ed)?|entre?\s+en\s+service|achev\w+|inaugur\w+|mise?\s+en\s+service|opérationnel\w*)\b/i;

/** Mots-clés par type pour matcher une feature du jeu (tags + nom, vocabulaire libre). */
export const FEATURE_FAMILY: Record<StructureType, RegExp> = {
  nuclear_plant: /nuclear|reactor/i,
  port: /\bport\b|naval|navy|harbou?r|shipyard/i,
  military_base: /military|garrison|fortress|barracks|\bbase\b|\bfort\b/i,
  airport: /airport|air[- ]?base|hangar|runway|aerial/i,
  dam: /\bdam\b|hydro/i,
  factory: /factory|industr|production|manufact|forge/i,
  hq: /headquarters|\bhq\b|command|administration|governance|assembly|council|justice|diplomat|embassy|secretariat|parliament/i,
  infrastructure: /infrastructure|\bpower\b|power-grid|electricity|energy|grid|relay|station|rail|train|pipeline|geothermal|mining|\bmine\b/i,
  research: /research|university|school|education|science|laborator|innovation|academy|institut|[ée]cole|universit[ée]|lyc[ée]e|\btech\b/i,
  hospital: /hospital|medical|health|clinic|humanitarian|\baid\b/i,
  depot: /depot|logistics|storage|warehouse|granary/i,
  monument: /monument|landmark|religious|temple|church|mosque|cathedral|shrine|memorial|culture|museum/i,
  finance: /\bbank|banque|fonds|\bfunds?\b|treasur|trésor|bourse|financ|monnaie|\bmint\b|currency|économi|economic|fiscal|sovereign\s+wealth/i,
  policy: /réforme|\breforms?\b|\bloi\b|\blaw\b|charte|charter|traité|treaty|\baccord\b|constitution|décret|decree|registr|census|recensement|archive|bureaucra|administrati(f|ve)/i,
  unit: /$^/, // via UNIT_PATTERN, jamais par cette table
  generic: /$^/, // jamais par mots-clés : uniquement en repli de featureTypeFromTags
};

/**
 * Unités mobiles et marqueurs éphémères : jamais des bâtiments. Testé sur le
 * vocabulaire réel (le tag `battalion` domine à 114 occurrences).
 */
export const UNIT_PATTERN =
  /battalion|infantry|raider|militia|army|convoy|vanguard|mobile|expedition|assault|shock|motori[sz]ed|mechani[sz]ed|armou?red|regiment|brigade|squadron|siege|offensive|reconnaissance|scout|peacekeeping|occupation|special-forces|rapid-reaction|\belite\b|unrest|battlefield|prisoners?\b|task\s?force|detachment|platoon|\blegion\b|fleet|patrol|\bguards?\b|\bteam\b|bataillon|escadr(on|ille)|r[ée]giment|milice|convoi|arm[ée]e|escouade|commando|l[ée]gion|flotte|patrouille|éclaireur|\bgarde\b/i;

/**
 * Type pour une feature créée par le jeu, d'après ses tags + son nom.
 * 'unit' pour les unités mobiles, sinon premier match famille gagnant
 * (du plus spécifique au plus générique), 'generic' en repli. Jamais null.
 */
const FEATURE_TYPE_ORDER: StructureType[] = [
  'nuclear_plant',
  'port',
  'airport',
  'dam',
  'factory',
  'hospital',
  'research',
  'depot',
  'monument',
  'finance',
  'policy',
  'military_base',
  'infrastructure',
  'hq',
];

export function featureTypeFromTags(tags: string[], name: string): StructureType {
  const blob = `${tags.join(' ')} ${name}`;
  if (UNIT_PATTERN.test(blob)) return 'unit';
  for (const type of FEATURE_TYPE_ORDER) {
    if (FEATURE_FAMILY[type].test(blob)) return type;
  }
  return 'generic';
}
