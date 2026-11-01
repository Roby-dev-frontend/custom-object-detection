import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Toaster } from "sonner";
// Mantine's stylesheet is imported from index.css instead of here, because the
// @layer order has to be declared before any of these files is seen -- see the
// comment at the top of index.css.
import "./index.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <App />
      {/* Every error message in the app arrives here. It lives outside <App />
          so a toast survives whatever the page is re-rendering underneath it:
          the source switching, the video socket reconnecting, the device list
          refreshing. top-center because on a phone the video fills the screen
          and a message in a corner goes unread. */}
      {/* A card of sonner's own width, BELOW the header -- not the full-width
          banner flush to the top edge that this used to be.

          The banner spanned the whole width at y=0, which is exactly where the
          two burgers live, so while any toast was up neither panel could be
          opened. Width alone does not settle that: at sonner's own 356 px,
          centred on a 390 px phone, the card still reaches from x=17 to x=373
          and the burgers sit at 18-50 and 340-372. Clearing the 48 px header
          vertically is what makes it safe at any width, which is why the offset
          and not just the width had to change.

          Everything else here is sonner's default again: the close button goes
          back to the corner it is designed for, and the toast keeps its own
          radius and inset. */}
      <Toaster
        position="top-center"
        richColors
        closeButton
        duration={6000}
        // Below the 48 px header, with a little air under it.
        offset={56}
        mobileOffset={56}
        // Semibold, for reading at a glance. `!` because sonner's own
        // stylesheet sets the weight outside the cascade layers, where it
        // beats any layered utility.
        toastOptions={{ classNames: { title: "!font-semibold" } }}
      />
    </MantineProvider>
  </StrictMode>,
);
