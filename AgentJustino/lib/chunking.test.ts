// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChunks, prepareDocument, splitTextIntoChunks, usefulText } from "./chunking.ts";

// Real chunks from public.documents (2026-11).
const DISCLAIMER =
  "state=published 2/3 Post Compartir 2  Imprime la página completa La legalidad, veracidad y la calidad de la información es estricta responsabilidad de la dependencia, entidad o empresa productiva del Estado que la proporcionó en virtud de sus atribuciones y/o facultades normativas. (? tab=)  􏊚 9/27/26, 7: 11 PM Si viajas de México a otro país | Servicio Nacional de Sanidad, Inocuidad y Calidad Agroalimentaria | Gobierno | gob. mx https: //www. gob. mx/senasica/documentos/para-viajar-a-otro-pais-125896? state=published 3/3";

const REQUIREMENT =
  "Fecha de aplicación de la vacuna contra la rabia y vigencia de la misma (quedan exentos los animales menores de 3 meses de edad). Que en la inspección previa a su viaje, el o los animales se encontraron clínicamente sanos.";

const REQUIREMENT_WITH_HEADER =
  "tab=)  􏊚 9/27/26, 7: 09 PM Programa Mascota Viajero Frecuente (PMVF) | Servicio Nacional de Sanidad, Inocuidad y Calidad Agroalimentaria | Gobierno | gob. mx https: //www. gob. mx/senasica/documentos/programa-mascota-viajero-frecuente? state=published 2/5 *Para el caso de la vacuna antirrábica y desparasitaciones, estos pueden estar descritos en el Certificado de buena salud o Cartilla de vacunación";

test("usefulText: a page footer (share buttons + legal disclaimer + print header) has no useful text", () => {
  assert.ok(usefulText(DISCLAIMER).length < 80, usefulText(DISCLAIMER));
});

test("usefulText: real requirements are kept intact", () => {
  const text = usefulText(REQUIREMENT);
  assert.ok(text.length >= 80);
  assert.match(text, /menores de 3 meses/);
});

test("usefulText: a requirement survives when it shares the chunk with a print header", () => {
  const text = usefulText(REQUIREMENT_WITH_HEADER);
  assert.ok(text.length >= 80, text);
  assert.match(text, /vacuna antirr[aá]bica/);
  assert.doesNotMatch(text, /PM Programa/);
});

// Shortened real page (as extracted from the printed gob.mx PDF).
const PAGE =
  "Publicaciones Recientes     (http://www.gob.mx)      Servicio Nacional de Sanidad, Inocuidad y Calidad Agroalimentaria   (/senasica)      Documentos  Nuevo   Reanudaremos exportación ganadera de Chihuahua a Estados Unidos   (/senasica/ 2026-09-18  Si viajas a Estados Unidos de América  Consulta los nuevos requisitos para ingresar con tu perro  Servicio Nacional de Sanidad, Inocuidad y Calidad Agroalimentaria | 11 de septiembre de 2026  •   (https://bit.ly/4vPb3iT)   •   (https://bit.ly/4sP6Gla)  (https://bit.ly/4hLV3pX)   (https://bit.ly/DOCInspeccionGB  Para viajar con mascotas a EUA, no requieres tramitar un Certificado Zoosanitario para Exportación.  El certificado tendrá una vigencia de 5 días y debe ser emitido por un   Médico Veterinario Responsable Autorizado (MVRA)   (https://bit.  Dudas al correo:  programa.mascota@senasica.gob.mx  (?tab=)   \u{10f29a}  9/27/26, 7:06 PM   Si viajas a Estados Unidos de América | Servicio Nacional de Sanidad, Inocuidad y Calidad Agroalimentaria | Gobierno | gob.mx  https://www.gob.mx/senasica/documentos/si-viajas-a-estados-unidos-de-america-371288?state=published   1/2 Contesta nuestra encuesta de satisfacción.  ¿Cómo fue tu experiencia en gob.mx?  Post   Compartir   0     Imprime la página completa  La legalidad, veracidad y la calidad de la información es estricta responsabilidad de la dependencia, entidad o empresa productiva del Estado que la proporcionó en virtud de sus atribuciones y/o facultades normativas.";

test("prepareDocument: reads title, date and the page's own URL, and removes the page chrome", () => {
  const doc = prepareDocument(PAGE);
  assert.equal(doc.title, "Si viajas a Estados Unidos de América");
  assert.equal(doc.date, "11 de septiembre de 2026");
  assert.equal(doc.url, "https://www.gob.mx/senasica/documentos/si-viajas-a-estados-unidos-de-america-371288");
  assert.match(doc.text, /^Para viajar con mascotas a EUA/); // the masthead is gone, the first sentence is not
  assert.doesNotMatch(doc.text, /bit\.ly|Publicaciones|encuesta|Compartir|legalidad|PM Si viajas/);
});

test("buildChunks: every chunk is labelled with its page, and emails survive intact", () => {
  const chunks = buildChunks(PAGE);
  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) assert.match(chunk, /^\[Si viajas a Estados Unidos de América · SENASICA, 11 de septiembre de 2026\] /);
  assert.match(chunks.join(" "), /programa\.mascota@senasica\.gob\.mx/);
  assert.match(chunks.join(" "), /vigencia de 5 días/);
});

test("buildChunks: the file name is the label when the document has no page title", () => {
  const [chunk] = buildChunks("Requisito uno para viajar con tu perro a otro país, explicado con suficiente detalle para ser útil al lector.", "Guía CDC 2026.pdf");
  assert.match(chunk, /^\[Guía CDC 2026\] Requisito uno/);
});

test("splitTextIntoChunks: respects the size, overlaps, and never ends a chunk on a heading", () => {
  const sentence = (n: number) => `Esta es la oración número ${n} con información útil sobre requisitos para viajar con perros.`;
  const text = [sentence(1), sentence(2), sentence(3), sentence(4), "Renovación", sentence(5), sentence(6), sentence(7), sentence(8)].join("  ");
  const chunks = splitTextIntoChunks(text, 400, 120);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 400 + 120, `too long: ${chunk.length}`);
    assert.doesNotMatch(chunk, /Renovación$/);
  }
  // overlap: the last sentence of a chunk opens the next one
  const lastOfFirst = chunks[0].split(/(?<=\.)\s+/).pop()!;
  assert.ok(chunks[1].startsWith(lastOfFirst) || chunks[1].includes(lastOfFirst));
});
