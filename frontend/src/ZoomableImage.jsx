// A picture that can be zoomed (pinch, mouse wheel) and moved (drag), and that
// goes back to its size on a double click or double tap. Whatever is inside --
// an Image, boxes drawn over it -- zooms together.
//
// The behaviour is react-zoom-pan-pinch's; Mantine has nothing that zooms.

import { Text } from "@mantine/core";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";

export default function ZoomableImage({ children }) {
  return (
    <div>
      <TransformWrapper
        minScale={1}
        maxScale={8}
        doubleClick={{ mode: "reset" }}
        // With the library's smoothing on, one wheel notch (deltaY 100) adds
        // step x 100 to the scale: 0.003 is +0.3 a notch, the same every time.
        // (0.2 here made a single notch jump to the maximum.)
        wheel={{ step: 0.003 }}
      >
        <TransformComponent
          wrapperStyle={{ width: "100%", borderRadius: "var(--mantine-radius-sm)" }}
          contentStyle={{ width: "100%" }}
        >
          {children}
        </TransformComponent>
      </TransformWrapper>
      <Text size="xs" c="dimmed" mt={4}>
        Pizzica o usa la rotella per ingrandire; doppio tocco per tornare.
      </Text>
    </div>
  );
}
