import React, { useState } from "react";

interface Message {
  user?: string;
  agent?: string;
}

function ChatUI(): JSX.Element {
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const response = `Respuesta de Justino: ${input}`;
    setMessages((prevMessages) => [
      ...prevMessages,
      { user: input },
      { agent: response },
    ]);
    setInput("");
  };

  return (
    <div style={{ maxWidth: "600px", margin: "auto", padding: "20px" }}>
      <h2>Agente Justino 🐶</h2>
      <div
        style={{
          border: "1px solid #ccc",
          padding: "10px",
          minHeight: "200px",
        }}
      >
        {messages.map((msg, i) => (
          <p key={i}>
            {msg.user && <strong>Tú:</strong>} {msg.user}
            {msg.agent && <strong> Justino:</strong>} {msg.agent}
          </p>
        ))}
      </div>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        style={{ width: "80%", marginRight: "10px" }}
      />
      <button onClick={handleSend}>Enviar</button>
    </div>
  );
}

export default ChatUI;
