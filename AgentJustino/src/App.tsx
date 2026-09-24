import { Box, Divider } from "@mui/material";
import PDFUploader from "./PDFUploader";
import ChatUI from "./ChatUI";

function MainPage() {
  return (
    <Box sx={{ maxWidth: 800, margin: "auto", padding: 3 }}>
      {/* Sección de carga de PDFs */}
      <PDFUploader />

      <Divider sx={{ my: 4 }} />

      {/* Sección de chat con Justino */}
      <ChatUI />
    </Box>
  );
}

export default MainPage;
