import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Toaster } from "sonner";
// Same reason as the app's main.jsx: Mantine's stylesheet is imported from
// index.css, because the @layer order has to be declared before any of these
// files is seen.
import "../index.css";
import AdminApp from "./AdminApp.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <AdminApp />
      <Toaster position="top-center" richColors closeButton duration={6000} />
    </MantineProvider>
  </StrictMode>,
);
