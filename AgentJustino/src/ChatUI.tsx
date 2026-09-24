import { useState, type ReactElement } from "react";
import { Box, Typography, TextField, Button, Paper } from "@mui/material";
import senasicaLogo from "./assets/senasica-logo.png";
import { answerQueryFromDocuments } from "../lib/chat";

interface Message {
  user?: string;
  agent?: string;
}

function ChatUI(): ReactElement {
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage = input.trim();
    setMessages((prev) => [...prev, { user: userMessage }]);
    setInput("");

    try {
      const answer = await answerQueryFromDocuments(userMessage);
      setMessages((prev) => [...prev, { agent: answer }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error al consultar el backend.";
      setMessages((prev) => [...prev, { agent: message }]);
    }
  };

  return (
    <Box sx={{ maxWidth: 600, margin: "auto", padding: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", mb: 2 }}>
        <img src={senasicaLogo} alt="SENASICA Logo" style={{ height: 60, marginRight: 16 }} />
        <h2>Agente Justino 🐶</h2><br></br>
      </Box>
      <Box> <p style={{ marginLeft: "auto", fontStyle: "italic" }}>Tu asistente virtual de transporte de perros en SENASICA</p></Box>

      <Paper
        sx={{
          p: 2,
          minHeight: 200,
          maxHeight: 320,
          mb: 2,
          overflowY: "auto",
        }}
      >
        {messages.map((msg, i) => (
          <Typography key={i} sx={{ mb: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {msg.user && <strong>Tú:</strong>} {msg.user}
            {msg.agent && <strong> Justino:</strong>} {msg.agent}
          </Typography>
        ))}
      </Paper>

      <Box sx={{ display: "flex" }}>
        <TextField
          fullWidth
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Escribe tu consulta..."
        />
        <Button variant="contained" color="primary" onClick={handleSend} sx={{ ml: 1 }}>
          Enviar
        </Button>
      </Box>
    </Box>
  );
}

export default ChatUI;
