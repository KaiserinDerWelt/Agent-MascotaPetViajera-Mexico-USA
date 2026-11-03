// Operational scope guard for Justino.
// Justino only answers questions about traveling with DOGS between MEXICO and the USA.
// This runs before any Hugging Face call, so greetings and off-topic questions cost no credits.
// Pure module (no imports) so it can be unit-tested with `node --test`.

export type ScopeKind = "greeting" | "thanks" | "in_scope" | "out_of_scope";
export type OutOfScopeReason = "other_animal" | "other_destination" | "off_topic";

export type ScopeDecision = {
  kind: ScopeKind;
  reason?: OutOfScopeReason;
  /** True when the question only makes sense together with an earlier in-scope question. */
  followUp?: boolean;
};

export type HistoryTurn = { role: "user" | "assistant"; content: string };

export const SCOPE_REPLIES = {
  greeting:
    "¡Guau, hola! 🐶 Soy Justino, un perrito que viajó muchas veces entre México y Estados Unidos. Te ayudo a que tu peludo viaje sin sustos: documentos, vacuna antirrábica, revisión en el aeropuerto o la frontera y trámites con SENASICA. Cuéntame, ¿tu perrito va de México a Estados Unidos o de Estados Unidos a México?",
  thanks:
    "¡De nada! Aquí te espero moviendo la cola 🐾. Si te surge otra duda sobre el viaje de tu perrito entre México y Estados Unidos, pregúntame.",
  other_animal:
    "¡Ay, ahí mi olfato no llega! 🐾 Yo solo conozco las reglas para perritos que viajan entre México y Estados Unidos. Para otras especies, lo mejor es consultar directamente a SENASICA.",
  other_destination:
    "¡Uy, ese viaje no lo conozco! 🐾 Yo solo me sé el camino entre México y Estados Unidos con perritos. Para otros países, consulta a SENASICA y a la autoridad sanitaria del país de destino.",
  off_topic:
    "¡Guau, eso se sale de mi jardín! 🐶 Yo solo sé de viajes con perritos entre México y Estados Unidos: requisitos, documentos, vacunas y trámites con SENASICA. ¿Tienes alguna duda sobre eso?",
} as const;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

// Patterns run on normalized text (lowercase, no accents, no punctuation).
const DOG = [
  /\b(perr[oa]s?|perrit[oa]s?|perrhij[oa]s?|cachorr[oa]s?|can(es)?|canin[oa]s?|lomito?s?|firulais)\b/,
  /\b(dogs?|pupp(y|ies)|canines?)\b/,
  /\b(mascotas?|pets?)\b/, // generic pet: accepted, the agent then answers for dogs
];

const OTHER_ANIMAL = [
  /\b(gat[oa]s?|gatit[oa]s?|felin[oa]s?|cats?|kittens?)\b/,
  /\b(aves?|pajar[oa]s?|loros?|pericos?|birds?|parrots?)\b/,
  /\b(conej[oa]s?|rabbits?|hurone?s?|ferrets?|hamsters?|cuyos?|tortugas?|turtles?|peces|pez|fish|reptiles?|serpientes?|snakes?|caball[oa]s?|horses?)\b/,
];

const MX_US = [
  /\b(mexico|mex|mx|cdmx|guadalajara|monterrey|cancun|tijuana)\b/,
  /\b(usa|eeuu|ee uu|eua|estados unidos|united states|us|u s|gringolandia|texas|california|arizona|florida|nueva york|new york|los angeles|chicago|houston)\b/,
];

const OTHER_COUNTRY = [
  /\b(canada|espana|spain|europa|europe|union europea|francia|france|alemania|germany|italia|italy|reino unido|inglaterra|uk|japon|japan|china|corea|korea|australia)\b/,
  /\b(guatemala|belice|belize|el salvador|honduras|nicaragua|costa rica|panama|cuba|colombia|venezuela|ecuador|peru|brasil|brazil|argentina|chile|uruguay|paraguay|bolivia|republica dominicana)\b/,
];

const TRAVEL = [
  /\b(viaj\w*|travel\w*|trip|vuel\w*|volar|fly\w*|flight\w*|avion\w*|aerolinea\w*|airline\w*|aeropuerto\w*|airport\w*)\b/,
  /\b(cruz\w*|cross\w*|frontera\w*|border\w*|garita\w*|aduana\w*|customs|transport\w*|llev\w*|mud\w*|regres\w*|entrar|entrada|salir|salida|ingres\w*)\b/,
  /\b(import\w*|export\w*)\b/,
];

// Terms specific enough to the animal-health / pet-travel domain on their own.
const ANIMAL_HEALTH = [
  /\b(senasica|usda|aphis|cdc|oisa|cza|certificado zoosanitario|zoosanitari\w*)\b/,
  /\b(rabia|antirrabic\w*|rabies|microchip\w*|desparasit\w*|deworm\w*|cartilla de vacunacion|certificado de salud|health certificate|cuarentena|quarantine)\b/,
];

// Generic paperwork words: only count when a dog/pet is mentioned ("documentos para viajar a USA" may be a visa question).
const PAPERWORK = [
  /\b(requisit\w*|tramit\w*|documentos?|permisos?|certificad\w*|vacun\w*|vaccin\w*|requirements?|paperwork)\b/,
];

const GREETING = /^(hola+|holi|buen[oa]s?( dias| tardes| noches)?|que tal|hey|hi|hello|saludos|buen dia)( justino)?$/;
const CAPABILITIES = /^(quien eres|que eres|que haces|que puedes hacer|en que me (puedes )?ayudar|ayuda|help|como funcionas|what can you do|who are you)( justino)?$/;
const THANKS = /^(muchas )?(gracias|grax|thank you|thanks|ok gracias|perfecto gracias|genial gracias)( justino)?$/;

/** Short, vague questions that only make sense as a continuation ("¿y cuánto cuesta?"). */
const FOLLOW_UP = /^(y |e |tambien |and |what about |entonces |ok |vale |pero )|\b(eso|esto|ese|esa|ahi|alli|lo mismo|that|this|it)\b/;
const FOLLOW_UP_QUESTION = /\b(cuanto|cuantos|cuantas|cuando|donde|cual|cuales|que mas|costo|cuesta|precio|cobran|tarda|dias|horas|tiempo|vigencia|vigente|edad|meses|necesito|piden|debo|hay que|how much|how long|when|where|which|cost)\b/;

function isDogTravelQuestion(text: string): boolean {
  const dog = hasAny(text, DOG);
  const travel = hasAny(text, TRAVEL);
  const mxUs = hasAny(text, MX_US);
  const animalHealth = hasAny(text, ANIMAL_HEALTH);
  const paperwork = hasAny(text, PAPERWORK);

  if (dog && (travel || mxUs || animalHealth || paperwork)) return true;
  // "¿Qué certificado pide SENASICA para cruzar a USA?" - animal-health term + travel/country, pet implied.
  if (animalHealth && (travel || mxUs)) return true;
  return false;
}

/** Looks like a pet/travel question at all (used to tell "other destination" from plain off-topic). */
function isTravelOrPetRelated(text: string): boolean {
  return hasAny(text, DOG) || hasAny(text, TRAVEL) || hasAny(text, ANIMAL_HEALTH);
}

export function classifyQuery(query: string, history: HistoryTurn[] = []): ScopeDecision {
  const text = normalize(query);

  if (!text) return { kind: "out_of_scope", reason: "off_topic" };
  if (GREETING.test(text) || CAPABILITIES.test(text)) return { kind: "greeting" };
  if (THANKS.test(text)) return { kind: "thanks" };

  const mentionsDog = hasAny(text, DOG.slice(0, 2)); // explicit dog words, not generic "mascota"
  const mentionsOtherAnimal = hasAny(text, OTHER_ANIMAL);
  const mentionsOtherCountry = hasAny(text, OTHER_COUNTRY);
  const mentionsMxUs = hasAny(text, MX_US);

  // Explicit out-of-scope signals win, unless the question also clearly covers the in-scope case.
  if (mentionsOtherAnimal && !mentionsDog) return { kind: "out_of_scope", reason: "other_animal" };
  if (mentionsOtherCountry && !mentionsMxUs && isTravelOrPetRelated(text)) {
    return { kind: "out_of_scope", reason: "other_destination" };
  }

  if (isDogTravelQuestion(text)) return { kind: "in_scope" };

  // Follow-up questions inherit the scope of the conversation (last 3 user turns).
  const recentUserTurns = history.filter((turn) => turn.role === "user").slice(-3);
  const conversationInScope = recentUserTurns.some((turn) => isDogTravelQuestion(normalize(turn.content)));
  const looksLikeFollowUp =
    FOLLOW_UP.test(text) || (text.split(" ").length <= 8 && FOLLOW_UP_QUESTION.test(text));
  if (conversationInScope && looksLikeFollowUp) return { kind: "in_scope", followUp: true };

  return { kind: "out_of_scope", reason: "off_topic" };
}

export function scopeReply(decision: ScopeDecision): string | null {
  if (decision.kind === "greeting") return SCOPE_REPLIES.greeting;
  if (decision.kind === "thanks") return SCOPE_REPLIES.thanks;
  if (decision.kind === "out_of_scope") return SCOPE_REPLIES[decision.reason ?? "off_topic"];
  return null;
}
