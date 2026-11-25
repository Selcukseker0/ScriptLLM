import type { Source } from '../../shared/schema.js';
import { normalizeForMatch } from '../llm/json.js';

interface KeywordGroup {
  label: string;
  terms: string[];
  required?: boolean;
}

const STOPWORDS = new Set([
  'turkiye', 'turk', 'tarihi', 'tarihinde', 'hakkinda', 'icin', 'nedir', 'nasil', 'mi', 'mı', 'mu', 'mü',
  've', 'ile', 'bir', 'bu', 'olan', 'olarak', 'the', 'about', 'history', 'information',
]);

const DOMAIN_GROUPS: Array<{ triggers: string[]; label: string; terms: string[] }> = [
  {
    triggers: ['deprem', 'sismik', 'earthquake'],
    label: 'deprem/yer sarsıntısı',
    terms: ['deprem', 'sismik', 'sismoloji', 'fay', 'artci', 'artçı', 'afad', 'kandilli', 'earthquake', 'seismic'],
  },
  {
    triggers: ['guven', 'guvenlik', 'safety', 'safe'],
    label: 'güvenlik/hazırlık',
    terms: ['guven', 'guvenlik', 'guvenli', 'guvenligi', 'hazir', 'hazirlik', 'risk', 'dayanik', 'bina', 'yapi', 'yonetmelik', 'denetim', 'safety', 'preparedness', 'resilience'],
  },
  {
    triggers: ['afet', 'disaster'],
    label: 'afet yönetimi',
    terms: ['afet', 'acil', 'kurtarma', 'tahliye', 'disaster', 'emergency', 'response'],
  },
];

function hasStem(word: string, stem: string): boolean {
  return word === stem || (stem.length >= 4 && word.startsWith(stem));
}

function keywordGroups(topic: string): KeywordGroup[] {
  const words = normalizeForMatch(topic).split(/\s+/).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  const groups: KeywordGroup[] = [];
  const consumed = new Set<string>();
  let hasRequiredDomain = false;
  for (const domain of DOMAIN_GROUPS) {
    const triggerMatched = words.some((word) => domain.triggers.some((trigger) => hasStem(word, trigger)));
    if (!triggerMatched) continue;
    groups.push({ label: domain.label, terms: domain.terms.map(normalizeForMatch), required: !hasRequiredDomain });
    hasRequiredDomain = true;
    for (const word of words) {
      if (domain.triggers.some((trigger) => hasStem(word, trigger)) || domain.label.startsWith('güvenlik') && hasStem(word, 'guven')) consumed.add(word);
    }
  }
  for (const word of words) {
    if (consumed.has(word)) continue;
    if (groups.some((g) => g.terms.some((term) => hasStem(word, term) || hasStem(term, word)))) continue;
    groups.push({ label: word, terms: [word] });
  }
  return groups;
}

export interface RelevanceResult {
  relevant: boolean;
  matched: string[];
  reason: string;
}

/** Başlık ve indirilen içerikte konu kavramlarını arar; yalnızca ülke adının geçmesi alaka sayılmaz. */
export function assessSourceRelevance(topic: string, source: Pick<Source, 'title' | 'contentText'>): RelevanceResult {
  const groups = keywordGroups(topic);
  if (groups.length === 0) return { relevant: false, matched: [], reason: 'Konudan anlamlı anahtar kavram çıkarılamadı.' };

  const titleWords = normalizeForMatch(source.title).split(/\s+/).filter(Boolean);
  const bodyWords = normalizeForMatch(source.contentText).split(/\s+/).filter(Boolean);
  const matched: string[] = [];
  const titleMatched: string[] = [];
  const bodyHitsByGroup = new Map<string, number>();
  for (const group of groups) {
    const matchesWord = (word: string) => group.terms.some((term) => hasStem(word, term) || hasStem(term, word));
    const titleHit = titleWords.some(matchesWord);
    const bodyHits = bodyWords.filter(matchesWord).length;
    if (titleHit || bodyHits > 0) matched.push(group.label);
    if (titleHit) titleMatched.push(group.label);
    bodyHitsByGroup.set(group.label, bodyHits);
  }

  const requiredGroups = groups.filter((group) => group.required);
  const requiredMatched = requiredGroups.filter((group) => matched.includes(group.label));
  const requiredTitleMatched = requiredGroups.some((group) => titleMatched.includes(group.label));
  const requiredRepeatedInBody = requiredGroups.some((group) => (bodyHitsByGroup.get(group.label) ?? 0) >= 3);
  const hasRequiredMatch = requiredGroups.length === 0 || requiredMatched.length > 0;
  // Domain-specific query: repeated generic safety terms cannot substitute for the actual topic
  // (e.g. union-history pages that happen to mention safety/management).
  const relevant = hasRequiredMatch && (
    requiredTitleMatched ||
    matched.length >= Math.min(2, groups.length) ||
    requiredRepeatedInBody
  );
  return {
    relevant,
    matched,
    reason: relevant
      ? `Konu eşleşmesi: ${matched.join(', ') || titleMatched.join(', ')}`
      : `Başlık ve metinde konu kavramı yeterince bulunmadı (aranan: ${groups.map((g) => g.label).join(', ')}).`,
  };
}
