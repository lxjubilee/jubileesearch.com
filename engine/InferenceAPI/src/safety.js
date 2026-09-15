// Family-safety verdicts (spec §11.1 gate 3).
//
// Two models, one judgement. A toxicity classifier (toxic-bert) answers "is
// this text hostile": threats, hate, insults, obscenity. It does not know what
// a casino or an escort ad is, so a zero-shot NLI classifier answers "what is
// this text about" over a fixed label set that names both the unsafe classes
// the spec cares about and the wholesome ones the corpus is made of.
//
// The output is the structured JSON the spec shows, never prose: the engine
// reads `safe_for_family` and `confidence` and applies its own thresholds
// (>= 0.90 index, 0.70-0.89 human review, < 0.70 reject), so the confidence
// here has to mean "how sure the models are that nothing unsafe is present".
//
// This module is pure so it can be tested without a model in memory.

export const UNSAFE_LABELS = [
  'adult or sexual content',
  'violence or threats',
  'hate speech',
  'gambling',
  'illegal drugs',
  'profanity or crude language',
  // Added 2026-09-15 after the acceptance-20 run: a ghost-gun kit listing
  // read as "news" at 0.67 because no label named what it was. §11.1's gate-2
  // categories are adult, gambling, drugs, weapons sales, hate speech and
  // self-harm; the label set now covers all six.
  'weapons sales or explosives',
  'self-harm or suicide encouragement',
  // And two more from the same run: a bank-credential phishing page and a
  // child-marriage listing both read as "christian teaching" because nothing
  // in the set named fraud or the exploitation of children.
  'scams, phishing or fraud',
  'child exploitation or abuse',
];
export const SAFE_LABELS = [
  'christian teaching or devotional',
  'bible study or scripture',
  'family life or parenting',
  'news or current events',
  'education or reference',
  'general family-friendly content',
];
export const ZERO_SHOT_LABELS = [...UNSAFE_LABELS, ...SAFE_LABELS];

// Toxic-bert's heads, and the flag each becomes. `toxic` alone is broad and
// fires on strong language a sermon can carry, so it is a flag only above a
// higher bar; the specific heads fire at 0.5.
const TOXIC_FLAGS = {
  toxic: { flag: 'toxic', threshold: 0.8 },
  severe_toxic: { flag: 'severe-toxicity', threshold: 0.5 },
  obscene: { flag: 'obscene', threshold: 0.5 },
  threat: { flag: 'threat', threshold: 0.5 },
  insult: { flag: 'insult', threshold: 0.5 },
  identity_hate: { flag: 'hate', threshold: 0.5 },
};

const slug = (label) => label.split(' or ')[0].replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

/**
 * @param {{label: string, score: number}[]} toxic     toxic-bert heads, any order
 * @param {{labels: string[], scores: number[]}} topics zero-shot output, softmax
 *        over ZERO_SHOT_LABELS (multi_label: false), best first
 * @param {{unsafeTopicThreshold?: number}} [opts]
 */
export function verdict(toxic, topics, opts = {}) {
  const unsafeTopicThreshold = opts.unsafeTopicThreshold ?? 0.5;

  const flags = [];
  let maxToxic = 0;
  for (const { label, score } of toxic ?? []) {
    const rule = TOXIC_FLAGS[label];
    if (!rule) continue;
    if (score >= rule.threshold) flags.push(rule.flag);
    // `toxic` is the umbrella head; the specific heads are the evidence.
    if (label !== 'toxic') maxToxic = Math.max(maxToxic, score);
    else maxToxic = Math.max(maxToxic, Math.max(0, score - 0.3));
  }

  const scored = (topics?.labels ?? []).map((label, i) => ({ label, score: Number(topics.scores[i] ?? 0) }));
  const primary = scored[0] ?? null;
  const unsafeMass = scored.filter((t) => UNSAFE_LABELS.includes(t.label)).reduce((n, t) => n + t.score, 0);
  // An unsafe primary topic flags the page. So does unsafe mass spread across
  // several unsafe labels: a casino ad that reads as 0.3 gambling, 0.25
  // profanity and 0.2 adult is not safe because no single label won.
  const unsafeTopic = primary && UNSAFE_LABELS.includes(primary.label)
    && (primary.score >= unsafeTopicThreshold || unsafeMass >= 0.6)
    ? primary : null;

  const categories = scored.filter((t) => t.score >= 0.15).slice(0, 3).map((t) => slug(t.label));
  if (unsafeTopic) flags.push(slug(unsafeTopic.label));

  const unsafe = flags.length > 0;
  // Confidence is always "confidence in the verdict given". Safe: how little
  // unsafe evidence there was. Unsafe: how strong the strongest evidence was.
  const confidence = unsafe
    ? Math.min(1, Math.max(maxToxic, unsafeTopic?.score ?? 0))
    : Math.max(0, 1 - Math.max(maxToxic, unsafeMass));

  const reason = unsafe
    ? `Flagged: ${[...new Set(flags)].join(', ')}.`
      + (primary ? ` Classified as ${primary.label} (${primary.score.toFixed(2)}).` : '')
    : (primary
      ? `Classified as ${primary.label} (${primary.score.toFixed(2)}). No adult, violent, hateful or exploitative content detected.`
      : 'No adult, violent, hateful or exploitative content detected.');

  return {
    safe_for_family: !unsafe,
    confidence: Number(confidence.toFixed(3)),
    categories,
    flags: [...new Set(flags)],
    reason,
  };
}
