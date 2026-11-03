// Run with: npm test   (Node 22.6+ runs TypeScript directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyQuery, scopeReply, SCOPE_REPLIES, type HistoryTurn } from "./scope.ts";
import { buildChatMessages, SYSTEM_PROMPT } from "./prompt.ts";

const inScope = [
  "¿Qué necesito para llevar a mi perro de México a Estados Unidos?",
  "Voy a viajar con mi perrita a USA en avión, ¿qué documentos piden?",
  "¿Mi perro necesita la vacuna de la rabia para cruzar la frontera?",
  "Requisitos de SENASICA para importar un perro a México desde Texas",
  "¿Qué certificado pide SENASICA para regresar a México?",
  "Can I fly with my dog from the US to Mexico?",
  "Me voy a mudar a Estados Unidos con mi mascota, ¿qué trámites hago?",
  "¿Cuánto tiempo antes debe vacunarse mi cachorro para viajar a EEUU?",
];

const greetings = ["Hola", "hola!", "Buenos días", "Hola Justino", "¿Qué puedes hacer?", "Hi"];

const otherAnimals = [
  "¿Qué necesito para viajar con mi gato a Estados Unidos?",
  "Requisitos para llevar un perico de México a USA",
];

const otherCountries = [
  "¿Qué necesito para llevar a mi perro a Canadá?",
  "Quiero viajar a España con mi perrito",
];

const offTopic = [
  "¿Cuál es la capital de Francia?",
  "Dame una receta de pastel de chocolate",
  "¿Qué documentos necesito para viajar a Estados Unidos?", // no pet mentioned: visa-type question
  "Escríbeme un poema",
];

test("dog travel questions between Mexico and the USA are in scope", () => {
  for (const question of inScope) {
    assert.equal(classifyQuery(question).kind, "in_scope", question);
  }
});

test("greetings get the intro reply without calling any model", () => {
  for (const question of greetings) {
    const decision = classifyQuery(question);
    assert.equal(decision.kind, "greeting", question);
    assert.equal(scopeReply(decision), SCOPE_REPLIES.greeting);
  }
  assert.equal(classifyQuery("Muchas gracias").kind, "thanks");
});

test("other species are out of scope", () => {
  for (const question of otherAnimals) {
    assert.deepEqual(classifyQuery(question), { kind: "out_of_scope", reason: "other_animal" }, question);
  }
  // A question that also covers dogs stays in scope.
  assert.equal(classifyQuery("Viajo a USA con mi perro y mi gato, ¿qué piden para el perro?").kind, "in_scope");
});

test("other destinations are out of scope", () => {
  for (const question of otherCountries) {
    assert.deepEqual(classifyQuery(question), { kind: "out_of_scope", reason: "other_destination" }, question);
  }
});

test("unrelated questions are out of scope", () => {
  for (const question of offTopic) {
    assert.deepEqual(classifyQuery(question), { kind: "out_of_scope", reason: "off_topic" }, question);
  }
});

test("follow-ups inherit scope from the conversation", () => {
  const history: HistoryTurn[] = [
    { role: "user", content: "¿Qué necesito para llevar a mi perro de México a Estados Unidos?" },
    { role: "assistant", content: "Necesitas el certificado de vacunación antirrábica vigente..." },
  ];

  assert.deepEqual(classifyQuery("¿Y cuánto tiempo antes debo ponerle la vacuna?", history), { kind: "in_scope", followUp: true });
  assert.deepEqual(classifyQuery("¿cuánto cuesta?", history), { kind: "in_scope", followUp: true });
  // Without history the same short question is off-topic.
  assert.equal(classifyQuery("¿cuánto cuesta?").kind, "out_of_scope");
  // Changing to an off-topic subject is still rejected.
  assert.equal(classifyQuery("Dame una receta de pastel de chocolate", history).kind, "out_of_scope");
});

test("prompt keeps system rules first and context only in the last user turn", () => {
  const history: HistoryTurn[] = [
    { role: "user", content: "¿Qué piden para llevar a mi perro a USA?" },
    { role: "assistant", content: "Principalmente la vacuna antirrábica vigente." },
  ];
  const messages = buildChatMessages("[1] Texto de SENASICA", "¿Y el microchip?", history);

  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, SYSTEM_PROMPT);
  assert.equal(messages.length, 4);
  assert.equal(messages.at(-1)?.role, "user");
  assert.match(messages.at(-1)?.content ?? "", /Información de referencia:\n\[1\] Texto de SENASICA\n\nPregunta: ¿Y el microchip\?/);
  assert.match(SYSTEM_PROMPT, /México.*Estados Unidos/);
});
