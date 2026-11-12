import { Box, Divider } from "@mui/material";
import PDFUploader from "./PDFUploader";
import ChatUI from "./ChatUI";

// The uploader writes straight into Supabase with the public anon key, so it is only shown
// locally (npm run dev) unless VITE_ENABLE_PDF_UPLOAD=true is set explicitly.
const showUploader = import.meta.env.DEV || import.meta.env.VITE_ENABLE_PDF_UPLOAD === "true";

function MainPage() {
  return (
    <Box sx={{ maxWidth: 800, margin: "auto", padding: 3 }}>
      {/* Sección de carga de PDFs */}
      {showUploader && <PDFUploader />}

      <Divider sx={{ my: 4 }} />

      {/* Sección de chat con Justino */}
      <ChatUI />
    </Box>
  );
}

export default MainPage;
