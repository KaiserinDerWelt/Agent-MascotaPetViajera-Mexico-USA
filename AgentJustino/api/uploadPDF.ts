import { NextApiRequest, NextApiResponse } from "next";
import formidable, { type File } from "formidable";
import fs from "node:fs";
import { PDFParse } from "pdf-parse";
import { uploadDocs } from "../lib/uploadDocs";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  const form = formidable({ multiples: false });
  form.parse(req, (err, fields, files) => {
    if (err) {
      return res.status(500).json({ error: "Error al subir archivo" });
    }

    (async () => {
      try {
        const uploadedFile: File | File[] | undefined = files["file"] as File | File[] | undefined;
        const file = Array.isArray(uploadedFile) ? uploadedFile[0] : uploadedFile;

        if (!file) {
          return res.status(400).json({ error: "No se recibió archivo" });
        }

        const dataBuffer = fs.readFileSync(file.filepath);
        const pdfData = await new PDFParse({ data: dataBuffer }).getText();

        await uploadDocs([pdfData.text]);

        res.status(200).json({ message: "PDF procesado y guardado ✅" });
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al procesar el PDF" });
      }
    })();
  });
}
