/**
 * Deterministic D-005 rules: run first, cost nothing, and decide the obvious
 * cases before any classifier call (and at quote time, before credits are held).
 *
 * - Minor-coded terms (multilingual, plus ages under 18) in the same text as
 *   sexual terms → MINOR_SEXUAL. Negated sexual terms ("no nudity") don't count.
 * - Sexual content involving animals → ANIMAL_SEXUAL: strong terms
 *   (bestiality, zoophilia, 兽交 …) and a sexual act directed at an animal
 *   ("sex with a dog", "jerking off at a cat", "对着猫打飞机"). Animals in a
 *   non-sexual scene, or present next to adult content, don't count.
 * - Face/head swap or identity-driven models on a mature run with any uploaded
 *   reference → IDENTITY_SWAP_MATURE; face/head swap never takes a mature run.
 * - `explicitSignal`: strong explicit terms, used to ask for mature content
 *   (MATURE_REQUIRED) on runs that don't have it, instead of routing silently.
 *
 * Real-person and celebrity detection is not done here: names need the LLM.
 * Negative prompts are not scanned (they usually list what to avoid).
 */
import type { PreCheckInput, SafetyModel, SafetyReason } from './types';

/** Scripts written without spaces between words: match as substrings. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Thai}]/u;

/** Term list split into word-bounded (regex fragments) and substring terms. */
interface TermList {
  words: RegExp | null;
  substrings: string[];
}

function terms(list: readonly string[]): TermList {
  const words = list.filter((t) => !NO_SPACE_SCRIPT.test(t));
  const substrings = list.filter((t) => NO_SPACE_SCRIPT.test(t));
  return {
    words: words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null,
    substrings,
  };
}

// Minor-coded terms. Regex fragments; keep them lowercase.
const MINOR_TERMS = terms([
  // English
  'child(?:ren)?', "child's", 'kids?', 'kiddies', 'minors?', 'under-?aged?', 'pre-?teens?', 'tweens?', 'toddlers?', 'infants?',
  'school ?girls?', 'school ?boys?', 'lolis?', 'lolicon', 'lolita', 'shota(?:con)?', 'jailbait', 'teens?', 'teenagers?', 'teenaged',
  'young teens?', 'little (?:girls?|boys?)', 'young (?:girls?|boys?)', 'barely legal', '(?:high|middle|grade|elementary) ?school(?:ers?)?',
  'girl scouts?', 'boy scouts?', 'juveniles?', 'pubescent', 'prepubescent',
  // Spanish / Portuguese / Italian / French / German / others (Latin script)
  'niñ[oa]s?', 'menor(?:es)? de edad', 'menores', 'adolescentes?', 'colegialas?', 'crianças?', 'menin[oa]s?', 'menor de idade',
  'bambin[aoie]', 'minorenni?', 'ragazzin[aoie]', 'enfants?', 'fillettes?', 'mineures?', 'écolières?', 'collégiennes?', 'gamines?',
  'kinder', 'kindern', 'minderjährigen?', 'schulmädchen', 'jugendlichen?', 'dzieci', 'dziecko', 'nieletni[aey]?', 'çocuk\\p{L}*',
  'reşit olmayan', 'trẻ em', 'anak-anak', 'di bawah umur', 'bocah',
  // Cyrillic
  'ребенок', 'ребёнок', 'ребенка', 'ребёнка', 'дети', 'детей', 'детск\\p{L}*', 'школьниц\\p{L}*', 'школьник\\p{L}*', 'несовершеннолетн\\p{L}*',
  'малолетк\\p{L}*', 'малолетн\\p{L}*', 'подрост\\p{L}*',
  // CJK, Hangul, Arabic, Devanagari (substrings)
  '儿童', '兒童', '幼女', '幼童', '萝莉', '蘿莉', '未成年', '小学生', '小學生', '初中生', '中学生', '中學生', '女童', '男童', '小女孩', '小男孩',
  '少女', '子供', '子ども', 'こども', '児童', 'ロリ', 'ショタ', '女子高生', '女子中学生', '女子小学生', '아동', '어린이', '미성년', '초등학생',
  '중학생', '여중생', '여고생', '로리', '소녀', 'طفل', 'أطفال', 'اطفال', 'قاصر', 'بچه', 'बच्चा', 'बच्चे', 'नाबालिग',
]);

// Ages 1–17 ("15 yo", "12-year-old", "aged 14", "14歳", "14岁", "14살", "15 años").
const MINOR_AGE = [
  /(?<![\p{N}.,])(?:[1-9]|1[0-7])\s*(?:-|\s)?(?:yo|y\/o|y\.o\.?|yrs?\.? old|yrs?-old|years?[\s-]old|year[\s-]old|anos|años|ans|jahre|jährige\p{L}*|лет|года|letni\p{L}*)(?![\p{L}])/u,
  /(?<![\p{L}])(?:aged?|age of|edad de|âgée? de)\s*(?:[1-9]|1[0-7])(?![\p{N}])/u,
  /(?<![\p{N}])(?:[1-9]|1[0-7])\s*(?:歳|岁|歲|살)/u,
];

// Sexual terms (any level, including suggestive). Used only together with minor terms.
const SEXUAL_TERMS = terms([
  // English
  'sex', 'sexy', 'sexual(?:ly|ized|ised|ity)?', 'sexuali[sz]ed?', 'nudes?', 'nudity', 'naked', 'porn\\p{L}*', 'erotic\\p{L}*', 'nsfw',
  'topless', 'bottomless', 'lingerie', 'intercourse', 'orgasm\\p{L}*', 'genital\\p{L}*', 'blowjobs?', 'masturbat\\p{L}*', 'fetish\\p{L}*',
  'seductive(?:ly)?', 'seduc\\p{L}*', 'striptease', 'stripping', 'undress\\p{L}*', 'hentai', 'xxx', 'lewd', 'horny', 'aroused', 'arousing',
  'provocative(?:ly)?', 'sensual(?:ly)?', 'boudoir', 'onlyfans', 'thongs?', 'nipples?', 'fuck\\p{L}*', 'cum', 'ecchi', 'smut\\p{L}*',
  // Spanish / Portuguese / Italian / French / German / others
  'sexo', 'sexuales', 'desnud[oa]s?', 'porno\\p{L}*', 'er[oó]tic[oa]s?', 'lencer[ií]a', 'cachond\\p{L}*', 'follar', 'nuas?', 'transar',
  'sexe', 'sexuel\\p{L}*', 'nues?', 'toute nue', 'érotique\\p{L}*', 'déshabill\\p{L}*', 'nackt\\p{L}*', 'erotisch\\p{L}*', 'sexuell\\p{L}*',
  'unbekleidet\\p{L}*', 'nud[aie]', 'sesso', 'sessual\\p{L}*', 'nag[aie]', 'seks\\p{L}*', 'erotycz\\p{L}*', 'çıplak', 'erotik\\p{L}*',
  'telanjang', 'bugil', 'khỏa thân', 'khiêu dâm', 'tình dục',
  // Cyrillic
  'голы[йе]', 'голая', 'голую', 'обнажен\\p{L}*', 'обнажён\\p{L}*', 'секс\\p{L}*', 'порн\\p{L}*', 'эроти\\p{L}*', 'раздет\\p{L}*',
  // CJK, Hangul, Arabic, Devanagari
  '裸体', '裸體', '全裸', '半裸', '裸露', '裸照', '裸の', 'ヌード', 'エロ', 'セックス', '性的', '性行为', '性行為', '色情', '做爱', '做愛',
  '情色', '成人向け', '淫', '卑猥', '脱衣', '性感', '누드', '섹스', '야한', '알몸', '성적', '음란', 'جنس', 'عاري', 'عارية', 'إباحي',
  'नग्न', 'सेक्स', 'अश्लील',
]);

// Strong explicit terms: a prompt with these needs mature content on (MATURE_REQUIRED).
const EXPLICIT_TERMS = terms([
  'porn\\p{L}*', 'nsfw', 'xxx', 'hentai', 'explicit sex\\p{L}*', 'sex scenes?', 'having sex', 'intercourse', 'blowjobs?', 'masturbat\\p{L}*',
  'orgasm\\p{L}*', 'genitals?', 'fully nude', 'fully naked', 'completely naked', 'sexo explícito', 'porno\\p{L}*', 'pornographique',
  'секс', 'порн\\p{L}*', 'セックス', '色情', '做爱', '做愛', '性行为', '性行為', '섹스', 'सेक्स',
]);

// Sexual content involving animals: terms that mean it on their own (en + zh; others go to the classifier).
const ANIMAL_SEXUAL_TERMS = terms([
  'bestiality', 'zoophil\\p{L}*', 'zoosex\\p{L}*', 'zoo ?porn\\p{L}*', 'beastiality', 'animal sex', 'sex with (?:an? )?animals?', 'dog ?knott\\p{L}*',
  '兽交', '獸交', '人兽', '人獸', '兽奸', '獸姦', '獸奸', '兽性恋', '獸性戀', '恋兽', '戀獸', '人畜交',
]);

// Animal words for the "sexual act directed at an animal" patterns.
const ANIMAL_EN =
  '(?:dogs?|pupp(?:y|ies)|cats?(?! ?(?:ears?|girls?|boys?|suits?|wom[ae]n|costumes?|tails?|eyes?))|kittens?|horses?|ponies|pony|mares?|stallions?|pigs?|goats?|sheep|cows?|donkeys?|monkeys?|apes?|animals?|beasts?)(?!\\s+(?:farms?|ranch\\p{L}*|beds?|houses?|parks?|shows?|prints?|costumes?|masks?|ears?|tails?|food|collars?|leash\\p{L}*|style|stables?|pens?|patterns?|onesies?|pajamas?|hair|fur|whistles?|toys?|treats?|bowls?|breeds?|trainers?|walkers?|sitters?|groomers?|owners?|lovers?|rid(?:es|ing)|races?|racing|trailers?|carts?|drawn|sleds?|sledding|whisperers?)(?![\\p{L}]))';
const ANIMAL_ZH = '(?:猫(?![耳娘女])|貓(?![耳娘女])|狗(?!仔)|犬|马(?![上桶路赛克甲尾])|馬(?![上桶路賽克甲尾])|猪|豬|驴|驢|山羊|绵羊|綿羊|母牛|公牛|猴子|动物|動物|畜生|牲口|牲畜)';
const SEX_ACT_EN =
  '(?:sex|fuck\\p{L}*|intercourse|blowjobs?|masturbat\\p{L}*|jerk(?:s|ed|ing)? off|jack(?:s|ed|ing)? off|wank\\p{L}*|hump\\p{L}*|penetrat\\p{L}*|cum(?:s|ming)?|ejaculat\\p{L}*|rub(?:s|bing)? (?:his|her|their) (?:cock|dick|penis|pussy|clit)|grind\\p{L}*(?!\\s+(?:(?:his|her|their|my|your|its|the)\\s+)?(?:teeth|jaws?|gears?|coffee|beans?|pepper|spices?|meat|axes?|knives|knife|blades?|rails?|ledges?)(?![\\p{L}])))';
// "sexual act(s)/intercourse/activity …": "sexual" alone (tension, energy, chemistry) is not an act.
// "sexually" counts only right before the partner ("sexually with a dog"), not across words ("sexually charged photo with a cat").
const SEXUAL_ACT_EN =
  '(?:sexual\\s+(?:acts?|intercourse|activit(?:y|ies)|contact|relations(?:hips?)?|encounters?|congress|favou?rs?|services?|play)(?:\\s+\\p{L}+){0,2}?|sexually)';
const DET_EN = '(?:(?:a|an|the|his|her|their|my|your|some|two|three)\\s+)';
// An animal that is only in the scene ("with a cat watching", "a dog asleep nearby") is not the partner.
const BYSTANDER_EN = '(?!\\s+(?:watching|around|nearby|near ?by|close ?by|in the (?:room|background|corner|frame|distance)|sleeping|asleep|present|looking on|outside|barking))';
// 撸猫 (petting a cat), 撸串 (skewers), 撸铁 (lifting) and 插入字幕 (inserting captions) are not sex acts.
const ZH_MEDIA = '字幕|音乐|音樂|背景|画面|畫面|图片|圖片|照片|片段|镜头|鏡頭|文字|标题|標題|转场|轉場|贴纸|貼紙|链接|鏈接|广告|廣告|芯片|晶片|视频|視頻|动画|動畫|特效|logo|水印|表情|配乐|配樂|旁白|片头|片頭|片尾|一段|一张|一張|一个|一個';
const SEX_ACT_ZH_ALT = `打飞机|打飛機|撸管|擼管|[撸擼](?![猫貓狗毛串铁鐵])|自慰|手淫|做爱|做愛|性交|交配|口交|肛交|乳交|性行为|性行為|射精|插入(?!${ZH_MEDIA})|发泄性欲|發洩性慾`;
// "被狗操/干/插/奸", not 操场 (playground), 体操, 干扰 (disturb), 插嘴, 奸笑.
const ZH_PASSIVE_ACT = `(?<![体體早做广廣出])操(?![场場作心练練控纵縱持办辦劳勞守盘盤刀])|肏|[干幹](?![扰擾掉活嘛啥净淨杯涉预預脆燥吗嗎什])|插(?![嘴话話手队隊曲画畫图圖座头頭花秧班足播件入])|(?<![汉漢])奸(?![笑诈詐臣商细細计計滑猾险險])|姦`;
const SEX_ACT_ZH = `(?:${SEX_ACT_ZH_ALT})`;
const ZH_GAP = '[^，。,.!?！？；;\\n]{0,8}?';
const ZH_GAP_SHORT = '[^，。,.!?！？；;\\n]{0,4}?';
// "fucking a goat", "blows the horse": not after a weapon, a nursing young animal or a machine as the subject
// ("the lance penetrates the beast", "a calf sucks the cow", "a vacuum sucks up dog hair"), and "fucking" right after
// a determiner or "stupid" and right before the animal word is an intensifier ("this fucking cat"; not "her fucking a dog",
// "her fucking dogs" or "the fucking stray dog": a possessive or a word in between keeps it a sex act).
const NON_SEXUAL_SUBJECT_EN =
  '(?:calf|calves|lambs?|foals?|piglets?|kittens?|pupp(?:y|ies)|cubs?|joeys?|vacuums?|hoovers?|machines?|arrows?|spears?|lances?|bullets?|swords?|blades?|harpoons?|bolts?|knife|knives|claws?|fangs?|teeth|horns?|tusks?|winds?|storms?|whistles?|bees?|mosquito(?:e?s)?|leech(?:es)?|ticks?)';
const INTENSIFIER_BEFORE_EN = '(?:this|that|these|those|the|a|an|my|your|our|stupid|damn|goddamn|little|big|same|whole|every)';
const VERB_AT_ANIMAL_EN = `(?<!${NON_SEXUAL_SUBJECT_EN}\\s)(?:(?<!${INTENSIFIER_BEFORE_EN}\\s)fuck(?:s|ed|ing)?|fuck(?:s|ed|ing)?(?!\\s+${ANIMAL_EN}(?![\\p{L}]))|rap(?:e|es|ed|ing)|penetrat\\p{L}*|hump(?:s|ed|ing)?|blow(?:s|ing)?|suck(?:s|ed|ing)?)`;
// "the horse penetrates her", not "the beast penetrates her shield with its claws".
const PENETRATES_EN =
  'penetrat\\p{L}*(?!\\s+(?:(?:her|his|their|its|the|my|your)\\s+)?(?:shields?|armou?r|chest|skin|flesh|heart|side|neck|legs?|arms?|shoulders?|back|hides?|defen[cs]es?|lines?|walls?)(?![\\p{L}]))';
const ANIMAL_SEXUAL_PATTERNS: RegExp[] = [
  // "sex with a dog", "jerking off at/to/toward the cat", "fucking a horse"
  new RegExp(`(?<![\\p{L}])${SEX_ACT_EN}(?:\\s+\\p{L}+){0,2}?(?<!\\s(?:next|close|near|due|thanks|according|up))\\s+(?:with|on|at|to|towards?|into|over)\\s+(?:(?:a|an|the|his|her|their|my|your|some|two|three)\\s+)?(?:\\p{L}+\\s+)?${ANIMAL_EN}(?![\\p{L}])`, 'u'),
  new RegExp(`(?<![\\p{L}])${VERB_AT_ANIMAL_EN}\\s+(?:(?:a|an|the|his|her|their|my|your)\\s+)?(?:(?!like\\s|as\\s)\\p{L}+\\s+)?${ANIMAL_EN}(?![\\p{L}])(?!['’]s\\s+(?:milk|udders?|teats?|armou?r|hides?|skin|shields?|scales?|nose|head|neck|tail|food|bowl|toys?|owners?|hair|fur|bottle))`, 'u'),
  // "sexual act with a dog", "sexual intercourse with the horse", "interacting sexually with a dog"
  new RegExp(`(?<![\\p{L}])${SEXUAL_ACT_EN}(?<!\\s(?:next|close|near|due|thanks|according|up))\\s+(?:with|on|to|towards?|involving)\\s+${DET_EN}?(?:\\p{L}+\\s+)?${ANIMAL_EN}(?![\\p{L}])${BYSTANDER_EN}`, 'u'),
  // "sexual intercourse between a woman and a horse"
  new RegExp(`(?<![\\p{L}])${SEXUAL_ACT_EN}\\s+between\\s+${DET_EN}?\\p{L}+(?:\\s+\\p{L}+)?\\s+and\\s+${DET_EN}?(?:\\p{L}+\\s+)?${ANIMAL_EN}(?![\\p{L}])${BYSTANDER_EN}`, 'u'),
  // "a dog fucking her", "the horse penetrates him"
  new RegExp(`(?<![\\p{L}])${ANIMAL_EN}\\s+(?:fuck(?:s|ed|ing)?|rap(?:es|ed|ing)|${PENETRATES_EN}|hump(?:s|ed|ing)? (?:her|him|them|a (?:wom[ae]n|man|girl|guy))|has sex with|having sex with|(?:has|having|had|in) sexual (?:intercourse|relations|activity|contact) with|licks? (?:her|his) (?:pussy|cock|dick|clit|genitals))(?![\\p{L}])`, 'u'),
  // "对着猫儿打飞机", "和狗做爱", "跟马性交", "给狗口交", "被狗操"
  new RegExp(`(?:对着|對著|朝着|朝著|冲着|衝著|和|跟|与|與|同|给|給|让|讓|看着|看著)${ZH_GAP}${ANIMAL_ZH}${ZH_GAP_SHORT}${SEX_ACT_ZH}`, 'u'),
  new RegExp(`${ANIMAL_ZH}${ZH_GAP}(?:操|肏|干|幹|插|奸|姦)(?:她|他|我|你|女人|男人|女孩|男孩|人)`, 'u'),
  new RegExp(`被${ZH_GAP}${ANIMAL_ZH}${ZH_GAP}(?:${ZH_PASSIVE_ACT}|强奸|強姦|${SEX_ACT_ZH_ALT})`, 'u'),
];

/** Sexual content involving an animal (strong terms, or a sexual act directed at an animal); negated terms don't count. */
export function animalSexualSignal(text: string): string[] {
  const t = normalizeText(text);
  const out = findTerms(t, ANIMAL_SEXUAL_TERMS)
    .filter((h) => !h.negated)
    .map((h) => h.term);
  for (const re of ANIMAL_SEXUAL_PATTERNS) {
    const m = re.exec(t);
    if (m && !NEGATION_BEFORE.test(t.slice(Math.max(0, m.index - 40), m.index)) && !NEGATION_CJK_BEFORE.test(t.slice(Math.max(0, m.index - 6), m.index))) out.push(m[0]);
  }
  return out;
}

const NEGATION_BEFORE = /(?<![\p{L}])(?:no|not|non|without|never|avoid|zero|nothing|nor|sin|sans|ohne|keine?n?|без|не|nicht|senza|sem)[\s,-]+(?:[\p{L}]+[\s,-]+)?$/u;
// "不色情", "无任何色情内容", "没有裸露", "不含色情" (checked on the few characters before a CJK term).
// Not the question 要不要 ("do you want to") and not a double negative (不要拒绝, "don't refuse").
const NEGATION_CJK_BEFORE = /(?:(?<![要])[不无無非没沒禁]|没有|沒有|不含|(?<!要)不要|禁止|杜绝|杜絕|(?<![不别別要])拒绝|(?<![不别別要])拒絕)(?:任何|一切|含|带|帶|涉及|包含|出现|出現)?$/u;
// "ヌードなし", "性的な表現なし", "성적인 내용 없음": only these grammatical fillers may sit between the term and the negation.
const NEGATION_CJK_AFTER =
  /^(?:な|的な|인|적인|的)?\s?(?:表現|描写|要素|内容|シーン|コンテンツ|내용|표현|묘사|요소|장면|콘텐츠)?(?:は|も|은|는|이|가|도)?\s?(?:一切|全く|전혀)?\s?(?:なし|無し|禁止|しない|ではない|없는|없이|없음|없다|금지|제외)/u;
// Minor-coded terms are negated only by an explicit absence ("no kids", "without minors", "没有未成年人", "未成年者なし"),
// never by "not" or "nor" ("not a child, a teen", "neither adult nor child" still count).
const MINOR_NEGATION_BEFORE = /(?<![\p{L}])(?:no|without|zero)[\s,-]+(?:(?:other|young|real|actual|underage|little|small)[\s,-]+)?$/u;
const MINOR_NEGATION_CJK_BEFORE = /(?:没有|沒有|无|無|不含|禁止|(?<!要)不要|杜绝|杜絕)(?:任何)?$/u;
const MINOR_NEGATION_CJK_AFTER = /^(?:者|人|자)?(?:は|는|은)?\s?(?:一切|전혀)?\s?(?:なし|無し|禁止|不可|없음|없이|없는|금지|제외|출입 ?금지)/u;

interface Negation {
  before: RegExp;
  cjkBefore: RegExp;
  cjkAfter: RegExp;
}
const SEXUAL_NEGATION: Negation = { before: NEGATION_BEFORE, cjkBefore: NEGATION_CJK_BEFORE, cjkAfter: NEGATION_CJK_AFTER };
const MINOR_NEGATION: Negation = { before: MINOR_NEGATION_BEFORE, cjkBefore: MINOR_NEGATION_CJK_BEFORE, cjkAfter: MINOR_NEGATION_CJK_AFTER };

/**
 * Benign phrases that contain a sexual term but are not sexual ("naked eye",
 * "summa cum laude", "Super Bowl XXX", "sex education", 裸の王様, 淫雨, 성적표,
 * 누드김밥). They are blanked out before the sexual and explicit terms are
 * scanned. Keep each phrase narrow: it must never cover a sexual meaning.
 */
const SEXUAL_MASKS: RegExp[] = [
  /(?<![\p{L}])naked[- ](?:eyes?|flames?|truth|ambition|aggression|greed|lights?|bulbs?|wires?|steel|blades?|trees?|branches|mole[- ]rats?|singularit(?:y|ies)|shorting|short[- ]sell\p{L}*|calls?|puts?)(?![\p{L}-])/gu,
  /(?<![\p{L}])(?:summa |magna )?cum laude(?![\p{L}])/gu,
  /(?<![\p{L}])horny (?:toads?|lizards?)(?![\p{L}])/gu,
  /(?<![\p{L}])thongs? (?:sandals?|flip[- ]flops?|slippers?)(?![\p{L}])/gu,
  /(?<![\p{L}])(?:super ?bowl|wrestlemania|olympiad|chapter|part|volume|vol\.?|book|act|canto|psalm|article|section|track) xxx(?![\p{L}])/gu,
  /(?<![\p{L}])xxx (?:olympiad|olympics|summer olympics|winter olympics)(?![\p{L}])/gu,
  /(?<![\p{L}])sexual (?:reproduction|health|selection|dimorphism)(?![\p{L}])/gu,
  /(?<![\p{L}])sex[- ](?:education|ed|reveal|determination|chromosomes?|ratios?|differences?|linked|hormones?|cells?)(?![\p{L}])/gu,
  // "the baby's sex" needs the possessive: bare "baby sex" is not masked.
  /(?<![\p{L}])(?:(?:baby|fetus|foetus)['’]s|babies['’]|fetal|foetal|(?:chicks?|chickens?|pupp(?:y|ies)|kittens?|foals?|calf|calves)(?:['’]s?)?) sex(?![\p{L}])/gu,
  /(?<![\p{L}])stripping (?:(?:old|the|off|away|down|back|out)\s+)*(?:paint|wallpaper|varnish|wires?|bark|floors?|furniture|beds?|sheets|tape|insulation|screws?|threads?|rust|finish|engines?|cars?|bikes?|lacquer|stain)(?![\p{L}])/gu,
  /(?<![\p{L}])paint[- ]stripping(?![\p{L}])/gu,
  /(?<![\p{L}])(?:aroused|arousing|arouses?) (?:(?:the|their|his|her|our|my|your|great|much|some|public)\s+)?(?:curiosity|interest|suspicions?|attention|anger|fear|sympathy|wonder)(?![\p{L}])/gu,
  /(?<![\p{L}])(?:curiosity|interest|suspicions?|attention|anger|fear|sympathy|wonder) (?:(?:is|was|are|were|has been|have been|got|gets|being)\s+)?(?:aroused|arousing)(?![\p{L}])/gu,
  /(?<![\p{L}])provocative(?:ly)? (?:questions?|topics?|ideas?|debates?|essays?|arguments?|headlines?|titles?|thesis|statements?|opinions?|claims?|comments?|remarks?|books?|novels?|documentar(?:y|ies)|speech(?:es)?|theor(?:y|ies)|hypothes[ie]s|prompts?)(?![\p{L}])/gu,
  /(?<![\p{L}])(?:(?:baby|feeding)[- ])?bottle nipples?(?![\p{L}])/gu,
  /(?<![\p{L}])nipples? (?:shields?|confusion|cream|pain|care|soreness)(?![\p{L}])/gu,
  // Breastfeeding: only with a nursing subject right before "latch" (the subject itself stays visible to the minor scan).
  /(?<=(?<![\p{L}])(?:infants?|bab(?:y|ies)|newborns?) )latch(?:es|ed|ing)? (?:on(?:to)? |onto )?(?:the |a )?(?:(?:mom|mother)['’]s )?(?:breast|nipple)s?(?![\p{L}])/gu,
  // Chinese / Japanese / Korean.
  /裸露(?:的|在外的?)?(?:岩石|礁石|岩层|岩層|土地|土壤|地面|地表|电线|電線|管道|钢筋|鋼筋|砖|磚|山体|山體|树根|樹根|河床|海床|沙滩|沙灘|礁|岩|石头|石頭)/gu,
  /淫雨/gu,
  /性感染(?:症|病|者|率|风险|風險)/gu,
  /裸の(?:王様|大将)/gu,
  /누드 ?(?:김밥|빼빼로|톤|컬러|립)/gu,
  /성적표|성적순|(?:학업|시험|학교|수학|영어|국어|기말|중간) ?성적|(?:좋은|나쁜|우수한|높은|낮은) 성적|성적 ?(?:향상|우수|장학|상승|하락|관리|확인|발표|공개|올리기)|성적(?:이|을|은) ?(?:오르|올라|좋|나쁘|떨어|올리|받|확인)/gu,
];

/**
 * Chinese "-性的" (安全性的, 季节性的, 女性的): the suffix -性 plus 的, not the Japanese 性的 ("sexual").
 * Only after a known -性 compound and only in text without kana, so 女子高生性的 / 儿童性的 still count.
 */
const ZH_XING_DE =
  /(?<=(?:安全|有效|重要|必要|可能|稳定|穩定|季节|季節|历史|歷史|艺术|藝術|科学|科學|专业|專業|互动|互動|趣味|观赏|觀賞|实用|實用|功能|多样|多樣|普遍|典型|阶段|階段|决定|決定|系统|系統|教育|知识|知識|创造|創造|代表|准确|準確|一致|灵活|靈活|耐用|舒适|舒適|透气|透氣|便携|便攜|娱乐|娛樂|戏剧|戲劇|挑战|挑戰|革命|突破|开创|開創|技术|技術|权威|權威|针对|針對|可读|可讀|可玩|适用|適用|合理|合法|真实|真實|完整|连续|連續|持续|持續|周期|週期|国际|國際|地域|民族|全球|结构|結構|根本|原则|原則|战略|戰略|商业|商業|公益|社会|社會|群体|群體|积极|積極|主动|主動|被动|被動|随机|隨機|偶然|必然|先天|后天|後天|弹|彈|韧|韌|个|個|理|感|人|天|习|習|惯|慣|属|屬|特|女|男|中|母|酸|碱|鹼|毒|药|藥|记|記|悟|耐))性的/gu;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Benign phrases that contain a minor-coded term ("minor chord", "kid gloves",
 * "child-free resort", "high school reunion", "a 12-year-old single malt",
 * カロリー, 칼로리, フロリダ). Blanked out before minor terms and ages are scanned.
 */
const MINOR_MASKS: RegExp[] = [
  /(?<![\p{L}])minor[- ](?:chords?|keys?|scales?|leagues?|leaguers?|injur\p{L}*|details?|changes?|roles?|characters?|edits?|adjustments?|issues?|surgery|surgeries|offen[cs]es?|planets?|axis|modes?|thirds?|fix\p{L}*|updates?|bugs?|tweaks?|problems?|damage|cuts?|scratch\p{L}*|bruis\p{L}*|flaws?|differences?|deit(?:y|ies)|arcana|prophets?|parts?|points?|repairs?|setbacks?|errors?|mistakes?|celebrit(?:y|ies)|works?)(?![\p{L}])/gu,
  /(?<![\p{L}])kid[- ](?:gloves?|leather|mohair|skin)(?![\p{L}])/gu,
  // Only the compound ("child-free", "childproof"): "kids free to roam" keeps its minor term.
  /(?<![\p{L}])(?:child|kid)-?(?:free|proof)(?![\p{L}])/gu,
  /(?<![\p{L}])high[- ]school (?:reunions?|alumn\p{L}*)(?![\p{L}])/gu,
  // Only nouns that are neither verbs ("a 15-year-old shops") nor the head of a person compound ("brand ambassador"),
  // and never when a person noun follows ("a 12-year-old scotch drinker").
  /(?<![\p{N}.,])(?:[1-9]|1[0-7])[- ]?(?:year|yr)s?[- ]old (?:single[- ]malts?|scotch|whisk(?:e)?ys?|bourbons?|rums?|cognacs?|brand(?:y|ies)|tawny(?: ports?)?|wines?|malts?|tequilas?|balsamic|vinegars?|cheddars?|cheeses?|oaks?|casks?)(?![\p{L}])(?!\s+(?:drinkers?|lovers?|fans?|enthusiasts?|collectors?|owners?|ambassadors?|assistants?|girls?|boys?|models?|kids?|students?|hostess(?:es)?|hosts?|workers?|interns?|sons?|daughters?)(?![\p{L}]))/gu,
  /(?<![\p{L}])aged (?:[1-9]|1[0-7]) (?:years?|yrs?) in (?:oak|barrels?|casks?|sherry|bourbon)(?![\p{L}])/gu,
  /カロリ|ロリポップ|フロリダ|칼로리|플로리다/gu,
];

function mask(text: string, masks: readonly RegExp[]): string {
  let out = text;
  for (const re of masks) out = out.replace(re, (m) => ' '.repeat(m.length));
  return out;
}

/** True when the text before a "-性的" ends a CJK minor term, alone or plus one character (少女性的, 未成年人性的). */
function afterMinorTerm(before: string): boolean {
  return MINOR_TERMS.substrings.some((s) => before.endsWith(s) || before.slice(0, -1).endsWith(s));
}

function maskSexual(text: string): string {
  const t = mask(text, SEXUAL_MASKS);
  if (KANA.test(t)) return t;
  return t.replace(ZH_XING_DE, (m, offset: number) => (afterMinorTerm(t.slice(0, offset)) ? m : '  '));
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's' };

/** NFKC, lower case, common character substitutions (`s3xy` → `sexy`), whitespace collapsed. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/(?<=\p{L})[0134578@$]+(?=\p{L})|(?<=\p{L}{2})[0134578@$]+(?![\p{L}\p{N}])/gu, (run) => [...run].map((c) => LEET[c] ?? c).join(''))
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TermHit {
  term: string;
  index: number;
  negated: boolean;
}

function findTerms(text: string, list: TermList, negation: Negation = SEXUAL_NEGATION): TermHit[] {
  const hits: TermHit[] = [];
  if (list.words) {
    for (const m of text.matchAll(list.words)) {
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      hits.push({ term: m[0], index: m.index, negated: negation.before.test(before) });
    }
  }
  for (const s of list.substrings) {
    let i = text.indexOf(s);
    while (i !== -1) {
      const before = text.slice(Math.max(0, i - 6), i);
      const after = text.slice(i + s.length, i + s.length + 12);
      hits.push({ term: s, index: i, negated: negation.cjkBefore.test(before) || negation.cjkAfter.test(after) });
      i = text.indexOf(s, i + s.length);
    }
  }
  return hits;
}

/** Minor-coded terms and ages 1–17 that are not negated ("no minors" is not a minor). */
export function minorTerms(text: string): string[] {
  const t = mask(normalizeText(text), MINOR_MASKS);
  const out = findTerms(t, MINOR_TERMS, MINOR_NEGATION)
    .filter((h) => !h.negated)
    .map((h) => h.term);
  for (const re of MINOR_AGE) {
    const m = re.exec(t);
    if (m) out.push(m[0]);
  }
  return out;
}

/** Sexual terms that are not negated. */
export function sexualTerms(text: string): string[] {
  return findTerms(maskSexual(normalizeText(text)), SEXUAL_TERMS)
    .filter((h) => !h.negated)
    .map((h) => h.term);
}

/** Strong explicit terms that are not negated. */
export function explicitSignal(text: string): string[] {
  return findTerms(maskSexual(normalizeText(text)), EXPLICIT_TERMS)
    .filter((h) => !h.negated)
    .map((h) => h.term);
}

function isSwap(model: SafetyModel): boolean {
  return !!model.operations?.some((o) => o === 'face_swap' || o === 'head_swap');
}

/** Identity rule (D-005). */
export function identityRule(input: Pick<PreCheckInput, 'mature' | 'model' | 'references'>): SafetyReason | null {
  const model = input.model;
  if (!input.mature || !model) return null;
  if (isSwap(model)) return { code: 'IDENTITY_SWAP_MATURE', detail: `face/head swap ${model.id} never takes a mature run` };
  if (model.requiresIdentitySafety && input.references.some((r) => r.source === 'upload')) {
    return { code: 'IDENTITY_SWAP_MATURE', detail: `identity-driven ${model.id} with an uploaded reference on a mature run` };
  }
  return null;
}

export interface RulesResult {
  reasons: SafetyReason[];
  /** Strong explicit terms found (MATURE_REQUIRED on non-mature runs is decided by the caller). */
  explicit: string[];
}

/**
 * The deterministic part of preCheck. Scans the prompt and reference captions
 * (not the negative prompt).
 */
export function runRules(input: Pick<PreCheckInput, 'prompt' | 'references' | 'mature' | 'model'>): RulesResult {
  const text = [input.prompt, ...input.references.map((r) => r.caption ?? '')].filter(Boolean).join('\n');
  const reasons: SafetyReason[] = [];
  const minors = minorTerms(text);
  const sexual = sexualTerms(text);
  // On a mature run, any minor-coded term is enough: the run is sexual by intent.
  if (minors.length > 0 && (sexual.length > 0 || input.mature)) {
    reasons.push({ code: 'MINOR_SEXUAL', detail: `rules: minor terms [${minors.slice(0, 3).join(', ')}] with ${sexual.length ? `sexual terms [${sexual.slice(0, 3).join(', ')}]` : 'a mature run'}` });
  }
  const animal = animalSexualSignal(text);
  if (animal.length > 0) reasons.push({ code: 'ANIMAL_SEXUAL', detail: `rules: sexual content involving an animal [${animal.slice(0, 3).join(', ')}]` });
  const identity = identityRule(input);
  if (identity) reasons.push(identity);
  return { reasons, explicit: explicitSignal(text) };
}
