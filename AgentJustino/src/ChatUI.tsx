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

  const handleSend = () => {
    if (!input.trim()) return;
    const response = `Respuesta de Justino: ${input}`;
    setMessages([...messages, { user: input }, { agent: response }]);
    setInput("");
  };

  return (
    <Box sx={{ maxWidth: 600, margin: "auto", padding: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", mb: 2 }}>
        <img src={senasicaLogo} alt="SENASICA Logo" style={{ height: 60, marginRight: 16 }} />
        <Typography variant="h2">Agente Justino 🐶</Typography>
      </Box>

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
