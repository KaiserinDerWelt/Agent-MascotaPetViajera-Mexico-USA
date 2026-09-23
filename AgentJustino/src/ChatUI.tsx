import { useState, type ReactElement } from "react";
import { Box, Typography, TextField, Button, Paper } from "@mui/material";
import senasicaLogo from "./assets/senasica-logo.png";


interface Message {
  user?: string;
  agent?: string;
}

function ChatUI(): ReactElement {
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);

  const handleSend = async () => {
  if (!input.trim()) return;

  // Guardar mensaje del usuario
  setMessages((prev) => [...prev, { user: input }]);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: input }),
    });

    const data = await res.json();

    // Guardar respuesta del agente
    setMessages((prev) => [...prev, { agent: data.answer }]);
  } catch {
    setMessages((prev) => [...prev, { agent: "Error al consultar el backend." }]);
  }

  setInput("");
};


  return (
    <Box sx={{ maxWidth: 600, margin: "auto", padding: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", mb: 2 }}>
        <img src={senasicaLogo} alt="SENASICA Logo" style={{ height: 60, marginRight: 16 }} />
        <h2>Agente Justino 🐶</h2><br></br>
      </Box>
      <Box> <p style={{ marginLeft: "auto", fontStyle: "italic" }}>Tu asistente virtual de transporte de perros en SENASICA</p></Box>

      <Paper sx={{ p: 2, minHeight: 200, mb: 2 }}>
        {messages.map((msg, i) => (
          <Typography key={i} sx={{ mb: 1 }}>
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
