import { useState } from "react";
import { Button } from "@mui/material";
import { readPDF } from "../lib/pdf";
import { uploadDocs } from "../lib/uploadDocs";

function PDFUploader() {
  const [loading, setLoading] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    try {
      // Leer PDF y convertirlo en texto
      const text = await readPDF(file);

      // Subir a Supabase con embeddings
      await uploadDocs([text]);

      alert("PDF cargado en Supabase ✅");
    } catch (err) {
      alert("Error al procesar el PDF");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <input
        type="file"
        accept="application/pdf"
        onChange={handleFileChange}
        style={{ display: "none" }}
        id="pdf-input"
      />
      <label htmlFor="pdf-input">
        <Button variant="contained" component="span" disabled={loading}>
          {loading ? "Cargando..." : "Subir PDF"}
        </Button>
      </label>
    </div>
  );
}

export default PDFUploader;
