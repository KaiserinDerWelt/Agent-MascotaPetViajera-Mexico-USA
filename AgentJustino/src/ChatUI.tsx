import { useState, type ReactElement } from "react";
import { Box, Typography, TextField, Button, Paper } from "@mui/material";
import senasicaLogo from "./assets/senasica-logo.png";
import { answerQueryWithMetadata } from "../lib/chat";

interface Message {
  user?: string;
  agent?: string;
  source?: "model" | "evidence";
  fallback?: boolean;
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
      const result = await answerQueryWithMetadata(userMessage);
      setMessages((prev) => [...prev, { agent: result.answer, source: result.source, fallback: result.fallback }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error al consultar el backend.";
      setMessages((prev) => [...prev, { agent: message, source: "evidence", fallback: true }]);
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
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
        }}
      >
        {messages.map((msg, i) => {
          const isUser = Boolean(msg.user);
          const text = msg.user ?? msg.agent ?? "";

          return (
            <Box
              key={i}
              sx={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
              }}
            >
              <Box
                sx={{
                  maxWidth: "80%",
                  px: 2,
                  py: 1.25,
                  borderRadius: 3,
                  backgroundColor: isUser ? "#006837" : "#E9F5EE",
                  color: isUser ? "#fff" : "#1F2937",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5, opacity: isUser ? 0.9 : 1 }}>
                  {isUser ? "Tú" : "Justino"}
                </Typography>
                <Typography variant="body2" sx={{ lineHeight: 1.5 }}>
                  {text}
                </Typography>
                {!isUser && msg.source && (
                  <Typography
                    variant="caption"
                    sx={{
                      display: "block",
                      mt: 0.75,
                      fontSize: 11,
                      opacity: 0.8,
                      color: msg.fallback ? "#8a5b00" : "#0f766e",
                    }}
                  >
                    {msg.fallback ? "Respuesta basada en evidencia (modelo no disponible)" : "Respuesta generada con modelo"}
                  </Typography>
                )}
              </Box>
            </Box>
          );
        })}
      </Paper>

      <Box sx={{ display: "flex" }}>
        <TextField
          fullWidth
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder="Escribe tu consulta..."
        />
        <Button variant="contained" color="primary" onClick={() => void handleSend()} sx={{ ml: 1 }}>
          Enviar
        </Button>
      </Box>
    </Box>
  );
}

export default ChatUI;
