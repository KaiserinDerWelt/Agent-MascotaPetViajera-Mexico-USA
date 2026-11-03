import { useState, type ReactElement } from "react";
import { Box, Typography, TextField, Button, Paper } from "@mui/material";
import senasicaLogo from "./assets/senasica-logo.png";
import { answerQueryWithMetadata, type AnswerSource } from "../lib/chat";
import type { HistoryTurn } from "../lib/scope";

interface Message {
  user?: string;
  agent?: string;
  source?: AnswerSource;
  outOfScope?: boolean;
}

const SOURCE_LABELS: Record<AnswerSource, { text: string; color: string } | null> = {
  model: { text: "Respuesta generada con modelo", color: "#0f766e" },
  evidence: { text: "Respuesta basada en evidencia (modelo no disponible)", color: "#8a5b00" },
  guardrail: null,
  error: { text: "Servicio no disponible", color: "#b91c1c" },
};

/** Last turns of the conversation, so Justino understands follow-up questions. */
function toHistory(messages: Message[]): HistoryTurn[] {
  return messages
    .filter((msg) => msg.source !== "error")
    .slice(-6)
    .map((msg): HistoryTurn => (msg.user ? { role: "user", content: msg.user } : { role: "assistant", content: msg.agent ?? "" }));
}

function ChatUI(): ReactElement {
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    const history = toHistory(messages);
    setMessages((prev) => [...prev, { user: userMessage }]);
    setInput("");
    setLoading(true);

    try {
      const result = await answerQueryWithMetadata(userMessage, history);
      setMessages((prev) => [
        ...prev,
        { agent: result.answer, source: result.source, outOfScope: result.scope.kind === "out_of_scope" },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error al consultar a Justino.";
      setMessages((prev) => [...prev, { agent: message, source: "error" }]);
    } finally {
      setLoading(false);
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
                {!isUser && msg.source && (() => {
                  const label = msg.outOfScope
                    ? { text: "Fuera del alcance de Justino", color: "#6b7280" }
                    : SOURCE_LABELS[msg.source];
                  return label ? (
                    <Typography
                      variant="caption"
                      sx={{ display: "block", mt: 0.75, fontSize: 11, opacity: 0.8, color: label.color }}
                    >
                      {label.text}
                    </Typography>
                  ) : null;
                })()}
              </Box>
            </Box>
          );
        })}
        {loading && (
          <Typography variant="body2" sx={{ fontStyle: "italic", opacity: 0.7 }}>
            Justino está olfateando la respuesta… 🐾
          </Typography>
        )}
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
        <Button variant="contained" color="primary" onClick={() => void handleSend()} disabled={loading} sx={{ ml: 1 }}>
          Enviar
        </Button>
      </Box>
    </Box>
  );
}

export default ChatUI;
