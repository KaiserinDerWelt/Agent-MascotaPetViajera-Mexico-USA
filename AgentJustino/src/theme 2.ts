import { createTheme } from "@mui/material/styles";

const theme = createTheme({
  palette: {
    primary: {
      main: "#006837", // Verde SENASICA
    },
    secondary: {
      main: "#FFD700", // Amarillo maíz
    },
    error: {
      main: "#B22222", // Rojo carne
    },
    info: {
      main: "#005AA7", // Azul acuícola
    },
    background: {
      default: "#F5F5F5",
    },
  },
  typography: {
    fontFamily: "Roboto, Arial, sans-serif",
    h2: {
      fontWeight: 700,
      color: "#006837",
    },
  },
});

export default theme;
