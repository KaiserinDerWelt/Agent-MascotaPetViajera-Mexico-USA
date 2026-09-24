import { useState } from "react";
import { Button } from "@mui/material";
import { readPDF } from "../lib/pdf";
import { uploadDocs } from "../lib/uploadDocs";

function PDFUploader() {
  const [loading, setLoading] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/pdf") {
      alert("Selecciona un archivo PDF válido");
      return;
    }

    setLoading(true);
    try {
      const text = await readPDF(file);
      await uploadDocs([text]);
      alert("PDF procesado y guardado ✅");
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Error al procesar el PDF";
      alert(message);
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
