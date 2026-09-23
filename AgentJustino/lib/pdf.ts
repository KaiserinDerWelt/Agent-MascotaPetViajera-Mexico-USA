import fs from "fs";
import pdfParse from "pdf-parse";

export async function readPDF(path: string): Promise<string> {
  const dataBuffer = fs.readFileSync(path);
  const pdfData = await pdfParse(dataBuffer);
  return pdfData.text;
}

