import React, { useState } from "react";

function ChatUI() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ user?: string; agent?: string }>>([]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const response = `Respuesta de Justino: ${input}`;
    setMessages((prevMessages) => [...prevMessages, { user: input }, { agent: response }]);
    setInput("");
  };

  return React.createElement(
    "div",
    { style: { maxWidth: "600px", margin: "auto", padding: "20px" } },
    React.createElement("h2", null, "Agente Justino 🐶"),
    React.createElement(
      "div",
      { style: { border: "1px solid #ccc", padding: "10px", minHeight: "200px" } },
      messages.map((msg, i) =>
        React.createElement(
          "p",
          { key: i },
          msg.user ? React.createElement("strong", null, "Tú:") : null,
          msg.user ? " " : null,
          msg.user,
          msg.agent ? React.createElement("strong", null, " Justino:") : null,
          msg.agent ? " " : null,
          msg.agent
        )
      )
    ),
    React.createElement("input", {
      type: "text",
      value: input,
      onChange: (e) => setInput(e.target.value),
      style: { width: "80%", marginRight: "10px" }
    }),
    React.createElement("button", { onClick: handleSend }, "Enviar")
  );
}

export default ChatUI;
